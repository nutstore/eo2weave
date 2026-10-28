// @vitest-environment node
import { beforeAll, expect, it } from 'vitest'
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

  const discordSources = Object.values(sources) as string[]
  expect(discordSources).toHaveLength(8)
  for (const source of discordSources) {
    // Navigation-free contract: reject every known page-navigation API,
    // not just location.assign. Navigation belongs to browser.goto.
    expect(source).not.toMatch(/location\s*\.\s*(assign|replace|reload)\s*\(/)
    expect(source).not.toMatch(/location\s*\.\s*href\s*=/)
    expect(source).not.toMatch(/window\s*\.\s*open\s*\(/)
    expect(source).not.toMatch(/document\s*\.\s*write\s*\(/)
    expect(source).toContain('webpackChunkdiscord_app')
    expect(source).toContain('credentials')
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
  init: { method?: string; headers?: Record<string, string>; body?: string; credentials?: string }
}

function fixture(options: {
  url?: string
  token?: string | null
  respond?: (url: string, init: FetchLog['init']) => { status: number; body: unknown }
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
      else if (url.includes('/users/'))
        body = { user: { id: 'u1', username: 'tester', global_name: 'Tester', bot: false, banner: null }, user_profile: { bio: 'bio text' } }
      else if (url.includes('/messages'))
        body = [{ id: 'm1', channel_id: 'c1', content: 'hello', author: { id: 'u1', username: 'tester' } }]
      return { status: 200, body }
    })
  const pageGlobals: Record<string, unknown> = {
    fetch: async (url: string, init: FetchLog['init'] = {}) => {
      fetches.push({ url, init })
      const outcome = respond(url, init)
      const headers = new Map<string, string>([['content-type', 'application/json']])
      return {
        ok: outcome.status >= 200 && outcome.status < 300,
        status: outcome.status,
        headers: { get: (key: string) => headers.get(key) ?? null },
        text: async () => JSON.stringify(outcome.body),
        json: async () => outcome.body,
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
  const execute = async (name: string, input: Record<string, unknown> = {}): Promise<any> => {
    const tool = manifest.tools.find((tool: { name: string }) => tool.name === name)
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
      const result = await runInNewContext(`(${request.positionals[0]})()`, {
        window,
        setTimeout,
        clearTimeout,
        document: window.document,
        location: window.location,
        URL,
        URLSearchParams,
        navigator: window.navigator,
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
        Date,
        Promise,
        Error,
        globalThis: pageSandbox,
      })
      return { tabId: 9, result: JSON.parse(JSON.stringify(result ?? null)) }
    }
    return { tabId: 9 }
  }
  return { execute, window, fetches, sandbox: pageSandbox }
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

it('falls back to the cached token when the webpack walk yields nothing', async () => {
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
  // The walk now FAILS (webpack gone, e.g. mid-navigation); the cached
  // token from call 1 keeps the session working instead of degrading to
  // UNAUTHENTICATED. A walk that runs but finds nothing would NOT use the
  // cache — see 'does not use a stale cached token after logout'.
  delete page.sandbox.webpackChunkdiscord_app
  await page.execute('list_guilds', {})
  expect(page.fetches).toHaveLength(2)
  expect(page.fetches[0].init.headers).toMatchObject({ Authorization: 'discord-token-xyz' })
  expect(page.fetches[1].init.headers).toMatchObject({ Authorization: 'discord-token-xyz' })
  expect(page.fetches.every((f) => f.url === 'https://discord.com/api/v9/users/@me/guilds?limit=200&with_counts=true')).toBe(true)
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
})

it('sends messages and reactions through the right methods and bodies', async () => {
  const page = fixture()
  const sent = await page.execute('send_message', {
    channel: '555',
    content: 'hello world',
    reply_to: 'm0',
  })
  expect(sent).toMatchObject({ ok: true, value: { result: { status: 'ok', data: { message: { id: 'm1' } } } } })
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
  expect(page.fetches[0].init.method).toBe('PUT')

  page.fetches.length = 0
  expect(await page.execute('remove_reaction', { channel: '555', message_id: 'm1', emoji: 'thumbsup:123' })).toMatchObject({
    ok: true,
    value: { result: { status: 'ok', data: { removed: true } } },
  })
  expect(page.fetches[0]).toMatchObject({
    url: 'https://discord.com/api/v9/channels/555/messages/m1/reactions/thumbsup%3A123/@me',
  })
  expect(page.fetches[0].init.method).toBe('DELETE')
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

  // Now the session is gone entirely: the walk FAILS (webpack gone), so
  // the cached token is sent and Discord rejects it with a coded 401. The
  // cache must still be cleared even though 50012 is not in AUTH_ERRORS.
  delete page.sandbox.webpackChunkdiscord_app
  await page.window.happyDOM.setURL('https://discord.com/channels/expired')
  const expired = await page.execute('read_messages', { channel: 'expired' })
  expect(expired).toMatchObject({
    ok: true,
    value: { result: { status: 'error', error_code: 'API' } },
  })
  expect(expired.value.result.message).toContain('(code 50012)')
  // The rejected token is fully invalidated: the next call neither uses
  // the cache nor re-reads the same webpack token — it goes UNAUTHENTICATED
  // without another fetch (the 403 and the 401 each fetched once).
  const again = await page.execute('read_messages', { channel: 'expired' })
  expect(again.value.result.error_code).toBe('UNAUTHENTICATED')
  expect(again.value.result.message).toContain('log in')
  expect(page.fetches).toHaveLength(2)
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
  // After the rate limit, the walk FAILS (transient hydration window): the
  // cached token must still be used — a 429 is not a logout.
  rateLimited = false
  delete page.sandbox.webpackChunkdiscord_app
  const next = await page.execute('read_messages', { channel: '123' })
  expect(next.value.result.status).toBe('ok')
  expect(page.fetches[1].init.headers).toMatchObject({ Authorization: 'discord-token-xyz' })
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

it('reuses the auto-generated nonce when a send is retried with identical input', async () => {
  const page = fixture()
  const input = { channel: '555', content: 'hello world', reply_to: 'm0' }
  const first = await page.execute('send_message', input)
  const firstNonce = JSON.parse(page.fetches[0].init.body!).nonce as string
  expect(firstNonce).toMatch(/.+-[0-9a-z]+/)
  expect(first.value.result.data.nonce).toBe(firstNonce)
  // Retry after a lost result: the remembered nonce makes Discord dedupe.
  await page.execute('send_message', input)
  expect(JSON.parse(page.fetches[1].init.body!).nonce).toBe(firstNonce)
  // A different message always gets a fresh nonce.
  await page.execute('send_message', { channel: '555', content: 'different' })
  expect(JSON.parse(page.fetches[2].init.body!).nonce).not.toBe(firstNonce)
  // A caller-supplied nonce always wins over the remembered one.
  await page.execute('send_message', { ...input, nonce: 'caller-nonce' })
  expect(JSON.parse(page.fetches[3].init.body!).nonce).toBe('caller-nonce')
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
