// @vitest-environment node
import { afterEach, beforeAll, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { Window } from 'happy-dom'
import { matchesToolUrl } from '@creatorweave/shared/webmcp-url'
import type { BrowserRequest } from '../../../browser-extension/lib/bash-commands/browser/command'
import { parseWorkflow, validatePackage } from '@creatorweave/shared/webmcp-adapter'
import type { JsonValue } from '@creatorweave/quickjs-runtime'
import { builtinResources } from '../../../browser-extension/entrypoints/webmcp/builtin-resources'
import { executeAdapterWorkflow } from '../../../browser-extension/entrypoints/webmcp/adapter-runtime'
const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../browser-extension/builtin-webmcp'
)
const paths = Object.keys(builtinResources)
let wasm: WebAssembly.Module
beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const runtimeRequire = createRequire(
    require.resolve('@creatorweave/quickjs-runtime/package.json')
  )
  wasm = await WebAssembly.compile(
    await readFile(runtimeRequire.resolve('quickjs-wasi/quickjs.wasm'))
  )
})

it('bundles every package file as unchanged raw text', async () => {
  const files = await readdir(root, { recursive: true, withFileTypes: true })
  const sources = files
    .filter((file) => file.isFile() && !file.name.startsWith('.'))
    .map((file) => resolve(file.parentPath, file.name).slice(root.length + 1))
  expect(paths.some((path) => path.includes('/readers/'))).toBe(false)
  expect(paths.sort()).toEqual(sources.sort())
  for (const path of paths) {
    expect(builtinResources[path]).toBe(await readFile(resolve(root, path), 'utf8'))
  }
})

const schemaMapKeywords = ['properties', 'patternProperties', 'definitions', '$defs'] as const
const schemaArrayKeywords = ['allOf', 'anyOf', 'oneOf'] as const
const schemaValueKeywords = ['contains', 'propertyNames', 'not', 'if', 'then', 'else'] as const

function assertStrictOutputSchema(schema: unknown, path = 'outputSchema'): void {
  if (typeof schema === 'boolean') throw new Error(`${path} must not be a boolean schema`)
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema))
    throw new Error(`${path} must be a JSON Schema object`)

  const object = schema as Record<string, unknown>
  if (object.additionalProperties === true)
    throw new Error(`${path}.additionalProperties must not be true`)
  if (Object.keys(object).length === 0)
    throw new Error(`${path} must not be an empty schema`)

  for (const keyword of schemaMapKeywords) {
    const entries = object[keyword]
    if (entries === undefined) continue
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries))
      throw new Error(`${path}.${keyword} must be a schema map`)
    for (const [name, child] of Object.entries(entries))
      assertStrictOutputSchema(child, `${path}.${keyword}.${name}`)
  }

  for (const keyword of schemaArrayKeywords) {
    const children = object[keyword]
    if (children === undefined) continue
    if (!Array.isArray(children)) throw new Error(`${path}.${keyword} must be a schema array`)
    children.forEach((child, index) =>
      assertStrictOutputSchema(child, `${path}.${keyword}[${index}]`)
    )
  }

  if (Array.isArray(object.items)) {
    object.items.forEach((child, index) =>
      assertStrictOutputSchema(child, `${path}.items[${index}]`)
    )
  } else if (object.items !== undefined) {
    assertStrictOutputSchema(object.items, `${path}.items`)
  }

  for (const keyword of schemaValueKeywords) {
    if (object[keyword] !== undefined)
      assertStrictOutputSchema(object[keyword], `${path}.${keyword}`)
  }

  if (object.additionalProperties !== undefined && object.additionalProperties !== false)
    assertStrictOutputSchema(object.additionalProperties, `${path}.additionalProperties`)
}

it('validates all 48 bundled workflow contracts without claiming browser behavior', async () => {
  let count = 0
  for (const path of paths.filter((path) => path.endsWith('manifest.json'))) {
    const manifest = JSON.parse(builtinResources[path])
    const sources: Record<string, string> = {}
    for (const tool of manifest.tools) {
      const source = builtinResources[`${manifest.id}/${tool.path}`]
      expect(source).not.toMatch(/tools\.page_/)
      expect(source).not.toContain('location.assign(')
      expect(source).not.toMatch(
        /\btools\.bash\b|packageRoot|\boutput\.(?:stdout|stderr|exitCode|truncated)\b/
      )
      expect(source).toContain('browser.')
      const outputSchema = parseWorkflow(source).contract.outputSchema
      expect(typeof outputSchema, `${manifest.id}.${tool.name} outputSchema`).toBe('object')
      expect(outputSchema, `${manifest.id}.${tool.name} outputSchema`).not.toBeNull()
      expect(Array.isArray(outputSchema), `${manifest.id}.${tool.name} outputSchema`).toBe(false)
      const strictSchema = outputSchema as Record<string, unknown>
      assertStrictOutputSchema(strictSchema, `${manifest.id}.${tool.name}.outputSchema`)
      expect(strictSchema.type, `${manifest.id}.${tool.name} outputSchema.type`).toBe('object')
      expect(
        strictSchema.properties,
        `${manifest.id}.${tool.name} outputSchema.properties`
      ).toBeTypeOf('object')
      expect(
        Object.keys(strictSchema.properties as object).length,
        `${manifest.id}.${tool.name} outputSchema.properties`
      ).toBeGreaterThan(0)
      expect(
        Array.isArray(strictSchema.required),
        `${manifest.id}.${tool.name} outputSchema.required`
      ).toBe(true)
      expect(
        strictSchema.additionalProperties,
        `${manifest.id}.${tool.name} outputSchema.additionalProperties`
      ).toBe(false)
      sources[tool.path] = source
      count++
    }
    expect(() => validatePackage(manifest, sources, manifest.id)).not.toThrow()
  }
  expect(count).toBe(48)
})

const restoreFixtures: Array<() => void> = []
afterEach(() => {
  restoreFixtures
    .splice(0)
    .reverse()
    .forEach((restore) => restore())
})
function overrideFixture(object: object, key: string, descriptor: PropertyDescriptor) {
  const original = Object.getOwnPropertyDescriptor(object, key)
  Object.defineProperty(object, key, { ...descriptor, configurable: true })
  restoreFixtures.push(() => {
    if (original) Object.defineProperty(object, key, original)
    else Reflect.deleteProperty(object, key)
  })
}

/** Real QuickJS invocations compose the registered builtins; only browser I/O is simulated. */
function fixture(url: string, html: string) {
  const window = new Window({ url })
  window.document.write(html)
  Object.defineProperty(window.document, 'readyState', { configurable: true, value: 'complete' })
  overrideFixture(window.HTMLElement.prototype, 'getClientRects', { value: () => [{}] })
  overrideFixture(window.HTMLElement.prototype, 'offsetParent', {
    get() {
      return window.document.body
    },
  })
  overrideFixture(window.HTMLElement.prototype, 'getBoundingClientRect', {
    value: () => ({ top: 0, bottom: 100, height: 100 }),
  })
  const hydrate = () => {
    for (const element of window.document.querySelectorAll('input, button, a, .email-row'))
      Object.assign(element, { __reactProps$test: {} })
  }
  hydrate()
  let searchClock = 0
  const searchResponses: object[] = []
  const performance = { now: () => ++searchClock, getEntriesByType: () => searchResponses }
  const completeSearch = (query: string) => searchResponses.push({
    name: `https://jmail.world/api/imessage/search?q=${encodeURIComponent(query)}`,
    initiatorType: 'fetch', responseStatus: 200,
    startTime: ++searchClock, responseEnd: ++searchClock,
  })
  const requests: BrowserRequest[] = []
  const names = new Map<string, { name: string; path: string; urlRegex: string; source: string }>(
    paths
      .filter((path) => path.endsWith('manifest.json'))
      .flatMap((path) => {
        const manifest = JSON.parse(builtinResources[path])
        return manifest.tools.map(
          (tool: { name: string; path: string; urlRegex: string }) =>
            [
              `${manifest.id}.${tool.name}`,
              { ...tool, source: builtinResources[`${manifest.id}/${tool.path}`] },
            ] as const
        )
      })
  )
  let before: ((request: BrowserRequest) => void) | undefined
  const execute = (
    name: string,
    input: Record<string, unknown> = {},
    signal = new AbortController().signal
  ) => {
    const tool = names.get(name)!
    expect(tool, `Unknown tool: ${name}`).toBeDefined()
    expect(
      matchesToolUrl(tool.urlRegex, window.location.href),
      `${name} must register on ${window.location.href}`
    ).toBe(true)
    return executeAdapterWorkflow(wasm, tool.source, input as JsonValue, browser, signal, {
      tabId: 7,
      url: window.location.href,
    })
  }
  const browser = async (request: BrowserRequest, signal: AbortSignal): Promise<JsonValue> => {
    requests.push(request)
    expect(request.options.tab).toBe('7')
    before?.(request)
    if (request.command === 'webmcp') {
      const name = request.positionals[1]
      const child = await execute(name, JSON.parse(request.positionals[2]), signal)
      if (!child.ok) throw new Error(child.error.message)
      return { tabId: 7, url: window.location.href, name, source: 'adapter', result: child.value }
    }
    if (request.command === 'eval') {
      const result = await runInNewContext(`(${request.positionals[0]})(element)`, {
        performance,
        location: window.location,
        document: window.document,
        URL,
        URLSearchParams,
        HTMLImageElement: window.HTMLImageElement,
        HTMLInputElement: window.HTMLInputElement,
        Event: window.Event,
        getComputedStyle: window.getComputedStyle.bind(window),
        element: request.positionals[1]
          ? window.document.querySelector(request.positionals[1])
          : undefined,
      })
      return { tabId: 7, result: JSON.parse(JSON.stringify(result ?? null)) }
    }
    return { tabId: 7, url: window.location.href }
  }
  return {
    window,
    requests,
    completeSearch,
    execute,
    hydrate,
    onBrowser(callback: NonNullable<typeof before>) {
      before = callback
    },
  }
}

it('navigates once, waits, and reads chart results through the registered reader', async () => {
  const page = fixture(
    'https://movie.douban.com/',
    `<table class="item"><tr><td class="title">
    <a href="https://movie.douban.com/subject/1/"> Movie 1 </a><span class="rating_nums"> 9.5 </span>
  </td></tr></table>`
  )
  let reads = 0
  page.onBrowser((request) => {
    if (request.command === 'goto') page.window.happyDOM.setURL(request.positionals[0])
    if (request.command === 'eval')
      Object.defineProperty(page.window.document, 'readyState', {
        configurable: true,
        value: reads++ ? 'complete' : 'loading',
      })
  })
  expect(await page.execute('com.douban.movie.browse_chart', { limit: 1 })).toEqual({
    ok: true,
    value: {
      status: 'success',
      result: {
        count: 1,
        results: [
          {
            rank: 1,
            title: 'Movie 1',
            rating: '9.5',
            url: 'https://movie.douban.com/subject/1/',
            subject_id: '1',
          },
        ],
      },
    },
  })
  expect(page.requests.filter((request) => request.command === 'goto')).toHaveLength(1)
  expect(page.requests.filter((request) => request.command === 'webmcp')).toHaveLength(2)
})

it.each(['com.douban.movie', 'com.douban.search'])(
  '%s skips an old rate-limited query and safely passes the requested query as JSON data',
  async (id) => {
    const page = fixture(
      'https://search.douban.com/movie/subject_search?search_text=old&cat=1002',
      '<main>Too many requests</main>'
    )
    expect(await page.execute(`${id}.read_page`, { query: 'new' })).toMatchObject({
      ok: true,
      value: { result: { query: 'old', results_ready: false } },
    })
    const query = 'new "query" $& \\ __WEBMCP_INPUT__'
    page.onBrowser((request) => {
      if (request.command === 'goto') {
        page.window.happyDOM.setURL(request.positionals[0])
        page.window.document.body.innerHTML = '<main>No results</main>'
      }
    })
    expect(await page.execute(`${id}.search_movies`, { query })).toMatchObject({
      ok: true,
      value: { status: 'success', result: { query, count: 0, results: [] } },
    })
    expect(page.requests.filter((request) => request.command === 'goto')).toHaveLength(1)
    page.window.document.body.innerHTML = '<main>Too many requests</main>'
    expect(await page.execute(`${id}.read_page`, { query })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('rate-limited') },
    })
  }
)

it('opens an archive row with native input and reads the matching thread through WebMCP', async () => {
  const page = fixture(
    'https://jmail.world/',
    `<main><div class="email-row" data-doc-id="DOC_1">
    <span class="sender-name">Alice</span><div class="subject">A subject</div>
    <span class="email-date">Jan 2, 2014</span><span class="preview">A preview</span>
  </div><div>1–1 of 1</div></main>`
  )
  page.onBrowser((request) => {
    if (request.command === 'click') {
      expect(page.window.document.querySelector(request.positionals[0])?.textContent).toBe(
        'A subject'
      )
      page.window.happyDOM.setURL('https://jmail.world/thread/DOC_1?view=inbox')
      page.window.document.title = 'A subject'
      page.window.document.body.innerHTML = '<main>Alice\nA subject\nMessage body\nreply</main>'
    }
  })
  expect(await page.execute('world.jmail.archive.open_result', { index: 0 })).toMatchObject({
    ok: true,
    value: { result: { doc_id: 'DOC_1', text: expect.stringContaining('Message body') } },
  })
  expect(page.requests.filter((request) => request.command === 'click')).toHaveLength(1)
})

it('submits archive search only once while waiting for the matching result route', async () => {
  const page = fixture('https://jmail.world/', '<input name="q"><main>No results found</main>')
  let submitted = false
  let reads = 0
  page.onBrowser((request) => {
    if (request.command === 'fill')
      expect(request.positionals).toEqual(['input[name="q"]', 'Bill Gates'])
    if (request.command === 'press') submitted = true
    if (submitted && request.command === 'eval' && reads++ > 0)
      page.window.happyDOM.setURL('https://jmail.world/search?q=Bill%20Gates')
  })
  expect(
    await page.execute('world.jmail.archive.search_emails', { query: 'Bill Gates' })
  ).toMatchObject({ ok: true, value: { result: { query: 'Bill Gates', count: 0, results: [] } } })
  expect(page.requests.filter((request) => request.command === 'fill')).toHaveLength(1)
  expect(page.requests.filter((request) => request.command === 'press')).toHaveLength(1)
})

it('applies and reads a date range through the list URL without toolbar clicks', async () => {
  const page = fixture(
    'https://jmail.world/?after=2012-01-01',
    `<button aria-label="Filter by date range" class="date-filter-active">Filter</button><main>No results found</main>`
  )
  page.onBrowser((request) => {
    if (request.command !== 'goto') return
    expect(request.positionals[0]).toBe(
      'https://jmail.world/?after=2014-01-01&before=2014-12-31'
    )
    page.window.happyDOM.setURL(request.positionals[0])
    page.window.document.querySelector('main')!.innerHTML =
      `<div class="email-row" data-doc-id="DOC_1"><span class="sender-name">Alice</span><div class="subject">A subject</div><span class="email-date">Jan 2, 2014</span></div><div>1–1 of 1</div>`
    page.hydrate()
  })
  expect(
    await page.execute('world.jmail.archive.filter_by_date', {
      after: '2014-01-01',
      before: '2014-12-31',
    })
  ).toMatchObject({ ok: true, value: { result: { count: 1, results: [{ date: 'Jan 2, 2014' }] } } })
  const nested = page.requests
    .filter((request) => request.command === 'webmcp')
    .map((request) => request.positionals[1])
  expect(nested).toContain('world.jmail.archive.read_page')
  expect(page.requests.filter((request) => request.command === 'click')).toHaveLength(0)
})

it('clears a date range through the list URL without toolbar clicks', async () => {
  const page = fixture(
    'https://jmail.world/?after=2014-01-01&before=2014-12-31',
    `<button aria-label="Filter by date range" class="date-filter-active">Filter</button>
    <main><div class="email-row" data-doc-id="DOC_1"><span class="sender-name">Alice</span>
    <div class="subject">A subject</div><span class="email-date">Jan 2, 2014</span></div>
    <div>1–1 of 1</div></main>`
  )
  page.onBrowser((request) => {
    if (request.command !== 'goto') return
    expect(request.positionals[0]).toBe('https://jmail.world/')
    page.window.happyDOM.setURL(request.positionals[0])
    page.window.document
      .querySelector('button[aria-label="Filter by date range"]')
      ?.classList.remove('date-filter-active')
    page.hydrate()
  })
  expect(await page.execute('world.jmail.archive.clear_date_filter')).toMatchObject({
    ok: true,
    value: {
      result: {
        cleared: true,
        url: '/',
        latest: [{ date: 'Jan 2, 2014' }],
      },
    },
  })
  expect(page.requests.filter((request) => request.command === 'click')).toHaveLength(0)
})

it('uses one shared message snapshot for listing, opening and reading a conversation', async () => {
  const page = fixture(
    'https://jmail.world/messages',
    `<main><a class="mb-0.5" href="/messages/steve-bannon"><div>Steve Bannon</div><div>01/02/14</div><div>Last message</div></a></main>`
  )
  expect(await page.execute('world.jmail.messages.read_page')).toMatchObject({
    ok: true,
    value: { result: { conversations: [{ slug: 'steve-bannon' }] } },
  })
  expect(await page.execute('world.jmail.messages.list_conversations')).toMatchObject({
    ok: true,
    value: { result: { count: 1, conversations: [{ slug: 'steve-bannon' }] } },
  })
  page.onBrowser((request) => {
    if (request.command !== 'click') return
    expect(page.window.document.querySelector(request.positionals[0])?.getAttribute('href')).toBe(
      '/messages/steve-bannon'
    )
    page.window.happyDOM.setURL('https://jmail.world/messages/steve-bannon')
    page.window.document.head.innerHTML =
      '<meta name="description" content="iMessage conversation with Steve Bannon. 2 messages.">'
    page.window.document.body.insertAdjacentHTML(
      'beforeend',
      `<div class="messages-container"><div id="message-1"><div class="break-words">Hello</div><div>10:30 AM</div></div></div>`
    )
  })
  expect(
    await page.execute('world.jmail.messages.open_conversation', { person: 'steve-bannon' })
  ).toMatchObject({
    ok: true,
    value: {
      result: {
        slug: 'steve-bannon',
        message_count: 2,
        visible_messages: [{ text: 'Hello', time: '10:30 AM' }],
      },
    },
  })
  expect(await page.execute('world.jmail.messages.get_current_conversation')).toMatchObject({
    ok: true,
    value: { result: { slug: 'steve-bannon', visible_messages: [{ text: 'Hello' }] } },
  })
})

it.each(['com.douban.movie', 'com.douban.search', 'world.jmail.archive', 'world.jmail.messages'])(
  '%s returns a not-ready observation without interacting with a loading page',
  async (id) => {
    const url = id.startsWith('com.douban')
      ? `https://${id === 'com.douban.movie' ? 'movie' : 'search'}.douban.com/`
      : `https://jmail.world/${id.endsWith('messages') ? 'messages' : ''}`
    const page = fixture(url, '<main>Loading</main>')
    Object.defineProperty(page.window.document, 'readyState', {
      configurable: true,
      value: 'loading',
    })
    expect(await page.execute(`${id}.read_page`)).toMatchObject({
      ok: true,
      value: { result: { ready: false } },
    })
    expect(page.requests.map((request) => request.command)).toEqual(['eval'])
  }
)

it('fails a missing result without clicking or navigating', async () => {
  const page = fixture(
    'https://search.douban.com/movie/subject_search?search_text=test',
    '<main>No results</main>'
  )
  expect(await page.execute('com.douban.search.open_result', { index: 0 })).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('No result row') },
  })
  expect(page.requests.map((request) => request.command)).toEqual(['webmcp', 'eval'])
})

it('waits past stale message search rows and opens the selected hit with native input', async () => {
  const page = fixture(
    'https://jmail.world/messages',
    `<input placeholder="Search"><main>
    <div>MESSAGES 1</div><button><div>Steve Bannon</div><div>01/02/14</div>
    <div class="snippet">An old result</div><img src="/people-thumbnails/steve-bannon.webp"></button></main>`
  )
  let submitted = false
  let reads = 0
  page.onBrowser((request) => {
    if (request.command === 'fill') {
      page.window.document.querySelector('input')!.value = request.positionals[1]
      submitted = request.positionals[1] !== ''
      if (!submitted) {
        page.window.document.querySelector('main')!.innerHTML = ''
      } else {
        page.window.document.querySelector('main')!.innerHTML =
          '<div>MESSAGES 1</div><button><div>Steve Bannon</div><div>01/02/14</div><div class="snippet">An old result</div><img src="/people-thumbnails/steve-bannon.webp"></button>'
      }
      page.hydrate()
    }
    if (submitted && request.command === 'eval' && reads++ > 0) {
      const snippet = page.window.document.querySelector('.snippet')
      if (snippet) snippet.textContent = 'A message about Epstein'
    }
    if (request.command === 'click') {
      expect(page.window.document.querySelector(request.positionals[0])?.tagName).toBe('BUTTON')
      page.window.happyDOM.setURL('https://jmail.world/messages/steve-bannon')
      page.window.document.head.innerHTML =
        '<meta name="description" content="iMessage conversation with Steve Bannon. 2 messages.">'
      page.window.document.body.innerHTML =
        '<div class="messages-container"><div id="message-1"><div class="break-words">A message about Epstein</div></div></div>'
    }
  })
  expect(
    await page.execute('world.jmail.messages.search_messages', { query: 'Epstein' })
  ).toMatchObject({
    ok: true,
    value: {
      result: {
        query: 'Epstein',
        count: 1,
        results: [{ slug: 'steve-bannon', snippet: 'A message about Epstein' }],
      },
    },
  })
  expect(page.requests.filter((request) => request.command === 'fill')).toHaveLength(2)
  expect(reads).toBeGreaterThanOrEqual(2)
  expect(await page.execute('world.jmail.messages.open_search_result', { index: 0 })).toMatchObject(
    {
      ok: true,
      value: { result: { slug: 'steve-bannon', matched_snippet: 'A message about Epstein' } },
    }
  )
})

it('returns a successful empty message search when the page says no results found', async () => {
  const page = fixture(
    'https://jmail.world/messages',
    '<input placeholder="Search"><main>No results found</main>'
  )
  page.onBrowser((request) => {
    if (request.command === 'fill') {
      page.window.document.querySelector('input')!.value = request.positionals[1]
      page.window.document.querySelector('main')!.textContent = request.positionals[1]
        ? 'No results found' : ''
      if (request.positionals[1]) page.completeSearch(request.positionals[1])
    }
  })
  expect(
    await page.execute('world.jmail.messages.search_messages', { query: 'zzzzqqqq' })
  ).toMatchObject({
    ok: true,
    value: {
      result: {
        query: 'zzzzqqqq',
        total_matches: null,
        count: 0,
        results: [],
      },
    },
  })
})

it('cancels a waiting business workflow without resubmitting its action', async () => {
  const page = fixture('https://movie.douban.com/', '<main>Loading results</main>')
  const controller = new AbortController()
  page.onBrowser((request) => {
    if (request.command === 'goto') page.window.happyDOM.setURL(request.positionals[0])
    if (request.command === 'eval') controller.abort(new Error('Canceled by the caller'))
  })
  expect(await page.execute('com.douban.movie.browse_chart', {}, controller.signal)).toMatchObject({
    ok: false,
  })
  expect(page.requests.filter((request) => request.command === 'goto')).toHaveLength(1)
})

it.each([
  ['com.douban.movie.get_current_view', 'title', 'Example Movie'],
  ['com.douban.movie.get_reviews', 'reviews', []],
  ['com.douban.movie.get_comments', 'comments', []],
  ['com.douban.movie.get_tv_info', 'episode_count', '12'],
])('reads %s through the shared subject snapshot', async (name, field, expected) => {
  const page = fixture(
    'https://movie.douban.com/subject/1292052/',
    `<div id="content">
    <h1><span property="v:itemreviewed">Example Movie</span><span class="year">(2020)</span></h1>
    <div id="info">集数: 12</div><span property="v:total-episodes">12</span></div>`
  )
  expect(await page.execute(name)).toMatchObject({
    ok: true,
    value: { result: { [field]: expected } },
  })
  expect(page.requests.every((request) => ['webmcp', 'eval'].includes(request.command))).toBe(true)
})

it('reads now-playing ratings and subject links from the real homepage dataset shape', async () => {
  const page = fixture(
    'https://movie.douban.com/',
    `<ul id="screening"><li class="ui-slide-item" data-title="Example Film" data-rate="9.0"
      data-release="2026-10-01" data-region="中国" data-director="Example Director"
      data-actors="Actor One / Actor Two" data-ticket="https://movie.douban.com/subject/20645019/ticket/">
      <a href="https://movie.douban.com/subject/20645019/?from=showing">Example Film</a>
    </li></ul>`
  )
  expect(await page.execute('com.douban.movie.read_page')).toMatchObject({
    ok: true,
    value: {
      result: {
        now_playing: [
          {
            title: 'Example Film',
            rating: '9.0',
            subject_id: '20645019',
            url: 'https://movie.douban.com/subject/20645019/?from=showing',
          },
        ],
      },
    },
  })
})

it('returns empty arrays instead of null for a movie without TV data', async () => {
  const page = fixture(
    'https://movie.douban.com/subject/1292052/',
    `<div id="content">
    <h1><span property="v:itemreviewed">Example Movie</span><span class="year">(2020)</span></h1>
    <div id="info">导演: Someone</div>
    <div class="recommendations"><a href="/subject/2/"><img src="poster.jpg" alt="Recommended Movie"></a></div>
    <div class="subject-item"><a href="/subject/3/">Another recommendation</a></div></div>`
  )
  expect(await page.execute('com.douban.movie.read_page')).toMatchObject({
    ok: true,
    value: {
      result: {
        tv: {
          seasons: [],
          episodes: [],
          note: expect.stringContaining('No seasons/episodes found'),
        },
      },
    },
  })
})

it('reads only explicit season links on a TV page', async () => {
  const page = fixture('https://movie.douban.com/subject/1/', `
    <div id="content"><h1><span property="v:itemreviewed">Series</span></h1>
    <div id="season"><a href="/subject/2/">Season 2</a></div>
    <div class="seasons"><a href="/subject/3/">Season 3</a></div>
    <a href="/subject/4/"><img src="poster.jpg" alt="Unrelated"></a></div>`)
  expect(await page.execute('com.douban.movie.get_tv_info')).toMatchObject({
    ok: true, value: { result: { seasons: [
      { season: 'Season 2', subject_id: '2' },
      { season: 'Season 3', subject_id: '3' },
    ] } },
  })
})

it.each(['rating_num', 'rating_nums'])('reads Top250 %s from outside the title wrapper', async (ratingClass) => {
  const page = fixture('https://movie.douban.com/top250', `
    <div id="content"><h1>Top250</h1><ol><li><div class="item">
    <div class="hd"><a href="/subject/1292052/">Example Movie</a></div>
    <div class="bd"><span class="${ratingClass}">9.7</span></div>
    </div></li></ol></div>`)
  page.onBrowser((request) => {
    if (request.command === 'goto') page.window.happyDOM.setURL(request.positionals[0])
  })
  expect(await page.execute('com.douban.movie.get_top250')).toMatchObject({
    ok: true, value: { result: { results: [{ rating: '9.7', subject_id: '1292052' }] } },
  })
})

it('reads review author and date from the main header', async () => {
  const page = fixture('https://movie.douban.com/subject/1292052/', `
    <div id="content"><h1><span property="v:itemreviewed">Example Movie</span></h1>
    <div class="review-item" id="1000369"><header class="main-hd">
    <a class="name">Reviewer</a><span content="2005-05-12">2005-05-12 10:00</span></header>
    <h2><a href="/review/1000369/">Review title</a></h2><div class="short-content">Excerpt</div></div></div>`)
  expect(await page.execute('com.douban.movie.get_reviews')).toMatchObject({
    ok: true, value: { result: { reviews: [{ author: 'Reviewer', date: '2005-05-12' }] } },
  })
})

it('reads a redirected personage profile through registered tools', async () => {
  const page = fixture('https://movie.douban.com/', `
    <div id="content"><h1>Dwayne Johnson</h1><div id="intro"><p>Biography</p></div>
    <div id="mainpic"><img src="/photo.jpg"></div>
    <div class="mod"><h2>Legacy works</h2><div class="ob">
      <a href="https://movie.douban.com/subject/1/">Legacy work (2020)</a>
      <span class="rating_nums">7.5</span></div></div>
    <div id="award-block">Legacy award</div></div>`)
  page.onBrowser((request) => {
    if (request.command === 'goto')
      page.window.happyDOM.setURL('https://www.douban.com/personage/27250463/')
  })
  for (let i = 0; i < 2; i++) {
    expect(await page.execute('com.douban.movie.open_celebrity', { celebrity_id: '1044707' })).toMatchObject({
      ok: true, value: { result: {
        is_celebrity_page: true, name: 'Dwayne Johnson', bio: 'Biography', awards: 'Legacy award',
        filmography: { 'Legacy works': [{ title: 'Legacy work', rating: '7.5', subject_id: '1' }] },
      } },
    })
  }
})

it('waits for stale empty results to clear across consecutive searches', async () => {
  const page = fixture('https://jmail.world/messages', '<input placeholder="Search"><main></main>')
  let pending: string | undefined
  let reads = 0
  page.onBrowser((request) => {
    if (request.command === 'fill') {
      pending = request.positionals[1]
      reads = 0
      page.window.document.querySelector('input')!.value = pending
    }
    if (request.command === 'eval' && pending !== undefined && ++reads >= 3) {
      page.window.document.querySelector('main')!.innerHTML = !pending ? '' : pending === 'zzzzqqqq'
        ? 'No results found'
        : '<div>MESSAGES 11</div><button><div>Steve Bannon</div><div>07/04/18</div><div>Epstein Bannon Kurz</div></button>'
      if (pending) page.completeSearch(pending)
      pending = undefined
      page.hydrate()
    }
  })
  for (const query of ['Epstein', 'zzzzqqqq', 'Epstein', 'Epstein']) {
    expect(await page.execute('world.jmail.messages.search_messages', { query })).toMatchObject({
      ok: true, value: { status: 'success', result: {
        query, count: query === 'zzzzqqqq' ? 0 : 1,
        total_matches: query === 'zzzzqqqq' ? null : 11,
      } },
    })
  }
})

it('includes conversation identity when loading older messages', async () => {
  const page = fixture('https://jmail.world/messages/steve-bannon', `
    <head><meta name="description" content="iMessage conversation with Steve Bannon. 1 messages."></head>
    <body><div class="messages-container"><div id="message-1"><div class="break-words">Hello</div></div></div></body>`)
  page.window.document.querySelector('.messages-container')!.scrollTo = () => {}
  expect(await page.execute('world.jmail.messages.load_older_messages', { times: 1 })).toMatchObject({
    ok: true, value: { result: { person: 'Steve Bannon', slug: 'steve-bannon', messages_after: 1 } },
  })
})

it('reads a doulist after Douban redirects it to www.douban.com', async () => {
  const page = fixture(
    'https://movie.douban.com/',
    `<div id="content"><h1><span>Example Doulist</span></h1>
    <div class="doulist-about">A curated list</div>
    <div class="doulist-item"><div class="doulist-subject">
      <div class="title"><a href="https://movie.douban.com/subject/1292052/">Example Movie</a></div>
      <span class="rating_nums">9.7</span><div class="abstract">导演: Someone</div>
    </div></div></div>`
  )
  page.onBrowser((request) => {
    if (request.command !== 'goto') return
    expect(request.positionals[0]).toBe(
      'https://movie.douban.com/doulist/4541413/?start=0'
    )
    page.window.happyDOM.setURL('https://www.douban.com/doulist/4541413/?start=0')
  })
  expect(
    await page.execute('com.douban.movie.get_doulist', { list_id: '4541413' })
  ).toMatchObject({
    ok: true,
    value: {
      result: {
        list_id: '4541413',
        title: 'Example Doulist',
        description: 'A curated list',
        results: [
          {
            title: 'Example Movie',
            rating: '9.7',
            subject_id: '1292052',
            detail: '导演: Someone',
          },
        ],
      },
    },
  })
})

it.each([
  [
    'com.douban.movie.open_celebrity',
    { celebrity_id: '1047973' },
    'https://sec.douban.com/verify/',
  ],
])(
  'returns the actual destination when %s redirects outside the package',
  async (name, input, destination) => {
    const page = fixture('https://movie.douban.com/', '<main>Homepage</main>')
    page.onBrowser((request) => {
      if (request.command === 'goto') page.window.happyDOM.setURL(destination)
    })
    expect(await page.execute(name, input)).toMatchObject({
      ok: true,
      value: { result: { navigated: true, url: destination } },
    })
    expect(page.requests.map((request) => request.command)).toEqual(['goto'])
  }
)

it('reads a non-email folder without waiting for nonexistent email rows', async () => {
  const page = fixture(
    'https://jmail.world/',
    '<nav><a class="nav-item" href="/attachments">Attachments</a></nav><main>No results found</main>'
  )
  page.onBrowser((request) => {
    if (request.command === 'goto') {
      page.window.happyDOM.setURL(request.positionals[0])
      page.window.document.querySelector('main')!.innerHTML = 'Attachments dashboard'
    }
  })
  expect(
    await page.execute('world.jmail.archive.browse_folder', { folder: 'attachments' })
  ).toMatchObject({
    ok: true,
    value: {
      result: {
        kind: 'view',
        url: '/attachments',
        results: [],
        count: 0,
        view: { text: 'Attachments dashboard' },
      },
    },
  })
})

it.each([
  ['world.jmail.archive.browse_person', 'person', 'ghislaine-maxwell', '/person/ghislaine-maxwell'],
  ['world.jmail.archive.browse_topic', 'topic', 'damage-control', '/topic/damage-control'],
])(
  'navigates %s directly when the sidebar is collapsed',
  async (name, inputKey, slug, path) => {
    const page = fixture(
      'https://jmail.world/',
      `<nav><a href="${path}">${slug}</a></nav><main>No results found</main>`
    )
    page.onBrowser((request) => {
      if (request.command !== 'goto') return
      expect(request.positionals[0]).toBe('https://jmail.world' + path)
      page.window.happyDOM.setURL(request.positionals[0])
      page.window.document.querySelector('main')!.innerHTML =
        `<div class="email-row" data-doc-id="DOC_1"><span class="sender-name">Alice</span><div class="subject">A subject</div><span class="email-date">Jan 2, 2014</span></div><div>1–1 of 1</div>`
      page.hydrate()
    })
    expect(await page.execute(name, { [inputKey]: slug })).toMatchObject({
      ok: true,
      value: { result: { url: path, results: [{ doc_id: 'DOC_1' }] } },
    })
    expect(page.requests.filter((request) => request.command === 'click')).toHaveLength(0)
  }
)

it.each([1, 10])('waits for every message body across overlapping searches with limit %i and equal totals', async (limit) => {
  const page = fixture('https://jmail.world/messages', '<input placeholder="Search"><main></main>')
  const html = (q: string) => `<div>MESSAGES ${q === 'Bannon' ? 35 : 11}</div>
    <button><div>Steve Bannon</div><div>07/04/18</div><div>Epstein Bannon Kurz</div></button>
    <button><div>Steve Bannon</div><div>06/14/18</div><div>${q === 'Bannon' ? "Bannon's deputy" : `${q} message`}</div></button>`
  let previous = ''
  let pending: string | undefined
  let reads = 0
  page.onBrowser((request) => {
    if (request.command === 'fill') {
      const query = request.positionals[1]
      page.window.document.querySelector('input')!.value = query
      page.window.document.querySelector('main')!.innerHTML = query && previous ? html(previous) : ''
      pending = query || undefined
      reads = 0
      page.hydrate()
    }
    if (request.command === 'eval' && pending && ++reads >= 3) {
      page.window.document.querySelector('main')!.innerHTML = html(pending)
      previous = pending
      if (pending) page.completeSearch(pending)
      pending = undefined
      page.hydrate()
    }
  })
  for (const query of ['Bannon', 'Epstein', 'Bannon', 'Epstein', 'Kurz']) {
    expect(await page.execute('world.jmail.messages.search_messages', { query, limit })).toMatchObject({
      ok: true, value: { result: {
        query, count: Math.min(2, limit), total_matches: query === 'Bannon' ? 35 : 11,
        results: [
          { snippet: 'Epstein Bannon Kurz' },
          ...(limit > 1 ? [{ snippet: query === 'Bannon' ? "Bannon's deputy" : `${query} message` }] : []),
        ],
      } },
    })
    expect(reads).toBeGreaterThanOrEqual(3)
  }
})

it('checks the complete message body before truncating the returned snippet', async () => {
  const page = fixture('https://jmail.world/messages', `<input placeholder="Search" value="Epstein">
    <main>MESSAGES 1<button><div>Steve Bannon</div><div>07/04/18</div>
    <div>${'Long message '.repeat(30)}Epstein</div></button></main>`)
  expect(await page.execute('world.jmail.messages.read_page', { query: 'Epstein' })).toMatchObject({
    ok: true, value: { result: { search: { count: 1, results_ready: true } } },
  })
})

it('reads modern personage biography, awards, and distinct rated works', async () => {
  const page = fixture('https://movie.douban.com/', `
    <div id="content"><h1>Dwayne Johnson</h1><img class="avatar" src="https://example.com/photo.jpg">
    <div class="mod" id="opt-bar">Recommend</div>
    <div class="subject-intro"><div class="desc"><div class="content"><p>Modern biography</p><p>More biography</p></div></div></div>
    <div class="subject-awards"><h2>Awards</h2><ul><li>2026 nomination</li></ul></div>
    <div class="subject-mod subject-creations"><h2>Recent works</h2><ul>
      <li class="creation"><a href="https://movie.douban.com/subject/36343469/" title="Moana"><img alt="Moana"></a>
      <a href="https://movie.douban.com/subject/36343469/">Moana</a><span class="rating-val">6.5</span></li>
      <li class="creation"><a href="https://movie.douban.com/subject/26817136/">Zootopia 2</a><span class="rating-val">8.3</span></li>
      <li class="creation"><a href="https://movie.douban.com/subject/37173874/">Unrated work</a><span class="rating-none">No rating</span></li>
    </ul><div><a href="https://movie.douban.com/subject/35742019/">Upcoming work</a></div></div>
    <div class="subject-mod subject-creations"><h2>Popular works</h2><ul><li class="creation">
      <a href="https://movie.douban.com/subject/23761370/">Furious 7</a><span class="rating-val">8.4</span>
    </li></ul></div></div>`)
  page.onBrowser((request) => {
    if (request.command === 'goto') page.window.happyDOM.setURL('https://www.douban.com/personage/27250463/')
  })
  expect(await page.execute('com.douban.movie.open_celebrity', { celebrity_id: '1044707' })).toMatchObject({
    ok: true, value: { result: {
      name: 'Dwayne Johnson', photo: 'https://example.com/photo.jpg',
      bio: 'Modern biography More biography', awards: 'Awards 2026 nomination',
      filmography: {
        'Recent works': [
          { title: 'Moana', rating: '6.5', subject_id: '36343469' },
          { title: 'Zootopia 2', rating: '8.3', subject_id: '26817136' },
          { title: 'Unrated work', rating: '', subject_id: '37173874' },
        ],
        'Popular works': [{ title: 'Furious 7', rating: '8.4', subject_id: '23761370' }],
      },
    } },
  })
})

it('rejects empty-result text without a completed search for the current query', async () => {
  const page = fixture('https://jmail.world/messages',
    '<input placeholder="Search" value="Epstein"><main>No results found</main>')
  page.completeSearch('zzzzqqqq')
  expect(await page.execute('world.jmail.messages.read_page', { query: 'Epstein' })).toMatchObject({
    ok: true, value: { result: { search: { query: 'Epstein', count: 0, results_ready: false } } },
  })
})

it('waits when the old empty state reappears after clearing and refilling search', async () => {
  const page = fixture('https://jmail.world/messages', '<input placeholder="Search"><main></main>')
  let previous = ''
  let pending: string | undefined
  let reads = 0
  const html = (query: string) => query.startsWith('zzzz') ? 'No results found'
    : `<div>MESSAGES ${query === 'Bannon' ? 35 : 11}</div><button><div>Steve Bannon</div><div>07/04/18</div><div>${query} message</div></button>`
  page.onBrowser((request) => {
    if (request.command === 'fill') {
      const query = request.positionals[1]
      page.window.document.querySelector('input')!.value = query
      page.window.document.querySelector('main')!.innerHTML = query && previous ? html(previous) : ''
      pending = query || undefined
      reads = 0
      page.hydrate()
    }
    // A completed response can precede React's commit: keep the old DOM for one more read.
    if (request.command === 'eval' && pending && ++reads === 3) page.completeSearch(pending)
    if (request.command === 'eval' && pending && reads >= 4) {
      page.window.document.querySelector('main')!.innerHTML = html(pending)
      previous = pending
      pending = undefined
      page.hydrate()
    }
  })
  for (const query of ['Epstein', 'zzzzqqqq', 'Epstein', 'Bannon', 'zzzzqqqq', 'zzzzxxxx', 'zzzzxxxx', 'Epstein']) {
    expect(await page.execute('world.jmail.messages.search_messages', { query })).toMatchObject({
      ok: true, value: { result: {
        query, count: query.startsWith('zzzz') ? 0 : 1,
        total_matches: query.startsWith('zzzz') ? null : query === 'Bannon' ? 35 : 11,
      } },
    })
    expect(reads).toBeGreaterThanOrEqual(4)
  }
}, 15000)
