import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const extensionPath = resolve('../browser-extension/dist/chrome-mv3')
const sourcePath = resolve('../browser-extension/builtin-webmcp')
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const baseURL = process.env.WEBMCP_E2E_BASE_URL || 'http://localhost:5173'
const packages = readdirSync(sourcePath).map((id) =>
  JSON.parse(readFileSync(join(sourcePath, id, 'manifest.json'), 'utf8'))
)
const allNames: string[] = packages.flatMap((pkg) =>
  pkg.tools.map((tool: { name: string }) => `${pkg.id}.${tool.name}`)
)
let context: BrowserContext, host: Page, profile: string
let setupError: Error | undefined
let invokedTabId: number | undefined
const events: unknown[] = []

/** Seed real application services, never replace the workspace host/tool registry.
 * Development Webpack modules are used only to create an OPFS/SQLite project and
 * workspace without configuring an unrelated LLM account or sending AI requests.
 */
async function createWorkspace(page: Page) {
  await page.evaluate(async () => {
    const win = window as any
    let require: any
    win.webpackChunk_N_E.push([
      [`webmcp-e2e-${Date.now()}`],
      {},
      (value: any) => {
        require = value
      },
    ])
    const store = (name: string) => {
      const key = Object.keys(require.m).find((key) => key.endsWith(`/store/${name}.store.ts`))
      if (!key) throw new Error(`Application module unavailable: ${name}`)
      return require(key)
    }
    const projects = store('project').useProjectStore
    const deadline = Date.now() + 45000
    while (!projects.getState().initialized || projects.getState().isLoading) {
      if (Date.now() > deadline)
        throw new Error('Project initialization did not finish: ' + projects.getState().error)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const project = await projects.getState().createProject('WebMCP live E2E')
    if (!project || !(await projects.getState().setActiveProject(project.id)))
      throw new Error('Could not create real project: ' + projects.getState().error)
    await store('workspace')
      .useWorkspaceStore.getState()
      .createWorkspace(`webmcp-live-${Date.now()}`, '', 'WebMCP live E2E')
    store('settings').useSettingsStore.getState().setEnableWebMCP(true)
  })
}

/** Read through the real mounted provider, including the extension transport. */
async function readBuiltinPackage(page: Page, id: string): Promise<Record<string, string>> {
  return page.evaluate(async (directory) => {
    let require: any
    ;(window as any).webpackChunk_N_E.push([
      [`webmcp-vfs-${Date.now()}`], {}, (value: any) => { require = value },
    ])
    const key = Object.keys(require.m).find(key => key.endsWith('/vfs/provider-registry.ts'))
    if (!key) throw new Error('Application provider registry unavailable')
    const provider = await require(key).providerRegistry.get('builtin-webmcp')
    if (!provider.readOnly) throw new Error('Builtin provider must be read-only')
    const sources: Record<string, string> = {}
    const readDirectory = async (relative: string) => {
      const path = relative ? `${directory}/${relative}` : directory
      for (const entry of await provider.readdir(path)) {
        const name = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.kind === 'directory') await readDirectory(name)
        else sources[name] = new TextDecoder().decode(await provider.readFile(`${directory}/${name}`))
      }
    }
    await readDirectory('')
    return sources
  }, id)
}

async function catalog(page: Page) {
  return page.evaluate(async () => (window as any).__agentWeb.webMCPDiscover({}))
}
async function invoke(
  page: Page,
  name: string,
  args: Record<string, unknown> = {},
  expectFailure = false
) {
  await expect
    .poll(
      async () => {
        const discovered = await catalog(host)
        return discovered.tools?.some(
          (tool: any) => tool.name === name && tool.tabUrl === page.url()
        )
      },
      { message: `Actual extension did not register ${name} on ${page.url()}`, timeout: 20000 }
    )
    .toBe(true)
  const discovered = await catalog(host)
  const route = discovered.tools.find(
    (tool: any) => tool.name === name && tool.tabUrl === page.url()
  )
  const output = await host.evaluate(
    async ({ route, args }) =>
      (window as any).__agentWeb.webMCPInvoke({
        groupKey: route.groupKey,
        fullToolName: route.fullName,
        preferredTabId: route.tabId,
        args,
      }),
    { route, args }
  )
  invokedTabId = route.tabId
  if (expectFailure) return output
  expect(output.ok, JSON.stringify(output)).toBe(true)
  const workflow = typeof output.result === 'string' ? JSON.parse(output.result) : output.result
  expect(workflow.status, JSON.stringify(workflow)).toBe('success')
  return workflow.result
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
const scenarios: Record<string, Scenario> = {
  'com.douban.movie.go_home': {
    start: `${movie}/subject/1292052/`,
    verify: navigation(/^https:\/\/movie\.douban\.com\/$/),
  },
  'com.douban.movie.open_subject': {
    start: movie,
    args: { subject_id: '1292052' },
    verify: navigation(/\/subject\/1292052\//),
  },
  'com.douban.movie.open_celebrity': {
    start: movie,
    args: { celebrity_id: '1047973' },
    verify: async (page, result) => {
      expect(result.navigated).toBe(true)
      await expect(page).toHaveURL(/\/celebrity\/1047973\/|www\.douban\.com\/personage\/27253735\//)
      await expect(page.locator('h1')).toContainText('弗兰克')
    },
  },
  'com.douban.movie.browse_section': {
    start: movie,
    args: { section: 'chart' },
    verify: navigation(/\/chart/),
  },
  'com.douban.movie.get_now_playing': { start: movie, verify: nonempty('results') },
  'com.douban.movie.get_weekly_chart': { start: movie, verify: nonempty('results') },
  'com.douban.movie.browse_chart': { start: `${movie}/chart`, verify: nonempty('results') },
  'com.douban.movie.get_top250': { start: `${movie}/top250`, verify: nonempty('results') },
  'com.douban.movie.get_doulist': {
    start: movie,
    prepare: async (page) => {
      const href = await page.locator('a[href*="/doulist/"]').first().getAttribute('href')
      const id = href?.match(/doulist\/(\d+)/)?.[1]
      expect(id, 'No real doulist link available').toBeTruthy()
      return { list_id: id }
    },
    verify: async (page, result) => {
      if (result.navigated) await expect(page).toHaveURL(/\/doulist\/\d+/)
      else expect(result.results.length).toBeGreaterThan(0)
    },
  },
  'com.douban.movie.get_comments': {
    start: `${movie}/subject/1292052/`,
    verify: nonempty('comments'),
  },
  'com.douban.movie.get_reviews': {
    start: `${movie}/subject/1292052/`,
    verify: nonempty('reviews'),
  },
  'com.douban.movie.get_current_view': {
    start: `${movie}/subject/1292052/`,
    verify: async (_page, result) => {
      expect(result.is_subject_page).toBe(true)
      expect(result.title).toContain('肖申克')
      expect(result.rating).toMatch(/^\d/)
      expect(result.summary.length).toBeGreaterThan(0)
    },
  },
  'com.douban.movie.get_tv_info': {
    start: `${movie}/subject/25853071/`,
    verify: async (_page, result) => {
      expect(result.subject).toContain('庆余年')
      expect(Number(result.episode_count)).toBe(46)
    },
  },
  'com.douban.movie.search_movies': {
    start: movie,
    args: { query: 'Inception', limit: 5 },
    verify: async (page, result) => {
      expect(result.query).toBe('Inception')
      expect(result.results.length).toBeGreaterThan(0)
      await expect(page).toHaveURL(/search\.douban\.com/)
    },
  },
  'com.douban.movie.open_result': {
    start: `${movie}/subject_search?search_text=Inception&cat=1002`,
    args: { index: 0 },
    verify: navigation(/movie\.douban\.com\/subject\/\d+/),
  },
  'com.douban.search.get_current_view': { start: search, verify: nonempty('results') },
  'com.douban.search.search_movies': {
    start: search,
    args: { query: '肖申克', limit: 5 },
    verify: async (_page, result) => {
      expect(result.query).toBe('肖申克')
      expect(result.results.length).toBeGreaterThan(0)
    },
  },
  'com.douban.search.open_result': {
    start: search,
    args: { index: 0 },
    verify: navigation(/movie\.douban\.com\/subject\/\d+/),
  },
  'com.douban.search.open_subject': {
    start: search,
    args: { subject_id: '1292052' },
    verify: navigation(/\/subject\/1292052\//),
  },
  'com.douban.search.go_movie_site': {
    start: search,
    verify: navigation(/^https:\/\/movie\.douban\.com\/$/),
  },
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

// Every shipped workflow needs an explicit live setup and business assertion.
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
    host = await context.newPage()
    host.on('console', (message) =>
      events.push({ type: 'console', level: message.type(), text: message.text() })
    )
    await host.goto(baseURL)
    await expect(host.locator('body')).not.toBeEmpty({ timeout: 60000 })
    await expect
      .poll(() => host.evaluate(() => !!(window as any).__agentWeb?.ready), { timeout: 30000 })
      .toBe(true)
    console.log('LIVE_SETUP workspace')
    await createWorkspace(host)
    console.log('LIVE_SETUP workspace ready')
    await expect.poll(() => host.evaluate(() => !!(window as any).__agentWeb?.ready)).toBe(true)
    await host.evaluate(() => {
      (window as any).__webmcpE2ECalls = []
      window.addEventListener('message', (event) => {
        if (event.source === window && event.data?.__cwAdapterHost)
          (window as any).__webmcpE2ECalls.push(event.data)
      })
    })
    console.log('LIVE_SETUP OPFS copy')
    // Copy real bundled sources into extension OPFS to exercise the other VFS provider.
    const builtinSources = await readBuiltinPackage(host, 'world.jmail.archive')
    await management.evaluate(async (sources) => {
      const id = 'world.jmail.archive-live'
      const manifest = JSON.parse(sources['manifest.json'])
      const files = [...manifest.tools.map((tool: any) => tool.path), 'readers/dom.js']
      const storage = await navigator.storage.getDirectory()
      const mount = await storage.getDirectoryHandle('webmcp', { create: true })
      const directory = await mount.getDirectoryHandle(id, { create: true })
      const write = async (path: string, text: string) => {
        const parts = path.split('/')
        let folder = directory
        for (const name of parts.slice(0, -1))
          folder = await folder.getDirectoryHandle(name, { create: true })
        const file = await folder.getFileHandle(parts.at(-1)!, { create: true })
        const stream = await file.createWritable()
        await stream.write(text)
        await stream.close()
      }
      for (const path of files)
        await write(
          path,
          sources[path]
        )
      manifest.id = id
      manifest.tools.push({
        name: 'probe_builtin_write',
        description: 'Verify the builtin VFS denies writes',
        urlRegex: manifest.tools[0].urlRegex,
        path: 'workflows/probe_builtin_write.js',
      })
      await write(
        'workflows/probe_builtin_write.js',
        `export default {
        inputSchema: {type: 'object'}, outputSchema: true,
        tree: {type: 'action', async run({state}) {
          const output = await tools.bash({command: "printf '{}' > /external/builtin-webmcp/world.jmail.archive/config.json"});
          state.result = {exitCode: output.exitCode, stderr: output.stderr};
          return 'success';
        }}, result({state}) {return state.result;}
      };`
      )
      await write('manifest.json', JSON.stringify(manifest))
      await write('config.json', '{}')
    }, builtinSources)
    await management.reload()
    await management.getByRole('checkbox', { name: /world\.jmail\.archive-live$/ }).check()
    await expect(management.locator('input.toggle:disabled')).toHaveCount(0)
    await management.close()
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
    try {
      const scenario = scenarios[name]
      await visit(page, scenario.start)
      const prepared = await scenario.prepare?.(page)
      const before = await host.evaluate(() => (window as any).__webmcpE2ECalls.length)
      const result = await invoke(page, name, { ...scenario.args, ...prepared })
      await testInfo.attach('business-result', {
        body: JSON.stringify(result, null, 2),
        contentType: 'application/json',
      })
      await scenario.verify(page, result)
      const calls = await host.evaluate(
        (start) => (window as any).__webmcpE2ECalls.slice(start),
        before
      )
      const invocations = calls.filter((event: any) => event.message.kind === 'invoke')
      expect(
        invocations.length,
        'Workflow did not use the actual workspace tool host'
      ).toBeGreaterThan(0)
      expect(invocations.every((event: any) => event.message.toolName === 'bash')).toBe(true)
      expect(
        invocations.every((event: any) =>
          new RegExp(`--tab=${invokedTabId}(?:\\s|$)`).test(event.message.args.command)
        )
      ).toBe(true)
      await testInfo.attach('result', {
        body: JSON.stringify({ name, result, calls }, null, 2),
        contentType: 'application/json',
      })
    } finally {
      await testInfo.attach('live-diagnostics', {
        body: JSON.stringify({ url: page.url(), network, hostEvents: events }, null, 2),
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
test('OPFS copy uses the same workflow and package-relative VFS readers', async ({}, testInfo) => {
  if (setupError) throw setupError
  const page = await context.newPage()
  try {
    await visit(page, mail)
    const before = await host.evaluate(() => (window as any).__webmcpE2ECalls.length)
    const result = await invoke(page, 'world.jmail.archive-live.list_topics')
    expect(result.topics.length).toBeGreaterThan(0)
    const calls = await host.evaluate(
      (start) => (window as any).__webmcpE2ECalls.slice(start),
      before
    )
    expect(
      calls.some(
        (event: any) =>
          event.message.kind === 'invoke' &&
          event.message.args.command.includes(
            '/external/webmcp/world.jmail.archive-live/readers/dom.js'
          )
      )
    ).toBe(true)
    await testInfo.attach('result', {
      body: JSON.stringify({ result, calls }, null, 2),
      contentType: 'application/json',
    })
  } finally {
    await page.close()
  }
})
test('builtin VFS rejects config writes from the real workspace Bash tool', async () => {
  if (setupError) throw setupError
  const page = await context.newPage()
  try {
    await visit(page, mail)
    const result = await invoke(page, 'world.jmail.archive-live.probe_builtin_write', {}, true)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/EROFS|read.only/i)
  } finally {
    await page.close()
  }
})
