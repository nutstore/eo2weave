/// <reference lib="webworker" />

export {}

declare const self: ServiceWorkerGlobalScope & typeof globalThis

const APPSHELL_CACHE = 'appshell-v3'
// Caches from previous service worker versions. The activate handler deletes
// any cache whose name is not APPSHELL_CACHE:
// - 'static-v2': hashed static assets (now owned by the browser HTTP cache)
// - 'dynamic-v2': API/MCP + subresources (now pass-through)

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
const PYODIDE_WHEEL_PATTERN = /^\/assets\/pyodide\/.+\.(?:whl|tar)$/i
const PYODIDE_VERSION = '0.29.3'
const PYODIDE_CDN_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`

self.addEventListener('install', (event) => {
  // No precache: the offline shell is cached on first navigation (fetch
  // handler). Old-version caches are removed by the activate handler below.
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== APPSHELL_CACHE)
          .map((name) => caches.delete(name))
      )
    )
  )

  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  // Dev mode: pass through. Without this early return, every HMR request
  // and WASM bundle gets cached by SW, breaking Vite hot reload.
  if (IS_DEV) return

  const { request } = event
  const url = new URL(request.url)

  if (request.method !== 'GET') return
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return

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

  // Offline cold-start of the Python runtime.
  if (isPyodideWheel(url.pathname)) {
    event.respondWith(pyodideWheelCacheWithCdnFallback(request, url))
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

async function pyodideWheelCacheWithCdnFallback(request: Request, url: URL): Promise<Response> {
  const cache = await caches.open(APPSHELL_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached

  // Local build does not include full wheel set; fetch wheels from CDN when absent.
  const fileName = url.pathname.split('/').pop()
  if (!fileName) {
    return new Response('Bad Request', { status: 400 })
  }
  const cdnUrl = `${PYODIDE_CDN_BASE}${fileName}`

  try {
    const cdnResponse = await fetch(cdnUrl, { mode: 'cors' })
    if (cdnResponse.ok) {
      // Cache under the original local URL key so future local requests hit cache directly.
      await cache.put(request, cdnResponse.clone())
    }
    return cdnResponse
  } catch {
    return new Response(JSON.stringify({ error: 'Offline', cached: false }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

function isPyodideWheel(pathname: string): boolean {
  return PYODIDE_WHEEL_PATTERN.test(pathname)
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
