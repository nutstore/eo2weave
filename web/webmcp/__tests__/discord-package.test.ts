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
    expect(source).not.toContain('location.assign(')
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
    const section = readme.split(`### ${locale}`)[1]
    expect(section, locale).toBeDefined()
    for (const tool of manifest.tools as Array<{ name: string }>) {
      expect(section, `${locale} ${tool.name}`).toContain(`\`${tool.name}\``)
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
  return { execute, window, fetches }
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

it('caches the token on the page across calls', async () => {
  const page = fixture()
  let walkCount = 0
  ;(page.window as any).webpackChunkdiscord_app.push = (entry: unknown) => {
    walkCount++
    const requireCallback = (entry as [number[], unknown, (require: { c: unknown }) => void])[2]
    requireCallback({
      c: { mod: { exports: { default: { getToken: () => 'discord-token-xyz' } } } },
    })
  }
  await page.execute('list_guilds', {})
  await page.execute('list_guilds', {})
  expect(walkCount).toBe(1)
  expect(page.fetches).toHaveLength(2)
  expect(page.fetches.every((f) => f.url === 'https://discord.com/api/v9/users/@me/guilds?limit=200&with_counts=true')).toBe(true)
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
  expect(me.value.result.data.email).toBe('me@example.com')
  expect(me.value.result.data.mfa_enabled).toBe(true)
  expect(me.value.result.data.profile_source).toBe('users/@me')
  const search = await page.execute('search_messages', { guild_id: 'g1', content: 'hit' })
  expect(search.value.result.data).toMatchObject({ total_results: 1 })
  expect(search.value.result.data.messages[0][0]).toMatchObject({ id: 'm1', content: 'hit' })
  const searchFetch = page.fetches.find((f) => f.url.includes('/messages/search'))
  expect(searchFetch?.url).toContain('https://discord.com/api/v9/guilds/g1/messages/search?content=hit')
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
  expect(page.fetches[0].url).toContain('before=10')
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
  const notFound = await page.execute('read_messages', { channel: 'missing' })
  expect(notFound).toMatchObject({
    ok: true,
    value: {
      result: {
        status: 'error',
        error_code: 'NOT_FOUND',
        message: expect.stringContaining('Unknown Channel'),
      },
    },
  })
  expect(page.fetches).toHaveLength(1)
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
