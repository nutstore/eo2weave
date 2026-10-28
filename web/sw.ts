/// <reference lib="webworker" />

export {}

declare const self: ServiceWorkerGlobalScope & typeof globalThis

const APPSHELL_CACHE = 'appshell-v3'
// Caches from previous service worker versions. The activate handler migrates
// the offline-critical entries of 'dynamic-v2' into APPSHELL_CACHE before
// deleting it (see migrateLegacyCaches):
// - 'static-v2': hashed static assets (now owned by the browser HTTP cache);
//   never migrated (immutable URLs are re-fetched by the browser on miss)
// - 'dynamic-v2': API/MCP + subresources (now pass-through). Only the offline
//   shell ('/') and Pyodide wheel entries are migrated; API/MCP responses
//   must never be served stale, and everything else has no offline contract.

// Keep this dependency-free: esbuild compiles this file directly with no
// bundling of imports, and browser workers do not provide require().
function buildConversationNotificationUrl(projectId: string, conversationId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(conversationId)}`
}

// In local development, bypass all caching and fetch interception so Next HMR
// and WASM bundles (Pyodide, SQLite) keep working. The SW is still
// registered (so showNotification / notificationclick work), but acts as a
// pass-through.
const IS_DEV =
  self.location.hostname === 'localhost' ||
  self.location.hostname === '127.0.0.1' ||
  self.location.hostname === ''

const API_PATTERNS = [/\/api\//, /\/mcp\//]
// The full Pyodide offline kit: wheels/packages (.whl/.tar) plus the runtime
// bootstrap files (pyodide.js, pyodide.asm.wasm, *.mjs, pyodide-lock.json,
// python stdlib zip, ...). Everything under /assets/pyodide/ participates in
// the same cache-first + CDN-fallback strategy.
const PYODIDE_RUNTIME_PREFIX = '/assets/pyodide/'
const PYODIDE_WHEEL_PATTERN = /^\/assets\/pyodide\/.+\.(?:whl|tar)$/i
const PYODIDE_VERSION = '0.29.3'
const PYODIDE_CDN_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`

self.addEventListener('install', (event) => {
  // Precache the minimal offline shell: '/' is the navigation fallback and
  // '/manifest.json' keeps installability metadata available offline. Static
  // assets are owned by the browser HTTP cache and API/MCP responses must
  // never be cached. Without '/', the first offline navigation after install
  // has no shell to serve.
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(APPSHELL_CACHE)
        await cache.addAll(['/', '/manifest.json'])
      } catch (error) {
        console.warn('[ServiceWorker] Failed to precache offline shell:', error)
      }
    })()
  )
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await migrateLegacyCaches()
      const cacheNames = await caches.keys()
      await Promise.all(
        cacheNames
          .filter((name) => name !== APPSHELL_CACHE)
          .map((name) => caches.delete(name))
      )
    })()
  )

  self.clients.claim()
})

// Base origin used to build absolute Request URLs for Cache Storage keys
// (relative Request URLs fail outside a browser page context). This must
// match the deployed origin of the service worker.
const SW_ORIGIN = 'https://eo2weave.example.com'

/**
 * Copy offline-critical entries from the previous version's 'dynamic-v2'
 * cache into APPSHELL_CACHE before it is deleted: the '/' offline shell (if
 * the old SW precached or network-first cached it) and Pyodide wheels, so an
 * offline upgrade does not drop the shell or break Python cold start. Best
 * effort and fault tolerant: a missing legacy cache is a silent no-op, and
 * entries already present in APPSHELL_CACHE are left untouched.
 */
async function migrateLegacyCaches(): Promise<void> {
  const LEGACY_DYNAMIC_CACHE = 'dynamic-v2'
  try {
    if (!(await caches.has(LEGACY_DYNAMIC_CACHE))) return
    const [legacy, target] = await Promise.all([
      caches.open(LEGACY_DYNAMIC_CACHE),
      caches.open(APPSHELL_CACHE),
    ])
    // Cache Storage keys are absolute URLs; build the shell request from the
    // worker origin explicitly (relative Request URLs fail outside browsers).
    const shellRequest = new Request(`${SW_ORIGIN}/`)
    if (await target.match(shellRequest)) {
      // Do not overwrite a fresher shell already present in the new cache.
    } else {
      const shell = await legacy.match(shellRequest)
      if (shell) await target.put(shellRequest, shell)
    }
    const keys = await legacy.keys()
    await Promise.all(
      keys
        .filter((request) => isPyodideWheel(new URL(request.url).pathname))
        .map(async (request) => {
          if (await target.match(request)) return
          const response = await legacy.match(request)
          if (response) await target.put(request, response)
        })
    )
  } catch (error) {
    // Migration is best effort; never block activation on it.
    console.warn('[ServiceWorker] Legacy cache migration failed:', error)
  }
}

self.addEventListener('fetch', (event) => {
  // Dev mode: pass through. Without this early return, every HMR request
  // and WASM bundle gets cached by SW, breaking Vite hot reload.
  if (IS_DEV) return

  const { request } = event
  const url = new URL(request.url)

  if (request.method !== 'GET') return
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return

  // Cross-origin requests: pass through untouched. The offline shell and the
  // Pyodide wheel cache are same-origin concerns; claiming a cross-origin
  // request could answer an external URL with this app's shell or a
  // CDN-proxied response.
  if (url.origin !== self.location.origin) return

  // Everything not handled below is a deliberate pass-through: no
  // respondWith() means the request flows exactly as if no SW existed.
  // Static assets (/_next/static/**, /assets/*-hash.*) are content-hashed
  // and immutable — the browser HTTP cache owns them; API/MCP responses
  // must never be served stale from Cache Storage; everything else has no
  // offline requirement. This deletes the entire SW-failure class
  // (synthetic 503s breaking webpack's chunk loader) at the root.

  // Business data: freshness belongs to the app layer.
  if (API_PATTERNS.some((pattern) => pattern.test(url.pathname))) return

  // The real SW job: offline app shell.
  if (isNavigationRequest(request)) {
    event.respondWith(networkFirstWithCacheFallback(request))
    return
  }

  // Offline cold-start of the Python runtime: wheels/packages and the
  // runtime bootstrap files (pyodide.js, .wasm, .mjs, lock json, stdlib zip).
  if (isPyodideWheel(url.pathname)) {
    event.respondWith(pyodideCacheWithCdnFallback(request, url))
    return
  }
  if (isPyodideRuntimeFile(url.pathname)) {
    // Cache-first with CDN fallback; on total failure the original network
    // error propagates (no synthetic 503 — the browser surfaces the real
    // network failure, same contract as pass-through).
    event.respondWith(pyodideCacheWithCdnFallback(request, url))
    return
  }
})

async function networkFirstWithCacheFallback(request: Request): Promise<Response> {
  try {
    const networkResponse = await fetch(request)
    if (networkResponse.ok) {
      const cache = await caches.open(APPSHELL_CACHE)
      await cache.put(request, networkResponse.clone())
    }
    return networkResponse
  } catch {
    const cached = await caches.match(request)
    if (cached) return cached

    // Next runtime has no exported /index.html. The root document is cached
    // as a provider-neutral offline shell; exact navigations still win first.
    const appShell = await caches.match('/')
    if (appShell) return appShell

    return new Response('Offline', { status: 503 })
  }
}

/**
 * Cache-first with CDN fallback for the Pyodide offline kit (wheels and
 * runtime files). On cache miss the file is fetched — wheels from the CDN
 * (the local build does not ship the full wheel set), runtime files from
 * their original URL (already served from /assets/pyodide/) — and stored
 * under the original local URL key. If both cache and network are
 * unavailable the rejection propagates so respondWith surfaces the real
 * network error instead of a synthetic 503.
 */
async function pyodideCacheWithCdnFallback(request: Request, url: URL): Promise<Response> {
  const cache = await caches.open(APPSHELL_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached

  const isWheel = isPyodideWheel(url.pathname)
  const fileName = url.pathname.split('/').pop()
  if (!fileName) {
    return new Response('Bad Request', { status: 400 })
  }
  // Wheels come from the CDN; runtime bootstrap files are served locally.
  const targetUrl = isWheel ? `${PYODIDE_CDN_BASE}${fileName}` : request.url

  const response = await fetch(targetUrl, { mode: 'cors' })
  if (response.ok) {
    // Cache under the original local URL key so future local requests hit cache directly.
    await cache.put(request, response.clone())
  }
  return response
}

function isPyodideWheel(pathname: string): boolean {
  return PYODIDE_WHEEL_PATTERN.test(pathname)
}

function isPyodideRuntimeFile(pathname: string): boolean {
  return pathname.startsWith(PYODIDE_RUNTIME_PREFIX)
}

function isNavigationRequest(request: Request): boolean {
  if (request.mode === 'navigate') return true
  const accept = request.headers.get('accept') ?? ''
  return accept.includes('text/html')
}

self.addEventListener('sync' as never, (event: ExtendableEvent & { tag?: string }) => {
  if (event.tag === 'sync-messages') {
    event.waitUntil(syncMessages())
  }
})

async function syncMessages(): Promise<void> {
  return
}

self.addEventListener('push', (event) => {
  let data = {
    title: 'EO2Weave',
    body: 'You have a new notification',
    icon: '/favicon.svg',
    badge: '/icons/badge-72.png',
    data: { url: '/' },
  }

  if (event.data) {
    try {
      data = { ...data, ...event.data.json() }
    } catch {
      data.body = event.data.text()
    }
  }

  const options = {
    body: data.body,
    icon: data.icon,
    badge: data.badge,
    data: data.data,
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
    tag: 'app-notification',
    renotify: true,
  }

  event.waitUntil(self.registration.showNotification(data.title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  if (event.action === 'dismiss') return

  const data = (event.notification.data ?? {}) as {
    clientId?: string | null
    conversationId?: string
    projectId?: string
  }
  const { clientId, conversationId, projectId } = data

  event.waitUntil((async () => {
    // 1️⃣ Find the exact original tab — focus it and let the client navigate
    // to the correct conversation.
    // Note: We do NOT match by URL because the same conversationId can exist
    // across multiple projects, and user state might change.
    //
    // TODO(Limitation): If the agent finished running inside the browser's
    // Side Panel, `original.focus()` here will fail or have no effect.
    // Reason: Due to security restrictions, Web Service Workers do not have
    // the privilege to forcibly switch focus to or activate the browser's
    // main tab (user focus cannot be hijacked by web APIs).
    // The solution requires relying on the browser extension's background
    // script (chrome.tabs.update).
    if (clientId) {
      try {
        const original = await self.clients.get(clientId)
        if (original?.type === 'window') {
          await (original as WindowClient).focus()
          original.postMessage({
            type: 'NAVIGATE_TO_CONVERSATION',
            conversationId,
            projectId,
            // 注意：不带 url — 客户端自己拼
          })
          return
        }
      } catch (err) {
        console.warn('[ServiceWorker] clients.get failed:', err)
      }
    }

    // 2️⃣ 真兜底：原 tab 已关 → 开新窗口带目标 URL
    if (self.clients.openWindow && projectId && conversationId) {
      return self.clients.openWindow(buildConversationNotificationUrl(projectId, conversationId))
    }
  })())
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }

  // Handle clientId request from page (used by agent-notification service)
  if (event.data?.type === 'GET_CLIENT_ID') {
    const clientId = (event.source as Client | null)?.id ?? null
    event.ports[0]?.postMessage({ clientId })
    return
  }

  if (event.data?.type === 'CACHE_URLS') {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(APPSHELL_CACHE)
        const urls = Array.isArray(event.data?.urls) ? event.data.urls : []
        for (const url of urls) {
          try {
            // Only same-origin, non-API/MCP URLs may enter the app-shell
            // cache: this mirrors the fetch handler's own rules so a
            // stray CACHE_URLS message can never stash API/MCP (or
            // cross-origin) responses the SW deliberately passes through.
            const parsed = new URL(url, self.location.origin)
            if (parsed.origin !== self.location.origin) continue
            if (API_PATTERNS.some((pattern) => pattern.test(parsed.pathname))) continue
            await cache.add(url)
          } catch (error) {
            console.warn('[ServiceWorker] Failed to cache URL:', url, error)
          }
        }
      })()
    )
  }

  if (event.data?.type === 'CLEAR_CACHE') {
    event.waitUntil(caches.keys().then((names) => Promise.all(names.map((name) => caches.delete(name)))))
  }
})

self.addEventListener('error', (event) => {
  console.error('[ServiceWorker] Error:', event.message)
})

self.addEventListener('unhandledrejection', (event) => {
  console.error('[ServiceWorker] Unhandled rejection:', event.reason)
})
