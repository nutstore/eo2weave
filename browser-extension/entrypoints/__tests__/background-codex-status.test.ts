import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Run the actual Codex helpers and status handler without starting the unrelated
// WXT background services. Each instance owns its storage and module state.
const background = readFileSync(new URL('../background.ts', import.meta.url), 'utf8')
const helpers = background.slice(
  background.indexOf('interface CodexTokensLike'),
  background.indexOf('// Message listener'),
)
const statusHandler = background.slice(
  background.indexOf("        if (CODEX_OAUTH_ENABLED && message.type === 'codex_get_status')"),
  background.indexOf("        if (CODEX_OAUTH_ENABLED && message.type === 'codex_get_usage')"),
)
const source = ts.transpileModule(`
  const CODEX_OAUTH_ENABLED = true;
  ${helpers}
  (async (sendResponse) => {
    const message = { type: 'codex_get_status' };
    ${statusHandler}
  });
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText

interface Status {
  ok: boolean
  data: {
    authorized: boolean
    authState: string
    models: Array<{ id: string }>
    modelsEndpointProbe: Record<string, unknown> | null
  }
}

function token(name: string, expiresAt = Date.now() + 60 * 60 * 1000) {
  const payload = Buffer.from(JSON.stringify({ sub: name, exp: expiresAt / 1000 })).toString('base64url')
  return `header.${payload}.signature`
}

function catalog(id: string) {
  return Response.json({ models: [{ slug: id }], private_metadata: 'never-forward-this' })
}

function setup(options: { failTokenRead?: number } = {}) {
  const storage: Record<string, unknown> = { codex_tokens: { access_token: token('A') } }
  const fetch = vi.fn<typeof globalThis.fetch>()
  let tokenReads = 0
  const context = createContext({
    Date, atob, fetch, AbortSignal,
    chrome: {
      storage: {
        local: {
          get: async (key: string) => {
            if (key === 'codex_tokens') {
              tokenReads += 1
              if (options.failTokenRead === tokenReads) throw new Error('storage unavailable')
            }
            return { [key]: storage[key] }
          },
        },
      },
    },
  })
  const handle = runInContext(source, context) as (respond: (status: Status) => void) => Promise<void>
  const status = () => new Promise<Status>((resolve, reject) => { handle(resolve).catch(reject) })
  return { storage, fetch, status }
}

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}

afterEach(() => { vi.useRealTimers() })

describe('Codex status model catalog cache', () => {
  it('reuses the catalog for five minutes and keeps response bodies private', async () => {
    vi.useFakeTimers()
    const { fetch, status } = setup()
    fetch.mockResolvedValueOnce(catalog('first')).mockResolvedValueOnce(catalog('updated'))

    const first = await status()
    expect(first.data.models.map(model => model.id)).toEqual(['first'])
    expect(first.data.modelsEndpointProbe).toMatchObject({
      status: 200, ok: true, responseKeys: ['models', 'private_metadata'],
    })
    expect(JSON.stringify(first)).not.toContain('never-forward-this')
    const cached = await status()
    expect(cached.data.models).toEqual(first.data.models)
    // A reused probe is marked so callers do not read it as a fresh check.
    expect(cached.data.modelsEndpointProbe).toMatchObject({
      status: 200, ok: true, cached: true,
    })
    expect(fetch).toHaveBeenCalledTimes(1)

    // The cache must hold for the full five minutes, not just the next poll.
    vi.advanceTimersByTime(5 * 60 * 1000 - 1000)
    expect((await status()).data.models.map(model => model.id)).toEqual(['first'])
    expect(fetch).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2000)
    expect((await status()).data.models.map(model => model.id)).toEqual(['updated'])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the endpoint probe when the cache-validation token read fails', async () => {
    // Read 1 is the handler's token snapshot, read 2 is the pre-cache re-read.
    const { fetch, status } = setup({ failTokenRead: 2 })
    fetch.mockResolvedValueOnce(catalog('first')).mockResolvedValueOnce(catalog('second'))

    const first = await status()
    expect(first.data.models.map(model => model.id)).toEqual(['first'])
    expect(first.data.modelsEndpointProbe).toMatchObject({ status: 200, ok: true })
    expect(first.data.modelsEndpointProbe).not.toHaveProperty('error')

    // The cache write was skipped, so the next poll fetches again.
    expect((await status()).data.models.map(model => model.id)).toEqual(['second'])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['empty', () => Response.json({ models: [] })],
    ['failed', () => new Response('denied', { status: 401 })],
  ] as const)('does not cache a %s catalog', async (_name, response) => {
    const { fetch, status } = setup()
    fetch.mockResolvedValueOnce(response()).mockResolvedValueOnce(catalog('retried'))
    expect((await status()).data.models).toEqual([])
    expect((await status()).data.models.map(model => model.id)).toEqual(['retried'])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('checks token expiry on cache hits and clears the catalog when authorization ends', async () => {
    const { storage, fetch, status } = setup()
    const originalTokens = storage.codex_tokens
    fetch.mockResolvedValueOnce(catalog('first')).mockResolvedValueOnce(catalog('fresh'))
    await status()

    storage.codex_tokens = { access_token: token('expired', Date.now() - 1000) }
    expect((await status()).data).toMatchObject({ authorized: false, authState: 'expired', models: [] })
    expect(fetch).toHaveBeenCalledTimes(1)

    storage.codex_tokens = originalTokens
    expect((await status()).data.models.map(model => model.id)).toEqual(['fresh'])
  })

  it('discards the old token catalog even when the new token request fails', async () => {
    const { storage, fetch, status } = setup()
    const originalTokens = storage.codex_tokens
    fetch.mockResolvedValueOnce(catalog('old-A'))
      .mockResolvedValueOnce(new Response('denied', { status: 401 }))
      .mockResolvedValueOnce(catalog('fresh-A'))
    await status()

    storage.codex_tokens = { access_token: token('B') }
    expect((await status()).data.models).toEqual([])
    storage.codex_tokens = originalTokens
    expect((await status()).data.models.map(model => model.id)).toEqual(['fresh-A'])
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('keeps the newer catalog when overlapping requests finish out of order', async () => {
    const { fetch, status } = setup()
    const olderResponse = deferredResponse()
    fetch.mockReturnValueOnce(olderResponse.promise).mockResolvedValueOnce(catalog('newer'))

    const older = status()
    expect((await status()).data.models.map(model => model.id)).toEqual(['newer'])
    olderResponse.resolve(catalog('older'))
    await older

    expect((await status()).data.models.map(model => model.id)).toEqual(['newer'])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not restore an in-flight catalog after authorization ends', async () => {
    const { storage, fetch, status } = setup()
    const originalTokens = storage.codex_tokens
    const olderResponse = deferredResponse()
    fetch.mockReturnValueOnce(olderResponse.promise).mockResolvedValueOnce(catalog('fresh'))

    const older = status()
    // Both storage reads precede the catalog fetch in the status handler.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    storage.codex_tokens = null
    expect((await status()).data.authorized).toBe(false)
    olderResponse.resolve(catalog('stale'))
    await older

    storage.codex_tokens = originalTokens
    expect((await status()).data.models.map(model => model.id)).toEqual(['fresh'])
  })

  it('does not cache a catalog fetched under a token replaced mid-request', async () => {
    const { storage, fetch, status } = setup()
    const originalTokens = storage.codex_tokens
    const pendingResponse = deferredResponse()
    fetch.mockReturnValueOnce(pendingResponse.promise).mockResolvedValueOnce(catalog('fresh-A'))

    const pending = status()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    storage.codex_tokens = { access_token: token('B') }
    pendingResponse.resolve(catalog('stale-A'))
    // The caller of that request still receives what its own fetch returned.
    expect((await pending).data.models.map(model => model.id)).toEqual(['stale-A'])

    storage.codex_tokens = originalTokens
    expect((await status()).data.models.map(model => model.id)).toEqual(['fresh-A'])
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
