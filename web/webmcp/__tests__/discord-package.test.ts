// @vitest-environment node
import { beforeAll, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { Window } from 'happy-dom'
import { executeAdapterWorkflow } from '../../../browser-extension/entrypoints/webmcp/adapter-runtime'
import { builtinResources } from '../../../browser-extension/entrypoints/webmcp/builtin-resources'
import {
  parseWorkflow,
  validatePackage,
  validatePackageSnapshot,
} from '@creatorweave/shared/webmcp-adapter'
import type { BrowserRequest } from '../../../browser-extension/lib/bash-commands/browser/command'
import type { JsonValue } from '@creatorweave/quickjs-runtime'

let wasm: WebAssembly.Module
beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const runtime = createRequire(require.resolve('@creatorweave/quickjs-runtime/package.json'))
  wasm = await WebAssembly.compile(await readFile(runtime.resolve('quickjs-wasi/quickjs.wasm')))
})

const prefix = 'com.discord.main/'
const manifest = JSON.parse(builtinResources[prefix + 'manifest.json'])

it('validates every package contract and stays below the package snapshot limit', () => {
  const sources = Object.fromEntries(
    manifest.tools.map((tool: { path: string }) => [
      tool.path,
      builtinResources[prefix + tool.path],
    ])
  )
  for (const source of Object.values(sources)) parseWorkflow(source as string)
  validatePackage(manifest, sources, manifest.id)
  const snapshot = Object.entries(builtinResources)
    .filter(([path]) => path.endsWith('/manifest.json'))
    .map(([, source]) => {
      const manifest = JSON.parse(source)
      const sources = Object.fromEntries(
        manifest.tools.map((tool: { path: string }) => [
          tool.path,
          builtinResources[manifest.id + '/' + tool.path],
        ])
      )
      return { manifest, sources }
    })
  expect(() => validatePackageSnapshot(snapshot)).not.toThrow()

  const discordSourceEntries = Object.entries(sources) as Array<[string, string]>
  expect(discordSourceEntries).toHaveLength(8)
  for (const [path, source] of discordSourceEntries) {
    // Navigation-free contract: reject every known page-navigation API,
    // not just location.assign. Navigation belongs to browser.goto.
    expect(source).not.toMatch(/location\s*\.\s*(assign|replace|reload)\s*\(/)
    expect(source).not.toMatch(/location\s*\.\s*href\s*=/)
    expect(source).not.toMatch(/window\s*\.\s*open\s*\(/)
    expect(source).not.toMatch(/document\s*\.\s*write\s*\(/)
    expect(source).toContain('webpackChunkdiscord_app')
    // Round 7: a bare word search would pass a `credentials: 'omit'`
    // regression; the credential mode itself is contracted to 'include' in
    // every workflow's fetch options.
    expect(source).toMatch(/credentials:\s*'include'/)
    // Round 3: one absolute abort deadline per request — the timer must
    // never be re-created after headers arrive (a slow-headers + stalled
    // body request would then outlive the 25s browser-eval timeout).
    // Reject EVERY assignment of a fresh timer to abortTimer, including
    // the ternary re-arm form `abortTimer = cond ? setTimeout(...) : null`
    // that the plain-assignment regex alone let through.
    expect(source.match(/abortTimer\s*=[^\n]*/g) ?? []).toEqual([
      expect.stringMatching(/^abortTimer\s*=\s*(?!\s*abortController)/),
    ])
    // Exactly one setTimeout per non-reaction workflow (the abort
    // deadline); the reaction workflows additionally carry the Round-7
    // cross-tab lock WAIT budget — a second, independent timer so an
    // over-long cross-tab lock wait surfaces as LOCK_TIMEOUT inside the
    // eval window instead of being killed by the host and misreported as
    // TAB_UNAVAILABLE. Both call sites are named and single-purpose: the
    // abort deadline is still assigned exactly once (never re-armed,
    // asserted above), and lockWaitTimer is the only other setTimeout.
    const isReaction = path === 'workflows/add_reaction.js' || path === 'workflows/remove_reaction.js'
    const timerSites = source.match(/setTimeout\s*\(/g) ?? []
    expect(timerSites, path).toHaveLength(isReaction ? 2 : 1)
    if (isReaction) {
      expect(source).toMatch(/lockWaitTimer\s*=\s*setTimeout\s*\(/)
      expect(source).toMatch(/abortTimer\s*=\s*\n?\s*abortController !== null\s*\n?\s*\?\s*setTimeout\s*\(/)
    }
  }

})

it('localizes every tool description across the four supported locales', async () => {
  const readme = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../browser-extension/builtin-webmcp/com.discord.main/README.md'),
    'utf8'
  )
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
    // Bound the locale section at the next heading so a description
    // leaking from a later locale cannot satisfy this locale's coverage.
    const section = (readme.split(`### ${locale}`)[1] ?? '').split(/\n### /)[0]
    expect(section, locale).not.toBe('')
    for (const tool of manifest.tools as Array<{ name: string }>) {
      // Every tool needs its own entry in THIS section with a non-empty
      // description; a bare tool-name mention elsewhere no longer passes.
      const line = section
        .split('\n')
        .find((l) => l.startsWith(`- \`${tool.name}\`:`))
      expect(line, `${locale} ${tool.name} entry`).toBeDefined()
      expect(line!.slice(`- \`${tool.name}\`:`.length).trim().length, `${locale} ${tool.name} description`).toBeGreaterThan(0)
    }
  }
})

type FetchLog = {
  url: string
  init: { method?: string; headers?: Record<string, string>; body?: string; credentials?: string; signal?: AbortSignal }
}

function fixture(options: {
  url?: string
  token?: string | null
  respond?: (url: string, init: FetchLog['init']) => { status: number; body: unknown }
  gate?: (url: string) => Promise<void> | void
  gateBody?: (url: string, init: FetchLog['init']) => Promise<void> | void
  // Per-eval sandbox overrides for tests that must control the in-page
  // clock/timers (the workflow source is untouched; only the sandbox
  // bindings are swapped).
  overrideTimers?: () =>
    | { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; Date?: DateConstructor }
    | undefined
  // Per-eval override for navigator.locks (cross-tab reaction lock tests);
  // undefined keeps the fixture's default "no Web Locks" surface.
  overrideLocks?: () =>
    | { request: (name: string, fn: () => Promise<unknown> | unknown) => Promise<unknown> }
    | undefined
} = {}) {
  const window = new Window({ url: options.url ?? 'https://discord.com/channels/@me' })
  window.document.write('<html><body></body></html>')
  const fetches: FetchLog[] = []
  const token = options.token === undefined ? 'discord-token-xyz' : options.token
  const respond =
    options.respond ??
    ((url: string, init: FetchLog['init']) => {
      let body: unknown = {}
      if (init.method === 'POST' && url.includes('/messages'))
        body = { id: 'm1', channel_id: 'c1', content: 'hello' }
      else if (url.includes('/messages/search'))
        body = { total_results: 1, messages: [[{ id: 'm1', channel_id: 'c1', content: 'hit' }]] }
      else if (url.includes('/guilds/') && url.includes('/channels'))
        body = [{ id: 'ch1', type: 0, guild_id: 'g1', name: 'general', topic: null, position: 0, parent_id: null, nsfw: false }]
      else if (url.includes('/users/@me/guilds'))
        body = [{ id: 'g1', name: 'Guild', icon: null, owner: false, description: null, approximate_member_count: 42 }]
      else if (url.endsWith('/users/@me'))
        body = { id: 'self', username: 'me', bot: false, email: 'me@example.com', verified: true, mfa_enabled: true, locale: 'en-US' }
      else if (url.endsWith('/users/' + encodeURIComponent('u1') + '/profile'))
        // Distinct from /users/@me: a fixture answering any '/users/' URL
        // would let a regression to the bare /users/:id endpoint still pass
        // the profile assertions below.
        body = { user: { id: 'u1', username: 'tester', global_name: 'Tester', bot: false, banner: null }, user_profile: { bio: 'bio text' } }
      else if (url.includes('/messages'))
        body = [{ id: 'm1', channel_id: 'c1', content: 'hello', author: { id: 'u1', username: 'tester' } }]
      return { status: 200, body }
    })
  const pageGlobals: Record<string, unknown> = {
    fetch: async (url: string, init: FetchLog['init'] = {}) => {
      fetches.push({ url, init })
      if (options.gate) await options.gate(url)
      const outcome = respond(url, init)
      const headers = new Map<string, string>([['content-type', 'application/json']])
      const signal = init.signal
      const throwIfAborted = () => {
        if (signal?.aborted) {
          const e = new Error('The operation was aborted')
          e.name = 'AbortError'
          throw e
        }
      }
      return {
        ok: outcome.status >= 200 && outcome.status < 300,
        status: outcome.status,
        headers: { get: (key: string) => headers.get(key) ?? null },
        // Body consumption checks the abort signal, like a real stalled
        // body does: a fired deadline abort rejects even after headers.
        text: async () => {
          if (options.gateBody) await options.gateBody(url, init)
          throwIfAborted()
          return JSON.stringify(outcome.body)
        },
        json: async () => {
          if (options.gateBody) await options.gateBody(url, init)
          throwIfAborted()
          return outcome.body
        },
      }
    },
    AbortSignal: globalThis.AbortSignal,
  }
  if (token !== null) {
    // Emulate Discord's webpack chunk array: push([ids], {}, requireCallback) runs the callback
    // with a require whose `c` is a fixture-controlled module registry.
    const modules: Record<string, { exports: Record<string, unknown> }> = token
      ? { mod: { exports: { default: { getToken: () => token } } } }
      : {}
    ;(window as unknown as { webpackChunkdiscord_app: unknown }).webpackChunkdiscord_app = {
      push: (entry: [number[], unknown, (require: { c: Record<string, unknown> }) => void]) => {
        entry[2]({ c: modules })
      },
    }
  }
  const pageSandbox: Record<string, unknown> = {
    webpackChunkdiscord_app: (window as unknown as { webpackChunkdiscord_app?: unknown[] }).webpackChunkdiscord_app,
  }
  // happy-dom's navigator may expose a Web Locks API surface; the workflows
  // take a cross-tab lock path when navigator.locks.request exists, so the
  // sandbox navigator stays WITHOUT locks unless a test explicitly provides
  // one — the fixture models the QuickJS eval harness, which has none.
  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    get: () => options.overrideLocks?.() ?? undefined,
  })
  // In-memory localStorage shim shared by every eval of this fixture: it
  // emulates the per-origin storage the workflow uses as the cross-tab
  // retry store. Created EAGERLY so tests can seed it before the first
  // eval; a test that needs two "tabs" seeds a SECOND fixture's shim with
  // the first one's snapshot via page.sandbox.__localStorage.
  {
    const backing = new Map<string, string>()
    pageSandbox.__localStorage = {
      getItem: (key: string) => (backing.has(key) ? backing.get(key)! : null),
      setItem: (key: string, value: string) => {
        backing.set(key, String(value))
      },
      removeItem: (key: string) => {
        backing.delete(key)
      },
      clear: () => backing.clear(),
    }
  }
  let evalCount = 0
  const execute = async (name: string, input: Record<string, unknown> = {}): Promise<any> => {
    const tool = manifest.tools.find((tool: { name: string }) => tool.name === name)
    evalCount++
    return executeAdapterWorkflow(
      wasm,
      builtinResources[prefix + tool.path],
      input as JsonValue,
      browser,
      new AbortController().signal,
      { tabId: 9, url: window.location.href }
    )
  }
  const browser = async (request: BrowserRequest): Promise<JsonValue> => {
    expect(request.options.tab).toBe('9')
    if (request.command === 'eval') {
      const overrides = options.overrideTimers?.() ?? undefined
      const result = await runInNewContext(`(${request.positionals[0]})()`, {
        window,
        setTimeout: overrides?.setTimeout ?? setTimeout,
        clearTimeout: overrides?.clearTimeout ?? clearTimeout,
        document: window.document,
        location: window.location,
        URL,
        URLSearchParams,
        navigator: window.navigator,
        localStorage: pageSandbox.__localStorage,
        fetch: pageGlobals.fetch,
        AbortController,
        AbortSignal: globalThis.AbortSignal,
        JSON,
        Math,
        Object,
        Array,
        String,
        Number,
        Boolean,
        Date: overrides?.Date ?? Date,
        Promise,
        Error,
        globalThis: pageSandbox,
      })
      return { tabId: 9, result: JSON.parse(JSON.stringify(result ?? null)) }
    }
    return { tabId: 9 }
  }
  return { execute, window, fetches, sandbox: pageSandbox, browser, evalCount: () => evalCount }
}

it('extracts the token through the webpack walk and reads channel messages', async () => {
  const page = fixture()
  // The webpack walk pushes a probing chunk; stub require.c with one token module.
  let pushedEntry: unknown = null
  ;(page.window as any).webpackChunkdiscord_app.push = (entry: unknown) => {
    pushedEntry = entry
    const requireCallback = (entry as [number[], unknown, (require: { c: unknown }) => void])[2]
    requireCallback({
      c: {
        mod1: { exports: { default: { getToken: () => ({ locale: 'en-US' }) } } }, // i18n-shaped: skipped
        mod2: { exports: { default: { getToken: () => 'discord-token-xyz' } } },
        mod3: { exports: {} },
      },
    })
  }
  const result = await page.execute('read_messages', { channel: '123', limit: 3 })
  expect(result).toMatchObject({ ok: true, value: { status: 'success' } })
  expect(pushedEntry).not.toBeNull()
  expect(page.fetches).toHaveLength(1)
  expect(page.fetches[0].url).toBe('https://discord.com/api/v9/channels/123/messages?limit=3')
  expect(page.fetches[0].init).toMatchObject({
    method: 'GET',
    credentials: 'include',
    headers: { Authorization: 'discord-token-xyz' },
  })
  expect(result.value.result.data.messages[0]).toMatchObject({
    id: 'm1',
    channel_id: 'c1',
    author: { id: 'u1', username: 'tester' },
  })
})

it('returns UNAUTHENTICATED when the walk fails after a token was cached', async () => {
  const page = fixture()
  let walkYieldsToken = true
  ;(page.window as any).webpackChunkdiscord_app.push = (entry: unknown) => {
    const requireCallback = (entry as [number[], unknown, (require: { c: unknown }) => void])[2]
    requireCallback({
      c: walkYieldsToken
        ? { mod: { exports: { default: { getToken: () => 'discord-token-xyz' } } } }
        : {},
    })
  }
  await page.execute('list_guilds', {})
  // The walk now FAILS (webpack gone, e.g. mid-navigation). A cached token
  // can no longer be confirmed to belong to the CURRENT account while the
  // probe is unavailable — an account switch in exactly this window must
  // never reuse the previous credential — so the workflow fails closed
  // with UNAUTHENTICATED instead of falling back to the cache.
  delete page.sandbox.webpackChunkdiscord_app
  const result = await page.execute('list_guilds', {})
  expect(result).toMatchObject({
    ok: true,
    value: { result: { status: 'error', error_code: 'UNAUTHENTICATED' } },
  })
  expect(page.fetches).toHaveLength(1)
  expect(page.fetches[0].init.headers).toMatchObject({ Authorization: 'discord-token-xyz' })
})

it('does not use a stale cached token after logout or account switch', async () => {
  const page = fixture()
  let currentToken: string | null = 'token-account-a'
  ;(page.window as any).webpackChunkdiscord_app.push = (entry: unknown) => {
    const requireCallback = (entry as [number[], unknown, (require: { c: unknown }) => void])[2]
    requireCallback({
      c: currentToken
        ? { mod: { exports: { default: { getToken: () => currentToken } } } }
        : {},
    })
  }
  await page.execute('list_guilds', {})
  expect(page.fetches[0].init.headers).toMatchObject({ Authorization: 'token-account-a' })
  // The user logs out IN the still-loaded tab: the walk runs and finds no
  // token. The cached previous-account credential must NOT be used.
  currentToken = null
  const loggedOut = await page.execute('list_guilds', {})
  expect(loggedOut.value.result.error_code).toBe('UNAUTHENTICATED')
  expect(page.fetches).toHaveLength(1)
  // The logout must also drop the cache: if webpack then disappears
  // entirely (next call's walk cannot even run), the previous account's
  // token must NOT come back via the missing-webpack fallback.
  delete page.sandbox.webpackChunkdiscord_app
  const gone = await page.execute('list_guilds', {})
  expect(gone.value.result.error_code).toBe('UNAUTHENTICATED')
  expect(page.fetches).toHaveLength(1)
})

it('fails closed when the probe chunk callback never runs', async () => {
  const page = fixture()
  // First call: normal walk caches the live token.
  await page.execute('list_guilds', {})
  expect(page.fetches[0].init.headers).toMatchObject({ Authorization: 'discord-token-xyz' })
  // Webpack is mid-update: the chunk global is present and push works,
  // but the injected callback never runs (getTokenFromWebpack.done stays
  // false). The probe is INCOMPLETE, so the cached token cannot be
  // confirmed to belong to the current account — the workflow must fail
  // closed with UNAUTHENTICATED instead of risking the previous
  // account's credential, even though the failure is transient.
  ;(page.window as any).webpackChunkdiscord_app.push = () => {}
  const stuck = await page.execute('list_guilds', {})
  expect(stuck).toMatchObject({
    ok: true,
    value: { result: { status: 'error', error_code: 'UNAUTHENTICATED' } },
  })
  expect(page.fetches).toHaveLength(1)
})

it('removes its probe chunk so repeated lookups do not accumulate entries', async () => {
  const page = fixture()
  // Real Discord's webpackChunkdiscord_app is a plain array whose push()
  // invokes the injected callback and RETAINS the entry for the tab
  // lifetime. Model exactly that: a real array (so indexOf/splice behave)
  // with webpack's push semantics.
  const chunks: unknown[] = []
  // Model an ALREADY-INITIALIZED tab: webpack's real entries are present
  // before the first probe. A cleanup that clears the whole array (instead
  // of splicing out only its own probe entry) would silently drop these
  // real chunks — a regression the previous empty-start fixture could not
  // catch, because empty == empty either way. Pushed via the REAL array
  // method so it bypasses the probe-instrumented push installed below.
  const sentinel: unknown[] = [1, {}]
  Array.prototype.push.call(chunks, sentinel)
  expect(chunks).toContain(sentinel)
  chunks.push = function (this: unknown[], entry: unknown) {
    Array.prototype.push.call(this, entry)
    const requireCallback = (entry as [number[], unknown, (require: { c: unknown }) => void])[2]
    requireCallback({ c: { mod: { exports: { default: { getToken: () => 'discord-token-xyz' } } } } })
  } as typeof chunks.push
  ;(page.window as any).webpackChunkdiscord_app = chunks
  ;(page.sandbox as any).webpackChunkdiscord_app = chunks
  for (let i = 0; i < 3; i++) await page.execute('list_guilds', {})
  // Each walk pushed one probe chunk and the workflow spliced ONLY its own
  // entry back out: the sentinel webpack entry survives all three walks
  // untouched and nothing accumulates beyond it. (Spread first: the
  // instrumented push is an own property the array still carries.)
  expect([...chunks]).toEqual([sentinel])
  expect(chunks.indexOf(sentinel)).toBe(0)
  // All three calls still succeeded with the live token.
  expect(page.fetches).toHaveLength(3)
})

it('sends messages and reactions through the right methods and bodies', async () => {
  const page = fixture()
  const sent = await page.execute('send_message', {
    channel: '555',
    content: 'hello world',
    reply_to: 'm0',
  })
  expect(sent).toMatchObject({
    ok: true,
    value: {
      result: { status: 'ok', data: { message: { id: 'm1' }, dedup_scope: 'cross-tab' } },
    },
  })
  expect(page.fetches[0]).toMatchObject({
    url: 'https://discord.com/api/v9/channels/555/messages',
  })
  expect(page.fetches[0].init).toMatchObject({ method: 'POST', credentials: 'include' })
  expect(JSON.parse(page.fetches[0].init.body!)).toEqual({
    content: 'hello world',
    nonce: expect.any(String),
    enforce_nonce: true,
    message_reference: { message_id: 'm0' },
  })

  page.fetches.length = 0
  expect(await page.execute('add_reaction', { channel: '555', message_id: 'm1', emoji: '👍' })).toMatchObject({
    ok: true,
    value: { result: { status: 'ok', data: { added: true } } },
  })
  expect(page.fetches[0]).toMatchObject({
    url: 'https://discord.com/api/v9/channels/555/messages/m1/reactions/%F0%9F%91%8D/@me',
  })
  // Round 7: the credential mode is asserted on the EXECUTED fetch options,
  // not just the source text.
  expect(page.fetches[0].init.credentials).toBe('include')

  page.fetches.length = 0
  expect(await page.execute('remove_reaction', { channel: '555', message_id: 'm1', emoji: 'thumbsup:123' })).toMatchObject({
    ok: true,
    value: { result: { status: 'ok', data: { removed: true } } },
  })
  expect(page.fetches[0]).toMatchObject({
    url: 'https://discord.com/api/v9/channels/555/messages/m1/reactions/thumbsup%3A123/@me',
  })
  expect(page.fetches[0].init.method).toBe('DELETE')
  expect(page.fetches[0].init.credentials).toBe('include')
})

it('maps guild, channel, profile and search responses', async () => {
  const page = fixture()
  const guilds = await page.execute('list_guilds', {})
  expect(guilds.value.result.data.guilds[0]).toEqual({
    id: 'g1',
    name: 'Guild',
    icon: null,
    owner: false,
    description: null,
    approximate_member_count: 42,
  })
  const channels = await page.execute('list_channels', { guild_id: 'g1' })
  expect(channels.value.result.data.channels[0]).toEqual({
    id: 'ch1',
    type: 0,
    guild_id: 'g1',
    name: 'general',
    topic: null,
    position: 0,
    parent_id: null,
    nsfw: false,
  })
  expect(channels.value.result.data.channels[0]).toHaveProperty('nsfw', false)
  const profile = await page.execute('get_user_profile', { user_id: 'u1' })
  expect(profile.value.result.data.user).toMatchObject({ id: 'u1', username: 'tester', bio: 'bio text' })
  expect(profile.value.result.data.user).not.toHaveProperty('email')
  expect(profile.value.result.data).not.toHaveProperty('email')
  expect(profile.value.result.data.profile_source).toBe('users/:id/profile')
  // Route regression guard: the non-self profile request must hit
  // /users/:id/profile exactly — the bare /users/:id endpoint exposes no
  // bio and would break the mapping contract.
  const profileFetch = page.fetches.find((f) => f.url.includes('/users/u1'))
  expect(new URL(profileFetch!.url).pathname).toBe('/api/v9/users/u1/profile')
  const me = await page.execute('get_user_profile', { user_id: '@me' })
  expect(me.value.result.data.user).toMatchObject({ id: 'self', username: 'me' })
  // Private account fields never reach tool output, even for '@me'.
  expect(me.value.result.data).not.toHaveProperty('email')
  expect(me.value.result.data).not.toHaveProperty('mfa_enabled')
  expect(me.value.result.data).not.toHaveProperty('verified')
  expect(me.value.result.data.profile_source).toBe('users/@me')
  const search = await page.execute('search_messages', { guild_id: 'g1', content: 'hit' })
  expect(search.value.result.data).toMatchObject({ total_results: 1 })
  expect(search.value.result.data.messages[0][0]).toMatchObject({ id: 'm1', content: 'hit' })
  const searchFetch = page.fetches.find((f) => f.url.includes('/messages/search'))
  const searchUrl = new URL(searchFetch!.url)
  expect(searchUrl.origin + searchUrl.pathname).toBe(
    'https://discord.com/api/v9/guilds/g1/messages/search',
  )
  expect(searchUrl.searchParams.get('content')).toBe('hit')
})

it('rejects combined pagination cursors before touching the API', async () => {
  const page = fixture()
  const bad = await page.execute('read_messages', { channel: '123', before: '10', after: '20' })
  expect(bad).toMatchObject({
    ok: true,
    value: {
      result: {
        status: 'error',
        error_code: 'VALIDATION',
      },
    },
  })
  expect(bad.value.result.message).toContain('only one of before, after or around')
  expect(page.fetches).toHaveLength(0)
  const good = await page.execute('read_messages', { channel: '123', before: '10' })
  expect(good.value.result.status).toBe('ok')
  const cursorUrl = new URL(page.fetches[0].url)
  expect(cursorUrl.origin + cursorUrl.pathname).toBe(
    'https://discord.com/api/v9/channels/123/messages',
  )
  expect(cursorUrl.searchParams.get('before')).toBe('10')
  expect([...cursorUrl.searchParams.keys()].sort()).toEqual(['before', 'limit'])
})

it('gates on an unauthenticated or non-discord tab with a clear error instead of hanging', async () => {
  const noToken = fixture({ token: null })
  const result = await noToken.execute('read_messages', { channel: '123' })
  expect(result).toMatchObject({
    ok: true,
    value: {
      result: {
        status: 'error',
        data: null,
        error_code: 'UNAUTHENTICATED',
      },
    },
  })
  expect(result.value.result.message).toContain('log in')
  expect(noToken.fetches).toHaveLength(0)

  const wrongSite = fixture({ url: 'https://example.com/' })
  const wrong = await wrongSite.execute('send_message', { channel: '1', content: 'x' })
  expect(wrong).toMatchObject({
    ok: true,
    value: { result: { status: 'error', error_code: 'UNSUPPORTED_PAGE' } },
  })
  expect(wrongSite.fetches).toHaveLength(0)
})

it('classifies Discord API error codes into stable error codes', async () => {
  const page = fixture({
    respond: (url) =>
      url.includes('/channels/missing/')
        ? { status: 404, body: { code: 10003, message: 'Unknown Channel' } }
        : url.includes('/forbidden')
          ? { status: 403, body: { code: 50013, message: 'Missing Permissions' } }
          : { status: 200, body: [] },
  })
  await page.window.happyDOM.setURL('https://discord.com/channels/missing')
  // Code 10003 must classify as NOT_FOUND: hitting the /missing fixture
  // directly proves the mapping, not just the 50013 branch.
  const missing = await page.execute('read_messages', { channel: 'missing' })
  expect(missing).toMatchObject({
    ok: true,
    value: {
      result: {
        status: 'error',
        error_code: 'NOT_FOUND',
      },
    },
  })
  expect(missing.value.result.message).toContain('(code 10003)')
  // Code 50013 is a permission denial: it gets its own FORBIDDEN class so
  // callers can tell it apart from invalid input.
  const denied = await page.execute('read_messages', { channel: 'forbidden' })
  expect(denied).toMatchObject({
    ok: true,
    value: {
      result: {
        status: 'error',
        error_code: 'FORBIDDEN',
      },
    },
  })
  expect(denied.value.result.message).toContain('(code 50013)')
})

it('keeps the cached token on a coded 403 but clears it on any 401', async () => {
  const page = fixture({
    respond: (url) =>
      url.includes('/channels/forbidden/')
        ? { status: 403, body: { code: 50013, message: 'Missing Permissions' } }
        : { status: 401, body: { code: 50012, message: 'Unknown session' } },
  })
  let walkYieldsToken = true
  ;(page.window as any).webpackChunkdiscord_app.push = (entry: unknown) => {
    const requireCallback = (entry as [number[], unknown, (require: { c: unknown }) => void])[2]
    requireCallback({
      c: walkYieldsToken
        ? { mod: { exports: { default: { getToken: () => 'discord-token-xyz' } } } }
        : {},
    })
  }
  await page.window.happyDOM.setURL('https://discord.com/channels/forbidden')
  const denied = await page.execute('read_messages', { channel: 'forbidden' })
  expect(denied).toMatchObject({
    ok: true,
    value: { result: { status: 'error', error_code: 'FORBIDDEN' } },
  })
  expect(denied.value.result.message).toContain('(code 50013)')
  // Permission denial keeps the token cached: no re-auth, no walk needed.
  // Assert the page-global cache DIRECTLY, immediately after the 403 —
  // the next call would re-read the same token from the walk either way,
  // so code that wrongly clears the cache on a coded 403 must fail HERE.
  expect(page.sandbox.__eo2DiscordToken).toBe('discord-token-xyz')

  // Now the walk runs against a LIVE webpack token and Discord rejects it
  // with a coded 401 whose code (50012) is NOT in AUTH_ERRORS: the
  // caller-visible contract must still be AUTH, with the code kept as
  // diagnostic detail.
  await page.window.happyDOM.setURL('https://discord.com/channels/expired')
  const expired = await page.execute('read_messages', { channel: 'expired' })
  expect(expired).toMatchObject({
    ok: true,
    value: { result: { status: 'error', error_code: 'AUTH' } },
  })
  expect(expired.value.result.message).toContain('(code 50012)')
  // The 401 handler must EVICT the page-global cache, not merely record
  // the token in the rejected set — a regression that only suppresses the
  // token would still pass the behavioral assertions below.
  expect(page.sandbox.__eo2DiscordToken).toBeUndefined()
  // The rejected token is fully invalidated: the next call neither uses
  // the cache nor re-reads the same webpack token — it goes UNAUTHENTICATED
  // without another fetch (the 403 and the 401 each fetched once).
  const again = await page.execute('read_messages', { channel: 'expired' })
  expect(again.value.result.error_code).toBe('UNAUTHENTICATED')
  expect(again.value.result.message).toContain('log in')
  expect(page.fetches).toHaveLength(2)
})

it('classifies an uncoded HTTP 401 as AUTH without touching the API', async () => {
  // Discord (or an intermediary) returns 401 with a non-JSON body: the
  // uncoded branch must also surface AUTH.
  const page = fixture({
    respond: () => ({ status: 401, body: 'Unauthorized' }),
  })
  const result = await page.execute('read_messages', { channel: 'c' })
  expect(result).toMatchObject({
    ok: true,
    value: { result: { status: 'error', error_code: 'AUTH' } },
  })
  expect(result.value.result.message).toContain('401')
})

it('does not reuse a rejected webpack token but accepts a fresh one', async () => {
  const page = fixture({
    respond: (url) =>
      url.includes('/channels/expired/')
        ? { status: 401, body: { code: 50012, message: 'Unknown session' } }
        : { status: 200, body: [] },
  })
  let currentToken = 'discord-token-xyz'
  ;(page.window as any).webpackChunkdiscord_app.push = (entry: unknown) => {
    const requireCallback = (entry as [number[], unknown, (require: { c: unknown }) => void])[2]
    requireCallback({
      c: { mod: { exports: { default: { getToken: () => currentToken } } } },
    })
  }
  await page.window.happyDOM.setURL('https://discord.com/channels/expired')
  // The live webpack token is sent and Discord rejects it with 401.
  const expired = await page.execute('read_messages', { channel: 'expired' })
  expect(expired.value.result.message).toContain('(code 50012)')
  // The SAME token must not be sent again even though the walk finds it.
  const resent = await page.execute('read_messages', { channel: 'expired' })
  expect(resent.value.result.error_code).toBe('UNAUTHENTICATED')
  expect(page.fetches).toHaveLength(1)
  // A DIFFERENT token (re-login / account switch) is accepted immediately.
  currentToken = 'fresh-account-token'
  const fresh = await page.execute('read_messages', { channel: 'ok' })
  expect(fresh.value.result.status).toBe('ok')
  expect(page.fetches[1].init.headers).toMatchObject({ Authorization: 'fresh-account-token' })
})

it('keeps a newer cached token when a stale in-flight 401 arrives', async () => {
  // The stale request resolves only when this gate is opened, so the 401
  // lands AFTER the newer token has been cached.
  let releaseStale: (() => void) | null = null
  const staleGate = new Promise<void>((resolve) => {
    releaseStale = resolve
  })
  const page = fixture({
    respond: (url) =>
      url.includes('/channels/stale/')
        ? { status: 401, body: { code: 50012, message: 'Unknown session' } }
        : { status: 200, body: [] },
    gate: (url) => (url.includes('/channels/stale/') ? staleGate : undefined),
  })
  let currentToken = 'token-account-a'
  ;(page.window as any).webpackChunkdiscord_app.push = (entry: unknown) => {
    const requireCallback = (entry as [number[], unknown, (require: { c: unknown }) => void])[2]
    requireCallback({
      c: { mod: { exports: { default: { getToken: () => currentToken } } } },
    })
  }
  // Cache account A's token.
  await page.execute('read_messages', { channel: 'ok' })
  expect(page.fetches[0].init.headers).toMatchObject({ Authorization: 'token-account-a' })
  // An older request still authenticated as account A is IN FLIGHT: it has
  // passed token lookup (sent with A) but is held at the gate.
  const staleA = page.execute('read_messages', { channel: 'stale' })
  await vi.waitFor(() => {
    expect(page.fetches).toHaveLength(2)
    expect(page.fetches[1].init.headers).toMatchObject({ Authorization: 'token-account-a' })
  })
  // Account switch: token B is now the cached live credential.
  currentToken = 'token-account-b'
  const asB = await page.execute('read_messages', { channel: 'ok' })
  expect(asB.value.result.status).toBe('ok')
  expect(page.fetches[2].init.headers).toMatchObject({ Authorization: 'token-account-b' })
  // NOW the stale A request resolves with a coded 401. The eviction must
  // remove only A's token and leave B's cache entry intact. (A coded 401
  // surfaces as AUTH regardless of the Discord code.)
  releaseStale!()
  const stale = await staleA
  expect(stale).toMatchObject({
    ok: true,
    value: { result: { status: 'error', error_code: 'AUTH' } },
  })
  expect(stale.value.result.message).toContain('(code 50012)')
  // The eviction must have left the page-global cache holding B's token:
  // value-keyed means A's stale 401 cannot touch B's entry, and the
  // logged-out marker must NOT have been set (B is still the cached live
  // credential, readable by any later call in this tab).
  expect(page.sandbox.__eo2DiscordToken).toBe('token-account-b')
  expect(page.sandbox.__eo2DiscordLoggedOut).toBeUndefined()
  // B is still cached — but the cache is now unreachable: a stale 401
  // recorded B's predecessor's token value... in fact the eviction is
  // value-keyed so B's entry survives, yet B can only be REUSED when the
  // probe can confirm it against the live webpack token, which is gone.
  // The fail-closed rule therefore yields UNAUTHENTICATED here rather
  // than sending B unconfirmed.
  delete page.sandbox.webpackChunkdiscord_app
  const after = await page.execute('read_messages', { channel: 'ok' })
  expect(after).toMatchObject({
    ok: true,
    value: { result: { status: 'error', error_code: 'UNAUTHENTICATED' } },
  })
  expect(page.fetches).toHaveLength(3)
})

it('does not let a stale in-flight 401 re-enable a newer rejected token', async () => {
  // Token B's request 401s while an older in-flight request for token A
  // is still stalled at the gate: A's late marker write must not
  // overwrite B's rejection (which would re-enable B on the next call).
  let releaseStale: (() => void) | null = null
  const staleGate = new Promise<void>((resolve) => {
    releaseStale = resolve
  })
  const page = fixture({
    respond: (url) =>
      url.includes('/channels/stale/') || url.includes('/channels/expired/')
        ? { status: 401, body: { code: 50012, message: 'Unknown session' } }
        : { status: 200, body: [] },
    gate: (url) => (url.includes('/channels/stale/') ? staleGate : undefined),
  })
  let currentToken = 'token-account-a'
  ;(page.window as any).webpackChunkdiscord_app.push = (entry: unknown) => {
    const requireCallback = (entry as [number[], unknown, (require: { c: unknown }) => void])[2]
    requireCallback({
      c: { mod: { exports: { default: { getToken: () => currentToken } } } },
    })
  }
  // Cache account A's token with a successful call.
  await page.execute('read_messages', { channel: 'ok' })
  // Stale request for A is IN FLIGHT at the gate.
  const staleA = page.execute('read_messages', { channel: 'stale' })
  await vi.waitFor(() => expect(page.fetches).toHaveLength(2))
  // Switch to B; its request 401s immediately and B becomes the marker.
  currentToken = 'token-account-b'
  const asB = await page.execute('read_messages', { channel: 'expired' })
  expect(asB.value.result.error_code).toBe('AUTH')
  // NOW A's stale 401 lands. It must NOT erase B's rejection: B is still
  // suppressed, and BOTH tokens stay in the rejected set.
  releaseStale!()
  const stale = await staleA
  expect(stale.value.result.error_code).toBe('AUTH')
  // The rejected set still holds B: with the live walk finding B again,
  // the token stays suppressed (UNAUTHENTICATED, no fetch) instead of B
  // being resent. Reverting to A is ALSO blocked — A was rejected too
  // (per-token tracking keeps both rejections). Only a genuinely fresh
  // token is accepted.
  const resent = await page.execute('read_messages', { channel: 'ok' })
  expect(resent.value.result.error_code).toBe('UNAUTHENTICATED')
  expect(page.fetches).toHaveLength(3)
  currentToken = 'token-account-a'
  const backToA = await page.execute('read_messages', { channel: 'ok' })
  expect(backToA.value.result.error_code).toBe('UNAUTHENTICATED')
  expect(page.fetches).toHaveLength(3)
  currentToken = 'token-account-c'
  const fresh = await page.execute('read_messages', { channel: 'ok' })
  expect(fresh.value.result.status).toBe('ok')
  expect(page.fetches[3].init.headers).toMatchObject({ Authorization: 'token-account-c' })
})

it('keeps the cached token and the auth state on HTTP 429', async () => {
  let rateLimited = true
  const page = fixture({
    respond: () =>
      rateLimited
        ? { status: 429, body: { code: 0, message: 'You are being rate limited.' } }
        : { status: 200, body: [] },
  })
  let walkYieldsToken = true
  ;(page.window as any).webpackChunkdiscord_app.push = (entry: unknown) => {
    const requireCallback = (entry as [number[], unknown, (require: { c: unknown }) => void])[2]
    requireCallback({
      c: walkYieldsToken
        ? { mod: { exports: { default: { getToken: () => 'discord-token-xyz' } } } }
        : {},
    })
  }
  const limited = await page.execute('read_messages', { channel: '123' })
  expect(limited).toMatchObject({
    ok: true,
    value: { result: { status: 'error', error_code: 'RATE_LIMITED' } },
  })
  // The 429 must not have touched the page-global cache: the token stays
  // cached and no logged-out marker was recorded, so the credential is
  // intact for the next call (verify directly, before the walk is
  // disabled — after that the cache becomes unreachable and a wrongly
  // cleared cache would be indistinguishable from fail-closed).
  expect(page.sandbox.__eo2DiscordToken).toBe('discord-token-xyz')
  expect(page.sandbox.__eo2DiscordLoggedOut).toBeUndefined()
  // After the rate limit, the walk FAILS (transient hydration window). A
  // cached token cannot be confirmed to belong to the current account
  // while the probe is down, so the workflow fails closed — a 429 never
  // rejected the credential, but the fail-closed rule still applies (and
  // the cache was never deleted by the 429 itself).
  rateLimited = false
  delete page.sandbox.webpackChunkdiscord_app
  const next = await page.execute('read_messages', { channel: '123' })
  expect(next).toMatchObject({
    ok: true,
    value: { result: { status: 'error', error_code: 'UNAUTHENTICATED' } },
  })
  expect(page.fetches).toHaveLength(1)
})

it('threads a caller-supplied nonce through send_message', async () => {
  const page = fixture()
  await page.execute('send_message', { channel: '555', content: 'x', nonce: 'my-nonce-1' })
  expect(JSON.parse(page.fetches[0].init.body!).nonce).toBe('my-nonce-1')
})

it('rejects nonces longer than the Discord 25-char limit at the schema boundary', async () => {
  const page = fixture()
  const longNonce = 'n'.repeat(26)
  expect((await page.execute('send_message', { channel: '1', content: 'x', nonce: longNonce })).ok).toBe(false)
  expect(page.fetches).toHaveLength(0)
  expect((await page.execute('send_message', { channel: '1', content: 'x', nonce: 'n'.repeat(25) })).ok).toBe(true)
})

it('reports degraded tab-only dedup when localStorage throws', async () => {
  // Finding: the cross-tab mirror swallows localStorage failures, so a
  // retry routed to a DIFFERENT tab silently loses dedup. Storage access
  // is now suspender-wrapped and a storage throw surfaces as
  // data.dedup_scope === 'tab' while the send itself still succeeds.
  const page = fixture()
  // Suspend storage: the FIRST setItem throws (at persist time, after the
  // nonce lookup), then storage recovers.
  const storage = page.sandbox.__localStorage as { setItem: (k: string, v: string) => void }
  const originalSetItem = storage.setItem.bind(storage)
  let threw = false
  storage.setItem = (k: string, v: string) => {
    if (!threw) {
      threw = true
      throw new Error('SecurityError: storage disabled')
    }
    originalSetItem(k, v)
  }
  const input = { channel: '555', content: 'degraded dedup' }
  const result = await page.execute('send_message', input)
  expect(result.ok).toBe(true)
  expect(result.value.result.status).toBe('ok')
  expect(result.value.result.data.dedup_scope).toBe('tab')
  // The nonce was still minted and posted (visible through the fetch log;
  // in-page globalThis writes stay inside QuickJS and are not host-visible).
  const nonce = JSON.parse(page.fetches[0].init.body!).nonce as string
  expect(nonce).toMatch(/.+-[0-9a-z]+/)
  expect(page.fetches).toHaveLength(1)
  // The page also echoes the degradation through args so the adapter
  // annotates the result message of every path — verified on the ERROR
  // (unconfirmed send) path, where a caller retry must know another tab
  // cannot see the remembered nonce.
  const failing = fixture({
    respond: () => ({ status: 500, body: 'Internal Server Error' }),
  })
  const failingStorage = failing.sandbox.__localStorage as { setItem: (k: string, v: string) => void }
  const failingOriginal = failingStorage.setItem.bind(failingStorage)
  let failingThrew = false
  failingStorage.setItem = (k: string, v: string) => {
    if (!failingThrew) {
      failingThrew = true
      throw new Error('SecurityError: storage disabled')
    }
    failingOriginal(k, v)
  }
  const failingResult = await failing.execute('send_message', { channel: '555', content: 'degraded error path' })
  expect(failingResult.value.result.status).toBe('error')
  expect(failingResult.value.result.message).toContain('cross-tab retry dedup is degraded')
  // With storage healthy, a normal delivery reports cross-tab and no note.
  const healthy = await page.execute('send_message', { channel: '555', content: 'healthy dedup' })
  expect(healthy.value.result.data.dedup_scope).toBe('cross-tab')
  expect(healthy.value.result.message).toBeNull()
}, 15000)

it('reuses the auto-generated nonce on retry and mints a fresh one after a confirmed delivery', async () => {
  const page = fixture({
    respond: (url) =>
      url.includes('/channels/555/')
        ? // Uncoded 500: a pure server failure — outcome unknown, token
          // untouched, so the send is genuinely "unconfirmed".
          { status: 500, body: 'Internal Server Error' }
        : { status: 200, body: [] },
  })
  const input = { channel: '555', content: 'hello world', reply_to: 'm0' }
  // First send FAILS (outcome unknown from Discord's perspective): the
  // nonce must be remembered so the retry is deduped, not posted twice.
  const first = await page.execute('send_message', input)
  expect(first.value.result.status).toBe('error')
  const firstNonce = JSON.parse(page.fetches[0].init.body!).nonce as string
  expect(firstNonce).toMatch(/.+-[0-9a-z]+/)
  // Retry after the failure: the remembered nonce makes Discord dedupe.
  await page.execute('send_message', input)
  expect(JSON.parse(page.fetches[1].init.body!).nonce).toBe(firstNonce)
  // Retries of different sends do not evict each other: the nonce map is
  // keyed per (channel, reply, content), not one last-send slot.
  const inputB = { channel: '555', content: 'second message', reply_to: 'm0' }
  await page.execute('send_message', inputB)
  const nonceB = JSON.parse(page.fetches[2].init.body!).nonce as string
  expect(nonceB).not.toBe(firstNonce)
  await page.execute('send_message', input)
  expect(JSON.parse(page.fetches[3].init.body!).nonce).toBe(firstNonce)
  // A caller-supplied nonce always wins over the remembered one.
  await page.execute('send_message', { ...input, nonce: 'caller-nonce' })
  expect(JSON.parse(page.fetches[4].init.body!).nonce).toBe('caller-nonce')

  // Confirmed delivery: the remember entry is DELETED on success, so an
  // intentional identical resend mints a FRESH nonce and posts a new
  // message instead of being silently deduped by Discord.
  const page2 = fixture()
  await page2.execute('send_message', input)
  const deliveredNonce = JSON.parse(page2.fetches[0].init.body!).nonce as string
  await page2.execute('send_message', input)
  expect(JSON.parse(page2.fetches[1].init.body!).nonce).not.toBe(deliveredNonce)
})

it('rejects malformed inputs at the schema boundary without touching the tab', async () => {
  const page = fixture()
  expect((await page.execute('read_messages', {})).ok).toBe(false)
  expect((await page.execute('read_messages', { channel: '1', limit: 1000 })).ok).toBe(false)
  expect((await page.execute('send_message', { channel: '1' })).ok).toBe(false)
  expect((await page.execute('add_reaction', { channel: '1', message_id: 'm' })).ok).toBe(false)
  expect((await page.execute('list_channels', {})).ok).toBe(false)
  expect((await page.execute('get_user_profile', {})).ok).toBe(false)
  expect((await page.execute('search_messages', {})).ok).toBe(false)
  expect((await page.execute('list_guilds', { limit: 0 })).ok).toBe(false)
  expect((await page.execute('list_guilds', { unexpected: true })).ok).toBe(false)
  expect(page.fetches).toHaveLength(0)
})

it('rejects empty searches and mutually exclusive guild cursors before the API', async () => {
  const page = fixture()
  const empty = await page.execute('search_messages', { guild_id: 'g1' })
  expect(empty).toMatchObject({
    ok: true,
    value: { result: { status: 'error', error_code: 'VALIDATION' } },
  })
  expect(empty.value.result.message).toContain('at least one search criterion')
  const both = await page.execute('list_guilds', { before: '10', after: '20' })
  expect(both).toMatchObject({
    ok: true,
    value: { result: { status: 'error', error_code: 'VALIDATION' } },
  })
  expect(both.value.result.message).toContain('single cursor')
  expect(page.fetches).toHaveLength(0)
  const fine = await page.execute('list_guilds', { before: '10' })
  expect(fine.value.result.status).toBe('ok')
  const guildUrl = new URL(page.fetches[0].url)
  expect(guildUrl.searchParams.get('before')).toBe('10')
  expect(guildUrl.searchParams.get('after')).toBeNull()
})

it('re-reads the webpack token so an account switch is picked up immediately', async () => {
  const page = fixture()
  let currentToken = 'token-account-a'
  ;(page.window as any).webpackChunkdiscord_app.push = (entry: unknown) => {
    const requireCallback = (entry as [number[], unknown, (require: { c: unknown }) => void])[2]
    requireCallback({
      c: { mod: { exports: { default: { getToken: () => currentToken } } } },
    })
  }
  await page.execute('list_guilds', {})
  expect(page.fetches[0].init.headers).toMatchObject({ Authorization: 'token-account-a' })
  // User switches accounts in the still-loaded tab: the next call must
  // send the NEW credential, not the cached one.
  currentToken = 'token-account-b'
  await page.execute('list_guilds', {})
  expect(page.fetches[1].init.headers).toMatchObject({ Authorization: 'token-account-b' })
})

it('maps a browser.eval rejection to a stable TAB_UNAVAILABLE error result', async () => {
  const tool = manifest.tools.find((tool: { name: string }) => tool.name === 'read_messages')
  const failingBrowser = async (request: BrowserRequest): Promise<JsonValue> => {
    if (request.command === 'eval') throw new Error('Target tab closed')
    return { tabId: 9 }
  }
  const result: any = await executeAdapterWorkflow(
    wasm,
    builtinResources[prefix + tool.path],
    { channel: '123' } as JsonValue,
    failingBrowser,
    new AbortController().signal,
    { tabId: 9, url: 'https://discord.com/channels/@me' },
  )
  expect(result).toMatchObject({
    ok: true,
    value: { result: { status: 'error', error_code: 'TAB_UNAVAILABLE' } },
  })
  expect(result.value.result.message).toContain('Target tab closed')
})

it('classifies a coded HTTP 401 as AUTH across all eight workflows', async () => {
  // An unrecognized Discord code on HTTP 401 (e.g. 50012) must surface as
  // AUTH in the caller-visible contract — the code stays as diagnostic
  // detail. Exercise each workflow once against the same 401 fixture.
  const tools = manifest.tools.map((t: { name: string }) => t.name)
  const inputs: Record<string, Record<string, unknown>> = {
    read_messages: { channel: 'c' },
    send_message: { channel: 'c', content: 'x' },
    add_reaction: { channel: 'c', message_id: 'm', emoji: '👍' },
    remove_reaction: { channel: 'c', message_id: 'm', emoji: '👍' },
    list_guilds: {},
    list_channels: { guild_id: 'g' },
    get_user_profile: { user_id: 'u' },
    search_messages: { guild_id: 'g', content: 'q' },
  }
  for (const name of tools) {
    const page = fixture({
      respond: () => ({ status: 401, body: { code: 50012, message: 'Unknown session' } }),
    })
    const result = await page.execute(name, inputs[name])
    expect(result, name).toMatchObject({
      ok: true,
      value: { result: { status: 'error', error_code: 'AUTH' } },
    })
    expect(result.value.result.message, name).toContain('(code 50012)')
  }
})

it('aborts a queued reaction fetch by its queue time, not its start time', async () => {
  // The workflow runs inside QuickJS, so timer math is not observable
  // through the fixture without real delays; assert the source contract
  // instead: the reaction workflows must derive the abort deadline from
  // options.queued_at (the lock's queue timestamp) and the lock must hand
  // that timestamp to the run callback, and the dispatch cutoff must stay
  // below the 18s in-page deadline so a dispatched entry always has
  // remaining budget and can never outlive the 25s browser-eval timeout.
  const sourceOf = (name: string) => {
    const tool = manifest.tools.find((t: { name: string }) => t.name === name)
    return builtinResources[prefix + tool.path] as string
  }
  for (const name of ['add_reaction', 'remove_reaction']) {
    const source = sourceOf(name)
    expect(source, name).toMatch(/queued_at === 'number'/)
    expect(source, name).toMatch(/deadlineMs - \(Date\.now\(\) - queuedAtMs\)/)
    expect(source, name).toMatch(/return run\(queuedAt\)/)
    expect(source, name).toMatch(/queuedAt > 15000/)
    expect(source, name).not.toMatch(/queuedAt > 25000/)
    expect(source, name).not.toMatch(/var startedAt = Date\.now\(\)/)
  }
  // Non-reaction workflows keep their own start-of-request deadline.
  expect(sourceOf('read_messages')).toMatch(/var startedAt = Date\.now\(\)/)
}, 15000)

// Deterministic in-page clock for behavioral timer tests. setTimeout is
// recorded and fired manually; Date.now follows a controllable offset.
// The workflow sources are untouched — the sandbox bindings are swapped
// per eval via the fixture's overrideTimers hook.
function makeFakeClock() {
  const timers = new Map<number, { delay: number; fire: () => void; installedAt: number }>()
  let nextId = 1
  let offsetMs = 0
  const fired = new Set<number>()
  const cleared = new Set<number>()
  const fakeDateNow = () => 1_700_000_000_000 + offsetMs
  const RealDate = Date
  // The workflows only ever call Date.now(); the constructor fallback is
  // a plain real Date for anything else.
  const FakeDate = ((ms?: number) =>
    new RealDate(typeof ms === 'number' ? ms : fakeDateNow())) as unknown as DateConstructor
  Object.assign(FakeDate, {
    now: fakeDateNow,
    parse: RealDate.parse,
    UTC: RealDate.UTC,
  })
  return {
    setTimeout: ((fn: () => void, delay?: number) => {
      const id = nextId++
      timers.set(id, { delay: delay ?? 0, fire: fn, installedAt: offsetMs })
      return id
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => {
      timers.delete(id)
      cleared.add(id)
    }) as unknown as typeof clearTimeout,
    dateConstructor: FakeDate,
    /** Number of live (installed, not fired/cleared) timers. */
    liveCount: () => timers.size,
    /** Fire every timer whose deadline (install time + delay) has passed. */
    advance: (ms: number) => {
      offsetMs += ms
      for (const [id, timer] of [...timers]) {
        if (offsetMs - timer.installedAt >= timer.delay && !fired.has(id)) {
          fired.add(id)
          timers.delete(id)
          timer.fire()
        }
      }
    },
    /** Delays of timers installed so far, in install order. */
    installedDelays: () => [...timers.values()].map((t) => t.delay),
    /** Delay of every timer ever installed, in install order. */
    allInstalledDelays: (() => {
      const all: number[] = []
      const origSet = timers.set.bind(timers)
      timers.set = (id: number, t: { delay: number; fire: () => void; installedAt: number }) => {
        all.push(t.delay)
        return origSet(id, t)
      }
      return () => all
    })(),
    firedIds: () => [...fired],
    clearedCount: () => cleared.size,
    now: fakeDateNow,
  }
}

it('arms the queued reaction abort timer with the remaining budget, not a fresh constant', async () => {
  // Behavioral companion to the source-fragment contract above: the lock
  // hands its queue timestamp to discordApi (options.queued_at) and the
  // fetch timer is armed with deadlineMs minus the time already spent in
  // the queue. Entry 2 queues behind entry 1's held slot; the in-page
  // clock then shifts +8s before entry 2 dispatches, so a workflow
  // deriving the delay from the QUEUE timestamp arms ≈10000 — one arming
  // a fresh constant at DISPATCH time arms 18000 and fails this test.
  const clock = makeFakeClock()
  let releaseFirst: (() => void) | null = null
  const firstStalled = new Promise<void>((resolveStall) => {
    releaseFirst = resolveStall
  })
  const page = fixture({
    // Every in-page body of this fixture shares the fake clock (it stays
    // monotonic across evals), while Node's real timers keep driving the
    // adapter/quickjs machinery.
    overrideTimers: () => ({
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      Date: clock.dateConstructor,
    }),
    // Headers resolve immediately; entry 1's BODY consumption stalls so
    // its lock slot stays held while the clock is shifted.
    gateBody: (url) => (url.includes('/reactions/') ? firstStalled : undefined),
  })
  const input = { channel: 'c', message_id: 'm', emoji: '👍' }
  // Entry 1 takes the lock slot (uncontended: armed with the full 18s).
  const first = page.execute('add_reaction', input)
  await vi.waitFor(() => expect(page.fetches).toHaveLength(1))
  // Entry 2 queues behind entry 1's slot at fake-time T0. Wait until its
  // eval has SYNCHRONOUSLY captured queuedAt — observable as the lock
  // slot being re-keyed to entry 2's own settled promise — before
  // shifting the clock.
  const slotBefore = (page.sandbox as any).__eo2ReactionLocks?.['c:m:👍']
  const second = page.execute('add_reaction', input)
  await vi.waitFor(
    () => expect((page.sandbox as any).__eo2ReactionLocks?.['c:m:👍']).not.toBe(slotBefore),
  )
  // Shift the clock +8s while entry 2 is still queued, then let entry 1
  // finish so entry 2 dispatches with only ≈10s of budget left.
  clock.advance(8000)
  releaseFirst!()
  expect(await first).toMatchObject({
    ok: true,
    value: { result: { status: 'ok', data: { added: true } } },
  })
  await second
  const delays = clock.allInstalledDelays()
  expect(delays, 'abort timer delays across both entries').toHaveLength(2)
  expect(delays[0]).toBeGreaterThanOrEqual(17000)
  expect(delays[1]).toBeGreaterThanOrEqual(9000)
  expect(delays[1]).toBeLessThanOrEqual(11000)
  expect(page.fetches).toHaveLength(2)
  expect(page.fetches[1].init.method).toBe('PUT')
}, 15000)

it('keeps the deadline armed and aborts a stalled response BODY after headers', async () => {
  // A workflow clearing the abort timer as soon as HEADERS arrive would
  // let a stalled BODY hang past the eval deadline. Here entry 2's body
  // consumption stalls indefinitely after headers; the queue-derived
  // deadline timer (armed ≈10000 after the +8s queue wait) must still be
  // live at that moment and must fire, unwinding the stalled body into
  // the workflow's NETWORK abort result.
  const clock = makeFakeClock()
  let releaseFirst: (() => void) | null = null
  const firstStalled = new Promise<void>((resolveStall) => {
    releaseFirst = resolveStall
  })
  const page = fixture({
    overrideTimers: () => ({
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      Date: clock.dateConstructor,
    }),
    gateBody: (url, init) => {
      if (!url.includes('/reactions/')) return
      if (page.fetches.length === 1) return firstStalled
      // Entry 2: stalled forever unless the deadline abort unwinds it —
      // exactly what a real stalled body stream does on signal.abort().
      return new Promise<never>((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          const e = new Error('The operation was aborted')
          e.name = 'AbortError'
          reject(e)
        })
      })
    },
  })
  const input = { channel: 'c', message_id: 'm', emoji: '👍' }
  const first = page.execute('add_reaction', input)
  await vi.waitFor(() => expect(page.fetches).toHaveLength(1))
  // Entry 2 queues behind entry 1's slot at fake-time T0. Wait until its
  // eval has SYNCHRONOUSLY captured queuedAt — observable as the lock
  // slot being re-keyed to entry 2's own settled promise — before
  // shifting the clock.
  const slotBefore = (page.sandbox as any).__eo2ReactionLocks?.['c:m:👍']
  const second = page.execute('add_reaction', input)
  await vi.waitFor(
    () => expect((page.sandbox as any).__eo2ReactionLocks?.['c:m:👍']).not.toBe(slotBefore),
  )
  clock.advance(8000)
  releaseFirst!()
  expect(await first).toMatchObject({
    ok: true,
    value: { result: { status: 'ok', data: { added: true } } },
  })
  // Entry 2 dispatched; its body is stalled at the gate with headers in.
  await vi.waitFor(() => expect(page.fetches).toHaveLength(2))
  // The deadline timer is STILL ARMED while the body is being consumed
  // (only entry 1's timer has been cleared, after its body completed).
  expect(clock.installedDelays()).toHaveLength(1)
  expect(clock.clearedCount()).toBe(1)
  // Advance past the remaining ≈10s budget: the abort fires and unwinds
  // the stalled body (a premature clearTimeout right after headers would
  // leave nothing to fire and hang the eval).
  clock.advance(10000)
  const secondResult = await second
  expect(secondResult).toMatchObject({
    ok: true,
    value: { result: { status: 'error', error_code: 'NETWORK' } },
  })
  expect(secondResult.value.result.message).toContain('deadline')
  expect(clock.firedIds()).toHaveLength(1)
  expect(page.fetches[1].init.signal?.aborted).toBe(true)
}, 15000)

it('reports a same-key reaction lock expiry as LOCK_TIMEOUT, not TAB_UNAVAILABLE', async () => {
  // Behavioral: hold the shared reaction lock past the 15s wait cutoff,
  // then let the queued entry start. The expiry must surface as a
  // distinct LOCK_TIMEOUT error result — the tab is alive — NOT the
  // TAB_UNAVAILABLE the outer browser.eval catch maps every escaped
  // rejection to. The expired entry must not fetch Discord and must not
  // leak its lock slot. A CONTROLLED clock moves the queued entry's
  // queue timestamp past the 15s cutoff deterministically — no fixed
  // wall-clock sleep that a slow runner could under- or over-shoot
  // (Sourcery round 6: the previous 15.4s sleep raced the runner).
  const clock = makeFakeClock()
  let releaseFirst: (() => void) | null = null
  const firstStalled = new Promise<void>((resolveStall) => {
    releaseFirst = resolveStall
  })
  const held = fixture({
    gate: () => firstStalled,
    overrideTimers: () => ({
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      Date: clock.dateConstructor,
    }),
  })
  const input = { channel: 'c', message_id: 'm', emoji: '👍' }
  // Entry 1 takes the lock slot; its fetch stalls at the gate.
  const first = held.execute('add_reaction', input)
  await vi.waitFor(() => expect(held.fetches).toHaveLength(1))
  // Entry 2 queues behind the held slot at fake-time T0. Wait until its
  // eval has SYNCHRONOUSLY captured queuedAt — observable as the lock
  // slot being re-keyed to entry 2's own settled promise — before
  // shifting the clock (same synchronization as the deadline tests above).
  const slotBefore = (held.sandbox as any).__eo2ReactionLocks?.['c:m:👍']
  const second = held.execute('add_reaction', input)
  await vi.waitFor(
    () => expect((held.sandbox as any).__eo2ReactionLocks?.['c:m:👍']).not.toBe(slotBefore),
  )
  // Shift the in-page clock past the 15s wait cutoff while entry 2 is
  // still queued, then release entry 1 so entry 2 starts and hits the
  // expiry check with a deterministic +16s queue age.
  clock.advance(16000)
  releaseFirst!()
  expect(await first).toMatchObject({
    ok: true,
    value: { result: { status: 'ok', data: { added: true } } },
  })
  const secondResult = await second
  expect(secondResult).toMatchObject({
    ok: true,
    value: {
      result: {
        status: 'error',
        data: null,
        error_code: 'LOCK_TIMEOUT',
      },
    },
  })
  expect(secondResult.value.result.message).toContain('15s lock wait')
  // The queued entry never touched Discord.
  expect(held.fetches).toHaveLength(1)
  // The expired entry's lock slot was cleaned up.
  const locks = (held.sandbox as any).__eo2ReactionLocks as
    | Record<string, unknown>
    | undefined
  expect(locks === undefined || Object.keys(locks).length === 0).toBe(true)
}, 15000)

it("bounds automatic nonce reuse to Discord's enforce_nonce window", async () => {
  // Control the clock by seeding the retry-nonce map with timestamps
  // relative to now, so both bounds are exercised BEHAVIORALLY: a runtime
  // TTL that drifts in either direction fails these assertions, where the
  // previous source-text matches kept passing.
  const page = fixture()
  const input = { channel: '555', content: 'window test' }
  // The workflow's retry key is channel|reply_to|content.
  const retryKey = '555||window test'
  const now = Date.now()
  // A nonce remembered 299s ago is inside the 5-minute dedupe window
  // Discord's enforce_nonce guarantees, so the retry reuses it.
  ;(page.sandbox as Record<string, unknown>).__eo2DiscordRetryNonces = new Map([
    [retryKey, { nonce: 'seeded-young', at: now - 299000 }],
  ])
  await page.execute('send_message', input)
  expect(JSON.parse(page.fetches[0].init.body!).nonce).toBe('seeded-young')
  // A nonce remembered exactly AT the 300s boundary is no longer reused:
  // the window is strictly < 300000 ms, so a runtime TTL >= 300000
  // (e.g. 360000) regenerates this case and fails the test.
  ;(page.sandbox as Record<string, unknown>).__eo2DiscordRetryNonces = new Map([
    [retryKey, { nonce: 'seeded-expired', at: now - 300000 }],
  ])
  const failing = fixture({
    respond: () => ({ status: 500, body: 'Internal Server Error' }),
  })
  ;(failing.sandbox as Record<string, unknown>).__eo2DiscordRetryNonces = new Map([
    [retryKey, { nonce: 'seeded-expired', at: now - 300000 }],
  ])
  await failing.execute('send_message', input)
  const regenerated = JSON.parse(failing.fetches[0].init.body!).nonce as string
  expect(regenerated).not.toBe('seeded-expired')
  // The regenerated entry is stored ONCE: an immediate retry reuses the
  // nonce WITHOUT refreshing its timestamp, so retries cannot extend the
  // window past Discord's dedupe guarantee.
  const storedAt = (failing.sandbox.__eo2DiscordRetryNonces as Map<string, { nonce: string; at: number }>).get(retryKey)!.at
  await failing.execute('send_message', input)
  expect(JSON.parse(failing.fetches[1].init.body!).nonce).toBe(regenerated)
  expect((failing.sandbox.__eo2DiscordRetryNonces as Map<string, { nonce: string; at: number }>).get(retryKey)!.at).toBe(storedAt)
}, 15000)

it('a retry routed to a DIFFERENT discord.com tab reuses the original nonce via the shared localStorage store', async () => {
  // Finding: the retry nonce map lives in one page's globalThis, so a retry
  // executed in ANOTHER discord.com tab could not find the original nonce
  // and would post a DUPLICATE. The workflow now mirrors unconfirmed
  // nonces into localStorage (shared per discord.com origin across tabs of
  // the same profile): the second tab must adopt the remembered nonce so
  // Discord's enforce_nonce dedupes the retry instead of posting twice.
  const respond500 = () => ({ status: 500, body: 'Internal Server Error' })
  // Tab 1: the send FAILS (outcome unknown) — its nonce must be remembered.
  const tab1 = fixture({ respond: respond500 })
  const input = { channel: '555', content: 'cross tab' }
  await tab1.execute('send_message', input)
  const originalNonce = JSON.parse(tab1.fetches[0].init.body!).nonce as string
  // Tab 2 is a FRESH fixture: brand-new globalThis (empty in-tab nonce map)
  // but the SAME origin storage — seeded with tab 1's localStorage snapshot,
  // exactly what a real second tab of the same profile would observe.
  const tab2 = fixture({ respond: respond500 })
  ;(tab2.sandbox.__localStorage as { setItem: (k: string, v: string) => void }).setItem(
    '__eo2DiscordRetryNonces',
    (tab1.sandbox.__localStorage as { getItem: (k: string) => string | null }).getItem('__eo2DiscordRetryNonces')!,
  )
  await tab2.execute('send_message', input)
  // The cross-tab retry reused the ORIGINAL nonce → Discord dedupes it.
  expect(JSON.parse(tab2.fetches[0].init.body!).nonce).toBe(originalNonce)
  // Store-once across tabs: the retried send in tab 2 did NOT refresh the
  // stored timestamp (the 5-minute window stays anchored to the first send).
  const storedAfterRetry = JSON.parse(
    (tab2.sandbox.__localStorage as { getItem: (k: string) => string | null }).getItem('__eo2DiscordRetryNonces')!,
  ) as Record<string, { nonce: string; at: number }>
  const storedBefore = JSON.parse(
    (tab1.sandbox.__localStorage as { getItem: (k: string) => string | null }).getItem('__eo2DiscordRetryNonces')!,
  ) as Record<string, { nonce: string; at: number }>
  expect(storedAfterRetry['555||cross tab'].at).toBe(storedBefore['555||cross tab'].at)

  // Delivery drops the shared entry: tab 3 and tab 4 SHARE tab 1's storage
  // backing (one Map, like tabs of the same profile) — the tab3 entry is
  // visible there, delivery must delete it, and the tab4 send must NOT be
  // deduped against the delivered nonce (it would be silently swallowed
  // and never posted). Fresh-empty localStorage fixtures would pass these
  // assertions even if delivery never cleaned up, hence the shared backing.
  const tab3 = fixture()
  ;(tab3.sandbox as { __localStorage: unknown }).__localStorage = tab1.sandbox.__localStorage
  await tab3.execute('send_message', input)
  // Delivery dropped the shared entry (the store holds no unconfirmed key).
  const storedAfterDelivery = JSON.parse(
    (tab3.sandbox.__localStorage as { getItem: (k: string) => string | null }).getItem('__eo2DiscordRetryNonces') ?? '{}',
  ) as Record<string, unknown>
  expect(storedAfterDelivery['555||cross tab']).toBeUndefined()
  // tab4 reads the same backing; after tab3's delivery it observes no
  // unconfirmed nonce, so its retry must mint a fresh one.
  const tab4 = fixture({ respond: respond500 })
  ;(tab4.sandbox as { __localStorage: unknown }).__localStorage = tab1.sandbox.__localStorage
  await tab4.execute('send_message', input)
  expect(JSON.parse(tab4.fetches[0].init.body!).nonce).not.toBe(JSON.parse(tab3.fetches[0].init.body!).nonce)
}, 15000)

it('the cross-tab nonce store is bounded and expires with the same 5-minute window', async () => {
  // Backlog bound: after 128 unconfirmed sends the shared store holds at
  // most 128 keys (same cap as the in-tab map), so a large backlog cannot
  // grow localStorage unboundedly across tabs.
  const respond500 = () => ({ status: 500, body: 'Internal Server Error' })
  const page = fixture({ respond: respond500 })
  for (let i = 0; i < 130; i++) {
    await page.execute('send_message', { channel: '555', content: `backlog ${i}` })
  }
  const stored = JSON.parse(
    (page.sandbox.__localStorage as { getItem: (k: string) => string | null }).getItem('__eo2DiscordRetryNonces')!,
  ) as Record<string, unknown>
  expect(Object.keys(stored).length).toBeLessThanOrEqual(128)

  // Window bound: a storage entry older than 300s is not adopted (a fresh
  // nonce is minted and, store-once, replaces the expired entry).
  const oldTab = fixture({ respond: respond500 })
  const input = { channel: '555', content: 'expired entry' }
  const now = Date.now()
  ;(oldTab.sandbox.__localStorage as { setItem: (k: string, v: string) => void }).setItem(
    '__eo2DiscordRetryNonces',
    JSON.stringify({ '555||expired entry': { nonce: 'stale-nonce', at: now - 300000 } }),
  )
  await oldTab.execute('send_message', input)
  const regenerated = JSON.parse(oldTab.fetches[0].init.body!).nonce as string
  expect(regenerated).not.toBe('stale-nonce')
  const rewritten = JSON.parse(
    (oldTab.sandbox.__localStorage as { getItem: (k: string) => string | null }).getItem('__eo2DiscordRetryNonces')!,
  ) as Record<string, { nonce: string; at: number }>
  expect(rewritten['555||expired entry'].nonce).not.toBe('stale-nonce')
}, 15000)
