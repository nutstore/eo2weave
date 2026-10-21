import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const extensionPath = resolve('../browser-extension/dist/chrome-mv3')
const sourcePath = resolve('../browser-extension/builtin-webmcp')
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const packages = readdirSync(sourcePath).map((id) =>
  JSON.parse(readFileSync(join(sourcePath, id, 'manifest.json'), 'utf8'))
)
const allNames: string[] = packages.flatMap((pkg) =>
  pkg.tools.map((tool: { name: string }) => `${pkg.id}.${tool.name}`)
)
const customPackageId = 'com.creatorweave.webmcp-e2e'
const customURLRegex = '^https://jmail\\.world/(?:[^?#]*)?(?:\\?[^#]*)?(?:#.*)?$'
const customManifest = {
  id: customPackageId,
  version: '1.0.0',
  description: 'Exercise extension-owned nested WebMCP execution without CreatorWeave.',
  tools: [
    {
      name: 'call',
      description: 'Invoke a tool on another tab while retaining the calling document.',
      urlRegex: customURLRegex,
      path: 'workflows/call.js',
    },
    {
      name: 'outer',
      description: 'Call inner, which calls leaf and reads the initiating page title.',
      urlRegex: customURLRegex,
      path: 'workflows/outer.js',
    },
    {
      name: 'inner',
      description: 'Call leaf and preserve the nested result chain.',
      urlRegex: customURLRegex,
      path: 'workflows/inner.js',
    },
    {
      name: 'leaf',
      description: 'Read the current page title through browser.eval.',
      urlRegex: customURLRegex,
      path: 'workflows/leaf.js',
    },
  ],
}
const inputSchema =
  "{ type: 'object', properties: { marker: { type: 'string' } }, additionalProperties: false }"
const customSources: Record<string, string> = {
  'manifest.json': JSON.stringify(customManifest, null, 2),
  'workflows/call.js': `export default {
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'integer' }, name: { type: 'string' }, args: { type: 'object' }
    },
    required: ['tabId', 'name', 'args']
  },
  outputSchema: true,
  tree: {
    type: 'action',
    async run({ input, state }) {
      const response = await browser.webmcp.exec(input.name, input.args, { tab: input.tabId });
      if (response.tabId !== input.tabId) throw new Error('Browser returned another tab');
      state.value = response.result;
      return 'success';
    }
  },
  result({ state }) { return state.value; }
}`,
  'workflows/outer.js': `export default {
  inputSchema: ${inputSchema},
  outputSchema: true,
  tree: {
    type: 'action',
    async run({ input, state, target }) {
      const nested = await browser.webmcp.exec(
        '${customPackageId}.inner',
        { marker: input.marker },
        { tab: target.tabId }
      );
      if (!nested || nested.tabId !== target.tabId || nested.result?.status !== 'success')
        throw new Error('Nested inner workflow failed: ' + JSON.stringify(nested));
      const inner = nested.result.result;
      state.value = {
        title: inner.title,
        tabId: inner.tabId,
        trace: ['outer', ...inner.trace]
      };
      return 'success';
    }
  },
  result({ state }) { return state.value; }
}`,
  'workflows/inner.js': `export default {
  inputSchema: ${inputSchema},
  outputSchema: true,
  tree: {
    type: 'action',
    async run({ input, state, target }) {
      const nested = await browser.webmcp.exec(
        '${customPackageId}.leaf',
        { marker: input.marker },
        { tab: target.tabId }
      );
      if (!nested || nested.tabId !== target.tabId || nested.result?.status !== 'success')
        throw new Error('Nested leaf workflow failed: ' + JSON.stringify(nested));
      const leaf = nested.result.result;
      state.value = {
        title: leaf.title,
        tabId: leaf.tabId,
        trace: ['inner', ...leaf.trace]
      };
      return 'success';
    }
  },
  result({ state }) { return state.value; }
}`,
  'workflows/leaf.js': `export default {
  inputSchema: ${inputSchema},
  outputSchema: true,
  tree: {
    type: 'action',
    async run({ state, target }) {
      const page = await browser.eval('() => document.title', { tab: target.tabId });
      state.value = { title: String(page.result), tabId: page.tabId, trace: ['leaf'] };
      return 'success';
    }
  },
  result({ state }) { return state.value; }
}`,
}
let context: BrowserContext, profile: string
let caller: Page
let setupError: Error | undefined
const events: unknown[] = []

/** Seed a real custom package in the extension's OPFS origin. */
async function writeCustomPackage(page: Page) {
  await page.evaluate(
    async ({ id, sources }) => {
      const root = await navigator.storage.getDirectory()
      const contents = await root
        .getDirectoryHandle('webmcp', { create: true })
        .then((mount) => mount.getDirectoryHandle(id, { create: true }))
      for (const [path, text] of Object.entries(sources)) {
        let directory = contents
        const parts = path.split('/')
        for (const part of parts.slice(0, -1))
          directory = await directory.getDirectoryHandle(part, { create: true })
        const file = await directory.getFileHandle(parts.at(-1)!, { create: true })
        const writable = await file.createWritable()
        await writable.write(text)
        await writable.close()
      }
    },
    { id: customPackageId, sources: customSources }
  )
}

async function modelContextToolNames(page: Page): Promise<string[]> {
  return page
    .evaluate(async () => {
      const context = (document as any).modelContext
      if (!context?.getTools) return []
      const tools = await context.getTools()
      return Array.isArray(tools)
        ? tools
            .map((tool: any) => tool?.name)
            .filter((name: unknown): name is string => typeof name === 'string')
        : []
    })
    .catch((error) => {
      // Sites may redirect through an interstitial before the target document settles.
      if (String(error).includes('Execution context was destroyed')) return []
      throw error
    })
}

/** Invoke the registered page proxy exactly as a page consumer would. */
async function invoke(page: Page, name: string, args: Record<string, unknown> = {}) {
  await expect
    .poll(async () => (await modelContextToolNames(page)).includes(name), {
      message: `Actual extension did not register ${name} on ${page.url()}`,
      timeout: 20000,
    })
    .toBe(true)
  const output = await page.evaluate(
    async ({ name, args }) => {
      const context = (document as any).modelContext
      const tools = await context.getTools()
      const tool = tools.find((candidate: any) => candidate?.name === name)
      if (!tool) throw new Error(`Registered tool disappeared: ${name}`)
      const ModelContext = (globalThis as any).ModelContext
      const usesNativeInput =
        typeof ModelContext === 'function' &&
        context instanceof ModelContext &&
        Function.prototype.toString.call(ModelContext).includes('[native code]')
      const result = await context.executeTool(tool, usesNativeInput ? JSON.stringify(args) : args)
      if (typeof result === 'string') return JSON.parse(result)
      try {
        return JSON.parse(JSON.stringify(result))
      } catch {
        return String(result)
      }
    },
    { name, args }
  )
  expect(output?.status, JSON.stringify(output)).toBe('success')
  return output.result
}

/** Retain the caller while the target document navigates; the workflow runs in the SW. */
async function invokeFromAnotherTab(page: Page, name: string, args: Record<string, unknown>) {
  await expect.poll(() => modelContextToolNames(page)).toContain(name)
  const tabId = await context.serviceWorkers()[0].evaluate(async (url) => {
    const tabs = await (globalThis as any).chrome.tabs.query({})
    const matches = tabs.filter((tab: any) => tab.url === url)
    if (matches.length !== 1) throw new Error(`Expected one target tab for ${url}`)
    return matches[0].id as number
  }, page.url())
  const output = await invoke(caller, `${customPackageId}.call`, { tabId, name, args })
  expect(output?.status, JSON.stringify(output)).toBe('success')
  return output.result
}
async function visit(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 })
  await expect(page.locator('body')).toBeVisible()
}
const mail = 'https://jmail.world'
const movie = 'https://movie.douban.com'
const search = 'https://search.douban.com/movie/subject_search?search_text=Inception&cat=1002'
async function emailThread(page: Page) {
  await visit(page, mail)
  await page.locator('.email-row[data-doc-id]:visible').first().click()
  await expect(page).toHaveURL(/jmail\.world\/thread\//)
}
async function conversation(page: Page) {
  await visit(page, `${mail}/messages`)
  await page.locator('a[href^="/messages/"]').first().click()
  await expect(page).toHaveURL(/\/messages\/[^/?]+/)
  await expect(page.locator('.messages-container [id^=message-]').first()).toBeVisible()
}
async function messageSearch(page: Page) {
  await visit(page, `${mail}/messages`)
  await page.getByPlaceholder('Search', { exact: true }).fill('Epstein')
  await expect(
    page
      .getByRole('button')
      .filter({ hasText: /Epstein.*Bannon|Steve Bannon/i })
      .first()
  ).toBeVisible()
}
interface Scenario {
  start: string
  prepare?: (page: Page) => Promise<Record<string, unknown> | void>
  args?: Record<string, unknown>
  urlOnly?: RegExp
  verify(page: Page, result: any): Promise<void>
}
const navigation =
  (pattern: RegExp): Scenario['verify'] =>
  async (page, result) => {
    expect(result.navigated).toBe(true)
    await expect(page).toHaveURL(pattern)
  }
const nonempty =
  (key: string): Scenario['verify'] =>
  async (_page, result) => {
    expect(result[key]).toBeInstanceOf(Array)
    expect(result[key].length).toBeGreaterThan(0)
  }
const transcript: Scenario['verify'] = async (page, result) => {
  expect(result.slug).toBeTruthy()
  expect(result.person).toBeTruthy()
  expect(result.visible_messages.length).toBeGreaterThan(0)
  expect(
    result.visible_messages.every(
      (message: any) => typeof message.text === 'string' && message.text.length <= 4000
    )
  ).toBe(true)
  await expect(page).toHaveURL(/\/messages\/[^/?]+/)
  const actual = await page.locator('.messages-container').innerText()
  for (const message of result.visible_messages) {
    expect(message.text).not.toMatch(/NaN:undefined/)
    expect(actual).toContain(message.text)
  }
}
// Douban acceptance is URL-only; live content and rate limiting are diagnostics.
const doubanURL = (start: string, url: RegExp, args?: Record<string, unknown>): Scenario => ({
  start,
  args,
  urlOnly: url,
  verify: async (page) => {
    await expect(page).toHaveURL(url)
  },
})
const scenarios: Record<string, Scenario> = {
  'com.douban.movie.read_page': doubanURL(movie, /^https:\/\/movie\.douban\.com\/$/),
  'com.douban.search.read_page': doubanURL(search, /search\.douban\.com\/movie\/subject_search/),
  'world.jmail.archive.read_page': { start: mail, verify: nonempty('results') },
  'world.jmail.messages.read_page': {
    start: `${mail}/messages`,
    verify: nonempty('conversations'),
  },
  'com.douban.movie.go_home': doubanURL(
    `${movie}/subject/1292052/`,
    /^https:\/\/movie\.douban\.com\/$/
  ),
  'com.douban.movie.open_subject': doubanURL(movie, /movie\.douban\.com\/subject\/1292052\//, {
    subject_id: '1292052',
  }),
  'com.douban.movie.open_celebrity': doubanURL(
    movie,
    /\/celebrity\/1047973\/|www\.douban\.com\/personage\/27253735\//,
    { celebrity_id: '1047973' }
  ),
  'com.douban.movie.browse_section': doubanURL(movie, /movie\.douban\.com\/chart/, {
    section: 'chart',
  }),
  'com.douban.movie.get_now_playing': doubanURL(movie, /^https:\/\/movie\.douban\.com\/$/),
  'com.douban.movie.get_weekly_chart': doubanURL(movie, /^https:\/\/movie\.douban\.com\/$/),
  'com.douban.movie.browse_chart': doubanURL(`${movie}/chart`, /movie\.douban\.com\/chart/),
  'com.douban.movie.get_top250': doubanURL(`${movie}/top250`, /movie\.douban\.com\/top250/),
  'com.douban.movie.get_doulist': doubanURL(
    movie,
    /(?:movie|www)\.douban\.com\/doulist\/4541413\//,
    {
      list_id: '4541413',
    }
  ),
  'com.douban.movie.get_comments': doubanURL(
    `${movie}/subject/1292052/`,
    /movie\.douban\.com\/subject\/1292052\//
  ),
  'com.douban.movie.get_reviews': doubanURL(
    `${movie}/subject/1292052/`,
    /movie\.douban\.com\/subject\/1292052\//
  ),
  'com.douban.movie.get_current_view': doubanURL(
    `${movie}/subject/1292052/`,
    /movie\.douban\.com\/subject\/1292052\//
  ),
  'com.douban.movie.get_tv_info': doubanURL(
    `${movie}/subject/25853071/`,
    /movie\.douban\.com\/subject\/25853071\//
  ),
  'com.douban.movie.search_movies': doubanURL(
    movie,
    /search\.douban\.com\/movie\/subject_search\?search_text=Inception&cat=1002/,
    { query: 'Inception', limit: 5 }
  ),
  'com.douban.movie.open_result': doubanURL(
    `${movie}/subject_search?search_text=Inception&cat=1002`,
    /movie\.douban\.com\/subject\/\d+\//,
    { index: 0 }
  ),
  'com.douban.search.get_current_view': doubanURL(
    search,
    /search\.douban\.com\/movie\/subject_search\?search_text=Inception&cat=1002/
  ),
  'com.douban.search.search_movies': doubanURL(
    search,
    /search\.douban\.com\/movie\/subject_search\?search_text=%E8%82%96%E7%94%B3%E5%85%8B&cat=1002/,
    { query: '肖申克', limit: 5 }
  ),
  'com.douban.search.open_result': doubanURL(search, /movie\.douban\.com\/subject\/\d+\//, {
    index: 0,
  }),
  'com.douban.search.open_subject': doubanURL(search, /movie\.douban\.com\/subject\/1292052\//, {
    subject_id: '1292052',
  }),
  'com.douban.search.go_movie_site': doubanURL(search, /^https:\/\/movie\.douban\.com\/$/),
  'world.jmail.archive.get_current_view': {
    start: mail,
    prepare: emailThread,
    verify: async (page, result) => {
      expect(result.doc_id).toBeTruthy()
      expect(result.text.length).toBeGreaterThan(0)
      expect(result.url).toBe(new URL(page.url()).pathname + new URL(page.url()).search)
    },
  },
  'world.jmail.archive.list_people': { start: mail, verify: nonempty('people') },
  'world.jmail.archive.list_topics': { start: mail, verify: nonempty('topics') },
  'world.jmail.archive.search_emails': {
    start: mail,
    args: { query: 'Bill Gates', limit: 5 },
    verify: async (page, result) => {
      expect(result.results.length).toBeGreaterThan(0)
      expect(result.query).toBe('Bill Gates')
      await expect(page).toHaveURL(/\/search\?/)
    },
  },
  'world.jmail.archive.open_result': {
    start: `${mail}/search?q=Bill%20Gates`,
    args: { index: 0 },
    verify: async (page, result) => {
      expect(result.doc_id).toBeTruthy()
      expect(result.text.length).toBeGreaterThan(0)
      await expect(page).toHaveURL(/\/thread\//)
    },
  },
  'world.jmail.archive.open_thread': {
    start: mail,
    prepare: async (page) => {
      await emailThread(page)
      const doc_id = decodeURIComponent(new URL(page.url()).pathname.split('/')[2])
      await visit(page, mail)
      return { doc_id }
    },
    verify: navigation(/\/thread\//),
  },
  'world.jmail.archive.next_thread': {
    start: mail,
    prepare: emailThread,
    args: { steps: 1 },
    verify: async (_page, result) => {
      expect(result.steps_moved).toBe(1)
      expect(result.text.length).toBeGreaterThan(0)
    },
  },
  'world.jmail.archive.prev_thread': {
    start: mail,
    prepare: async (page) => {
      await emailThread(page)
      await page.locator('a[aria-label="Next thread"]').click()
      await expect(page.locator('a[aria-label="Previous thread"]')).toBeVisible()
    },
    args: { steps: 1 },
    verify: async (_page, result) => {
      expect(result.steps_moved).toBe(1)
      expect(result.text.length).toBeGreaterThan(0)
    },
  },
  'world.jmail.archive.browse_person': {
    start: mail,
    prepare: async (page) => ({
      person: (await page.locator('nav a[href^="/person/"]').first().getAttribute('href'))!.split(
        '/'
      )[2],
    }),
    verify: async (page, result) => {
      await expect(page).toHaveURL(/\/person\//)
      expect(result.results.length).toBeGreaterThan(0)
    },
  },
  'world.jmail.archive.browse_topic': {
    start: mail,
    prepare: async (page) => ({
      topic: (await page.locator('nav a[href^="/topic/"]').first().getAttribute('href'))!.split(
        '/'
      )[2],
    }),
    verify: async (page, result) => {
      await expect(page).toHaveURL(/\/topic\//)
      expect(result.results.length).toBeGreaterThan(0)
    },
  },
  'world.jmail.archive.browse_folder': {
    start: mail,
    args: { folder: 'sent' },
    verify: async (page, result) => {
      await expect(page).toHaveURL(/\/sent/)
      expect(result.results.length).toBeGreaterThan(0)
    },
  },
  'world.jmail.archive.filter_by_date': {
    start: mail,
    args: { after: '2019-01-01', before: '2019-12-31', limit: 5 },
    verify: async (page, result) => {
      await expect(page).toHaveURL(/after=2019-01-01/)
      expect(result.count).toBeGreaterThan(0)
      for (const row of result.results) {
        const time = Date.parse(row.date)
        expect(time).toBeGreaterThanOrEqual(Date.parse('2019-01-01'))
        expect(time).toBeLessThanOrEqual(Date.parse('2019-12-31T23:59:59'))
      }
    },
  },
  'world.jmail.archive.clear_date_filter': {
    start: `${mail}/?after=2019-01-01&before=2019-12-31`,
    verify: async (page, result) => {
      expect(result.cleared).toBe(true)
      await expect(page).not.toHaveURL(/after=|before=/)
    },
  },
  'world.jmail.archive.open_message_app': { start: mail, verify: navigation(/\/messages/) },
  'world.jmail.archive.go_home': {
    start: `${mail}/sent`,
    verify: async (page, result) => {
      await expect(page).toHaveURL(/^https:\/\/jmail\.world\/$/)
      expect(result.latest.length).toBeGreaterThan(0)
    },
  },
  'world.jmail.messages.list_conversations': {
    start: `${mail}/messages`,
    verify: nonempty('conversations'),
  },
  'world.jmail.messages.open_conversation': {
    start: `${mail}/messages`,
    prepare: async (page) => ({
      person: (await page.locator('a[href^="/messages/"]').first().getAttribute('href'))!.split(
        '/'
      )[2],
    }),
    verify: transcript,
  },
  'world.jmail.messages.get_current_conversation': {
    start: `${mail}/messages`,
    prepare: conversation,
    verify: transcript,
  },
  'world.jmail.messages.search_messages': {
    start: `${mail}/messages`,
    args: { query: 'Epstein', limit: 5 },
    verify: async (_page, result) => {
      expect(result.query).toBe('Epstein')
      expect(result.results.length).toBeGreaterThan(0)
    },
  },
  'world.jmail.messages.clear_message_search': {
    start: `${mail}/messages`,
    prepare: messageSearch,
    verify: async (page, result) => {
      expect(result.cleared).toBe(true)
      await expect(page.getByPlaceholder('Search', { exact: true })).toHaveValue('')
    },
  },
  'world.jmail.messages.open_search_result': {
    start: `${mail}/messages`,
    prepare: messageSearch,
    args: { index: 0 },
    verify: async (page, result) => {
      await transcript(page, result)
      expect(result.matched_snippet).toBeTruthy()
      await expect(page.getByPlaceholder('Search', { exact: true })).toHaveValue('')
    },
  },
  'world.jmail.messages.load_older_messages': {
    start: `${mail}/messages`,
    prepare: conversation,
    args: { times: 1 },
    verify: async (page, result) => {
      expect(result.loads_performed).toBe(1)
      expect(result.messages_before).toBeGreaterThan(0)
      expect(result.messages_after).toBeGreaterThan(0)
      expect(result.newly_visible.length).toBeGreaterThan(0)
      expect(await page.locator('.messages-container').evaluate((el) => el.scrollTop)).toBeLessThan(
        0
      )
      await transcript(page, { ...result, slug: 'steve-bannon', person: 'Steve Bannon' })
    },
  },
  'world.jmail.messages.open_conversation_list': {
    start: `${mail}/messages`,
    prepare: conversation,
    verify: async (page, result) => {
      await expect(page).toHaveURL(`${mail}/messages`)
      expect(result.latest.length).toBeGreaterThan(0)
    },
  },
  'world.jmail.messages.open_email_archive': {
    start: `${mail}/messages`,
    verify: navigation(/^https:\/\/jmail\.world\/$/),
  },
}

// Every shipped workflow has explicit acceptance: Douban URLs, jmail business results.
expect(Object.keys(scenarios).sort()).toEqual(allNames.sort())

test.beforeAll(async () => {
  test.setTimeout(180000)
  try {
    console.log('LIVE_SETUP launch')
    const headless = process.env.WEBMCP_E2E_HEADLESS === '1'
    await readFile(join(extensionPath, 'manifest.json'))
    profile = await mkdtemp(join(tmpdir(), 'webmcp-live-'))
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      executablePath: process.env.WEBMCP_E2E_CHROMIUM,
      headless,
      ignoreDefaultArgs: ['--disable-extensions'],
      viewport: headless ? { width: 1440, height: 900 } : null,
      // Headless Chrome advertises "HeadlessChrome" and navigator.webdriver, which sites such
      // as Douban answer with a never-ending loading state. Present a regular Chrome instead.
      ...(headless ? { userAgent: process.env.WEBMCP_E2E_USER_AGENT || DEFAULT_USER_AGENT } : {}),
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--disable-blink-features=AutomationControlled',
      ],
    })
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent('serviceworker', { timeout: 20000 }))
    const extensionId = new URL(worker.url()).hostname
    context.setDefaultTimeout(20000)
    console.log('LIVE_SETUP management')
    const management = await context.newPage()
    management.on('console', (message) =>
      events.push({ type: 'console', level: message.type(), text: message.text() })
    )
    await management.goto(`chrome-extension://${extensionId}/recipes.html`)
    await expect(management.locator('.card')).toHaveCount(packages.length)
    for (const pkg of packages) {
      const toggle = management.getByRole('checkbox', {
        name: new RegExp(pkg.id.replaceAll('.', '\\.').replaceAll('-', '\\-') + '$'),
      })
      await expect(toggle, await management.locator('body').innerText()).toBeEnabled()
      await toggle.check()
      await expect
        .poll(
          async () =>
            management.evaluate(async (id) => {
              const result = await (globalThis as any).chrome.runtime.sendMessage({
                type: 'webmcp_packages_list',
              })
              return result.entries.find((entry: any) => entry.directory === id)?.activation
            }, pkg.id),
          { message: `Package toggle did not commit: ${pkg.id}` }
        )
        .toBe('enabled')
    }
    console.log('LIVE_SETUP custom package')
    await writeCustomPackage(management)
    await management.reload()
    await expect(management.locator('.card')).toHaveCount(packages.length + 1)
    const customToggle = management.getByRole('checkbox', {
      name: /com\.creatorweave\.webmcp-e2e$/,
    })
    await expect(customToggle, await management.locator('body').innerText()).toBeEnabled()
    await customToggle.check()
    await expect
      .poll(
        async () =>
          management.evaluate(async (id) => {
            const result = await (globalThis as any).chrome.runtime.sendMessage({
              type: 'webmcp_packages_list',
            })
            return result.entries.find((entry: any) => entry.directory === id)?.activation
          }, customPackageId),
        { message: 'Custom package toggle did not commit' }
      )
      .toBe('enabled')
    await expect(management.locator('input.toggle:disabled')).toHaveCount(0)
    await management.close()
    expect(
      context.pages().some((page) => /localhost:5173/.test(page.url())),
      'CreatorWeave Web was opened by the extension-owned E2E'
    ).toBe(false)
    caller = await context.newPage()
    await visit(caller, `${mail}/?webmcp-e2e-controller=1`)
    console.log('LIVE_SETUP ready')
  } catch (error) {
    setupError = error instanceof Error ? error : new Error(String(error))
    console.error('REAL_E2E_SETUP_FAILED', setupError)
  }
})
test.afterAll(async () => {
  await context?.close()
  if (profile) await rm(profile, { recursive: true, force: true })
})
for (const name of allNames) {
  // Playwright requires the destructuring pattern for the fixtures argument.
  // eslint-disable-next-line no-empty-pattern
  test(name, async ({}, testInfo) => {
    if (setupError) {
      await testInfo.attach('setup-diagnostics', {
        body: JSON.stringify(events, null, 2),
        contentType: 'application/json',
      })
      throw setupError
    }
    const page = await context.newPage()
    const network: unknown[] = []
    await context.tracing.start({ screenshots: true, snapshots: true })
    page.on('requestfailed', (request) =>
      network.push({ url: request.url(), failure: request.failure() })
    )
    page.on('pageerror', (error) => network.push({ pageError: error.message }))
    page.on('console', (message) =>
      events.push({ type: 'console', level: message.type(), text: message.text() })
    )
    try {
      const scenario = scenarios[name]
      let result: unknown = null
      try {
        if (scenario.urlOnly)
          await page.goto(scenario.start, { waitUntil: 'commit', timeout: 40000 })
        else await visit(page, scenario.start)
        const prepared = await scenario.prepare?.(page)
        result = await invokeFromAnotherTab(page, name, { ...scenario.args, ...prepared })
      } catch (error) {
        if (!scenario.urlOnly) throw error
        await testInfo.attach('douban-invocation-diagnostic', {
          body: String(error),
          contentType: 'text/plain',
        })
      }
      await testInfo.attach('business-result', {
        body: JSON.stringify(result, null, 2),
        contentType: 'application/json',
      })
      await scenario.verify(page, result)
      await testInfo.attach('result', {
        body: JSON.stringify(
          {
            name,
            acceptance: scenario.urlOnly ? 'url-only' : 'business-result',
            url: page.url(),
            result,
          },
          null,
          2
        ),
        contentType: 'application/json',
      })
    } finally {
      await testInfo.attach('live-diagnostics', {
        body: JSON.stringify({ url: page.url(), network, extensionEvents: events }, null, 2),
        contentType: 'application/json',
      })
      await testInfo.attach('screenshot', {
        body: await page.screenshot({ fullPage: true }).catch(() => Buffer.from('')),
        contentType: 'image/png',
      })
      await context.tracing.stop({ path: testInfo.outputPath('trace.zip') })
      await page.close()
    }
  })
}

// eslint-disable-next-line no-empty-pattern
test('custom workflow supports two nested browser.webmcp.exec calls', async ({}, testInfo) => {
  if (setupError) throw setupError
  const page = await context.newPage()
  await context.tracing.start({ screenshots: true, snapshots: true })
  try {
    await visit(page, mail)
    await expect
      .poll(() => modelContextToolNames(page))
      .toEqual(
        expect.arrayContaining([
          `${customPackageId}.outer`,
          `${customPackageId}.inner`,
          `${customPackageId}.leaf`,
        ])
      )
    const result = await invoke(page, `${customPackageId}.outer`, {
      marker: 'creatorweave-closed',
    })
    expect(result).toMatchObject({
      title: await page.title(),
      trace: ['outer', 'inner', 'leaf'],
    })
    expect(result.tabId).toBeGreaterThan(0)
    await testInfo.attach('result', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    })
  } finally {
    await testInfo.attach('screenshot', {
      body: await page.screenshot({ fullPage: true }).catch(() => Buffer.from('')),
      contentType: 'image/png',
    })
    await context.tracing.stop({ path: testInfo.outputPath('trace.zip') })
    await page.close()
  }
})
