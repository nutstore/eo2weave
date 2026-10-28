import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Unit tests for the sw.ts fetch-handler routing table.
 *
 * sw.ts is a dependency-free module with top-level side effects (event
 * listener registration), so it cannot be imported directly in happy-dom.
 * Instead, we evaluate the compiled worker bundle (public/sw.js, emitted by
 * scripts/prepare-pwa.mjs from sw.ts) inside a sandbox that stubs the
 * ServiceWorkerGlobalScope surface, then dispatch synthetic fetch events and
 * assert which requests the worker claims via respondWith().
 *
 * Route contract (issue #94):
 * - static assets (/_next/static/**, /assets/*-hash.*) → NOT claimed
 * - /api/ and /mcp/ GETs                                → NOT claimed
 * - navigation requests                                 → claimed (offline shell)
 * - pyodide wheels (/assets/pyodide/*.whl|tar)          → claimed (cache + CDN fallback)
 * - everything else                                     → NOT claimed
 */

const APPSHELL_CACHE = 'appshell-v3'

type Listener = (event: Record<string, unknown>) => void

function createSwSandbox(options: { hostname?: string; caches?: Map<string, unknown> } = {}) {
  const listeners = new Map<string, Listener[]>()
  const cacheNames = options.caches ?? new Map<string, unknown>()
  const respondWith = vi.fn()
  const registrations: Array<{ respondWith: typeof respondWith }> = []

  const cachesMock = {
    open: vi.fn(async (name: string) => {
      if (!cacheNames.has(name)) cacheNames.set(name, new Map())
      const entries = cacheNames.get(name) as Map<string, Response>
      return {
        match: vi.fn(async (request: Request) => entries.get(request.url)),
        put: vi.fn(async (request: Request, response: Response) => {
          entries.set(request.url, response)
        }),
        add: vi.fn(async (url: string) => {
          entries.set(url, new Response('cached'))
        }),
      }
    }),
    match: vi.fn(async (input: RequestInfo | string) => {
      const url = typeof input === 'string' ? new URL(input, 'https://eo2weave.example.com').toString() : input.url
      for (const entries of cacheNames.values()) {
        const hit = (entries as Map<string, Response>).get(url)
        if (hit) return hit
      }
      return undefined
    }),
    keys: vi.fn(async () => Array.from(cacheNames.keys())),
    delete: vi.fn(async (name: string) => {
      cacheNames.delete(name)
      return true
    }),
  }

  const selfMock: Record<string, unknown> = {
    location: { hostname: options.hostname ?? 'eo2weave.example.com', origin: 'https://eo2weave.example.com' },
    addEventListener: (type: string, listener: Listener) => {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type)!.push(listener)
    },
    skipWaiting: vi.fn(async () => {}),
    clients: {
      claim: vi.fn(async () => {}),
      get: vi.fn(async () => undefined),
      openWindow: vi.fn(async () => null),
    },
    registration: { showNotification: vi.fn(async () => {}) },
    caches: cachesMock,
  }

  return {
    selfMock,
    cachesMock,
    cacheNames,
    respondWith,
    registrations,
    dispatch(type: string, event: Record<string, unknown> = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event)
    },
  }
}

/** Evaluate the compiled sw.js bundle against a mocked worker global scope. */
async function evalWorker(source: string, sandbox: ReturnType<typeof createSwSandbox>) {
  const { selfMock } = sandbox
  const fn = new Function('self', 'caches', 'location', 'clients', 'registration', source)
  fn(selfMock, sandbox.cachesMock, selfMock.location, selfMock.clients, selfMock.registration)
}

function makeRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, init)
}

describe('service worker fetch routing (issue #94)', () => {
  let sandbox: ReturnType<typeof createSwSandbox>

  beforeEach(() => {
    vi.resetModules()
    sandbox = createSwSandbox()
  })

  it('compiles sw.ts to public/sw.js before tests run', async () => {
    const { existsSync, readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const swJs = path.resolve(__dirname, '../../public/sw.js')
    expect(existsSync(swJs)).toBe(true)
    expect(readFileSync(swJs, 'utf8')).toContain('appshell-v3')
    expect(readFileSync(swJs, 'utf8')).not.toContain('static-v2')
    expect(readFileSync(swJs, 'utf8')).not.toContain('dynamic-v2')
  })

  it('does not claim /_next/static requests (pass-through to HTTP cache)', async () => {
    await evalWorker(await getWorkerSource(), sandbox)
    sandbox.dispatch('fetch', { request: makeRequest('https://eo2weave.example.com/_next/static/chunks/main-abc123.js') })
    expect(sandbox.respondWith).not.toHaveBeenCalled()
  })

  it('does not claim hashed /assets files (pass-through to HTTP cache)', async () => {
    await evalWorker(await getWorkerSource(), sandbox)
    sandbox.dispatch('fetch', { request: makeRequest('https://eo2weave.example.com/assets/logo-a1b2c3d4e5.svg') })
    expect(sandbox.respondWith).not.toHaveBeenCalled()
  })

  it('does not claim /api/ requests (business data stays out of Cache Storage)', async () => {
    await evalWorker(await getWorkerSource(), sandbox)
    sandbox.dispatch('fetch', { request: makeRequest('https://eo2weave.example.com/api/projects') })
    expect(sandbox.respondWith).not.toHaveBeenCalled()
  })

  it('does not claim /mcp/ requests', async () => {
    await evalWorker(await getWorkerSource(), sandbox)
    sandbox.dispatch('fetch', { request: makeRequest('https://eo2weave.example.com/mcp/tools') })
    expect(sandbox.respondWith).not.toHaveBeenCalled()
  })

  it('does not claim non-GET requests', async () => {
    await evalWorker(await getWorkerSource(), sandbox)
    sandbox.dispatch('fetch', { request: makeRequest('https://eo2weave.example.com/api/projects', { method: 'POST' }) })
    sandbox.dispatch('fetch', { request: makeRequest('https://eo2weave.example.com/', { method: 'POST' }) })
    expect(sandbox.respondWith).not.toHaveBeenCalled()
  })

  it('claims navigation requests and serves the network response when online', async () => {
    await evalWorker(await getWorkerSource(), sandbox)
    const request = makeRequest('https://eo2weave.example.com/projects/p1', {
      headers: { accept: 'text/html' },
    })
    const networkResponse = new Response('<html>fresh</html>', { status: 200 })
    vi.stubGlobal('fetch', vi.fn(async () => networkResponse))

    sandbox.dispatch('fetch', { request, respondWith: sandbox.respondWith })

    expect(sandbox.respondWith).toHaveBeenCalledTimes(1)
    const served = await sandbox.respondWith.mock.calls[0][0]
    expect(served).toBe(networkResponse)
    vi.unstubAllGlobals()
  })

  it('falls back to the cached offline shell for navigation when offline', async () => {
    await evalWorker(await getWorkerSource(), sandbox)

    // Seed the shell: a successful navigation caches the root document.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>shell</html>', { status: 200 })))
    const seedRequest = makeRequest('https://eo2weave.example.com/', { headers: { accept: 'text/html' } })
    sandbox.dispatch('fetch', { request: seedRequest, respondWith: sandbox.respondWith })
    await Promise.resolve()
    await sandbox.respondWith.mock.calls[0][0]
    vi.unstubAllGlobals()

    // Now offline: network fetch throws, exact match misses, shell wins.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    const offlineRequest = makeRequest('https://eo2weave.example.com/projects/p1', {
      headers: { accept: 'text/html' },
    })
    sandbox.dispatch('fetch', { request: offlineRequest, respondWith: sandbox.respondWith })
    const served = await sandbox.respondWith.mock.calls[1][0]
    const response = await served
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('shell')
    vi.unstubAllGlobals()
  })

  it('caches pyodide wheels in the appshell cache (not claimed → claimed via cache path)', async () => {
    await evalWorker(await getWorkerSource(), sandbox)
    const wheelRequest = makeRequest('https://eo2weave.example.com/assets/pyodide/pyodide-0.29.3.whl')
    const wheelBytes = new Response('PYODIDE_WHEEL', { status: 200 })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://cdn.jsdelivr.net/pyodide/v0.29.3/full/pyodide-0.29.3.whl')
      return wheelBytes
    })
    vi.stubGlobal('fetch', fetchMock)

    sandbox.dispatch('fetch', { request: wheelRequest, respondWith: sandbox.respondWith })

    expect(sandbox.respondWith).toHaveBeenCalledTimes(1)
    const response = await sandbox.respondWith.mock.calls[0][0]
    expect(await response.text()).toBe('PYODIDE_WHEEL')
    expect(fetchMock).toHaveBeenCalled()
    // The wheel is stored under the appshell cache.
    const entries = sandbox.cacheNames.get(APPSHELL_CACHE) as Map<string, Response>
    expect(entries.get('https://eo2weave.example.com/assets/pyodide/pyodide-0.29.3.whl')).toBeDefined()
    vi.unstubAllGlobals()
  })

  it('serves a cached pyodide wheel without network on repeat request', async () => {
    await evalWorker(await getWorkerSource(), sandbox)
    const wheelUrl = 'https://eo2weave.example.com/assets/pyodide/pyodide-0.29.3.whl'
    const fetchMock = vi.fn(async () => new Response('PYODIDE_WHEEL', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const first = makeRequest(wheelUrl)
    sandbox.dispatch('fetch', { request: first, respondWith: sandbox.respondWith })
    await sandbox.respondWith.mock.calls[0][0]

    const second = makeRequest(wheelUrl)
    sandbox.dispatch('fetch', { request: second, respondWith: sandbox.respondWith })
    const response = await sandbox.respondWith.mock.calls[1][0]
    expect(await response.text()).toBe('PYODIDE_WHEEL')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('activates by deleting legacy caches and keeping only appshell-v3', async () => {
    await evalWorker(await getWorkerSource(), sandbox)
    sandbox.cacheNames.set('static-v2', new Map())
    sandbox.cacheNames.set('dynamic-v2', new Map())
    sandbox.cacheNames.set(APPSHELL_CACHE, new Map())

    const waitUntilPromises: Promise<unknown>[] = []
    sandbox.dispatch('activate', { waitUntil: (p: Promise<unknown>) => waitUntilPromises.push(p) })
    await Promise.all(waitUntilPromises)

    expect(Array.from(sandbox.cacheNames.keys())).toEqual([APPSHELL_CACHE])
  })

  it('install does not precache anything (empty manifest removed)', async () => {
    await evalWorker(await getWorkerSource(), sandbox)
    const waitUntilPromises: Promise<unknown>[] = []
    sandbox.dispatch('install', { waitUntil: (p: Promise<unknown>) => waitUntilPromises.push(p) })
    await Promise.all(waitUntilPromises)
    expect(sandbox.cachesMock.open).not.toHaveBeenCalled()
  })

  it('passes through everything in dev mode (localhost)', async () => {
    const devSandbox = createSwSandbox({ hostname: 'localhost' })
    await evalWorker(await getWorkerSource(), devSandbox)
    devSandbox.dispatch('fetch', { request: makeRequest('https://localhost/', { headers: { accept: 'text/html' } }), respondWith: devSandbox.respondWith })
    expect(devSandbox.respondWith).not.toHaveBeenCalled()
  })
})

let workerSourcePromise: Promise<string> | null = null

async function getWorkerSource(): Promise<string> {
  if (!workerSourcePromise) {
    workerSourcePromise = Promise.all([import('node:fs'), import('node:path')]).then(
      ([{ readFileSync }, path]) => readFileSync(path.resolve(__dirname, '../../public/sw.js'), 'utf8')
    )
  }
  return workerSourcePromise
}
