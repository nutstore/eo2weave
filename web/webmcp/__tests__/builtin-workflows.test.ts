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

it('composes date filtering, clearing and reading across three real QuickJS invocations', async () => {
  const page = fixture(
    'https://jmail.world/?after=2012-01-01',
    `<button aria-label="Filter by date range" class="date-filter-active">Filter</button><main>No results found</main>`
  )
  const dropdown = `<div class="date-filter-dropdown" data-state="open">
    <label class="date-filter-field">After<input type="date"></label><label class="date-filter-field">Before<input type="date"></label>
    <button class="date-filter-clear">Clear</button><button class="date-filter-apply">Apply</button></div>`
  page.onBrowser((request) => {
    if (request.command !== 'click') return
    const selector = request.positionals[0]
    if (selector.includes('aria-label'))
      page.window.document.body.insertAdjacentHTML('beforeend', dropdown)
    if (selector === '.date-filter-clear') {
      page.window.happyDOM.setURL('https://jmail.world/')
      page.window.document
        .querySelector('.date-filter-active')
        ?.classList.remove('date-filter-active')
      page.window.document.querySelector('.date-filter-dropdown')?.remove()
    }
    if (selector === '.date-filter-apply') {
      const [after, before] = Array.from(page.window.document.querySelectorAll('input')).map(
        (input) => input.value
      )
      expect([after, before]).toEqual(['2014-01-01', '2014-12-31'])
      page.window.happyDOM.setURL(`https://jmail.world/?after=${after}&before=${before}`)
      page.window.document.querySelector('main')!.innerHTML =
        `<div class="email-row" data-doc-id="DOC_1"><span class="sender-name">Alice</span><div class="subject">A subject</div><span class="email-date">Jan 2, 2014</span></div><div>1–1 of 1</div>`
      page.window.document.querySelector('.date-filter-dropdown')?.remove()
      page.hydrate()
    }
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
  expect(nested).toContain('world.jmail.archive.clear_date_filter')
  expect(nested).toContain('world.jmail.archive.read_page')
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
      submitted = true
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
  expect(page.requests.filter((request) => request.command === 'fill')).toHaveLength(1)
  expect(reads).toBeGreaterThanOrEqual(2)
  expect(await page.execute('world.jmail.messages.open_search_result', { index: 0 })).toMatchObject(
    {
      ok: true,
      value: { result: { slug: 'steve-bannon', matched_snippet: 'A message about Epstein' } },
    }
  )
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

it.each([
  [
    'com.douban.movie.open_celebrity',
    { celebrity_id: '1047973' },
    'https://www.douban.com/personage/27253735/',
  ],
  [
    'com.douban.movie.get_doulist',
    { list_id: '4541413' },
    'https://www.douban.com/doulist/4541413/',
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
    if (request.command === 'click') {
      page.window.happyDOM.setURL('https://jmail.world/attachments')
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
