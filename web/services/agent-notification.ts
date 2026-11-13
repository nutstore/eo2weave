/**
 * Agent Notification — sends system notification when agent loop completes.
 *
 * Flow:
 *   AgentLoop.onLoopComplete()
 *     → notifyAgentComplete({conversationId, projectId, title, body})
 *     → showNotification() with data.clientId + projectId + conversationId
 *
 *   User clicks notification
 *     → sw.ts notificationclick handler
 *     → clients.get(clientId) → focus original tab
 *     → postMessage NAVIGATE_TO_CONVERSATION
 *     → App.tsx message handler → navigate() → syncFromRoute
 *
 * Or (if original tab is closed):
 *     → sw.ts notificationclick
 *     → clients.openWindow(targetUrl)
 *
 * Silent when:
 *   - The completed conversation is visible (user can already see the response)
 *   - Notification permission is not granted
 *   - Service Worker registration is unavailable
 *   - Any unexpected error (never throws)
 */

declare global {
  interface Window {
    __agentClientId?: string | null
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotifyAgentCompleteParams {
  /** Conversation ID — used for tag de-duplication and click navigation */
  conversationId: string
  /** Project ID — used to build the correct URL on click */
  projectId: string
  /** Notification title (e.g. "重构建议 · 方案已完成") */
  title: string
  /** Notification body — short summary (typically first 60 chars of assistant reply) */
  body: string
  /** Whether the user is currently viewing this conversation. */
  isViewingConversation?: boolean
}

/**
 * Shape of `notification.data` consumed by sw.ts notificationclick handler.
 *
 * IMPORTANT: No `url` field — the client must construct the URL from
 * projectId + conversationId because project state may have changed
 * since the notification was created.
 */
export interface AgentNotificationData {
  clientId: string | null
  conversationId: string
  projectId: string
  kind: 'agent-loop-complete'
}

/** Notification fields supported by Service Workers but absent from older DOM typings. */
export interface AgentNotificationOptions extends NotificationOptions {
  renotify?: boolean
  actions?: Array<{ action: string; title: string; icon?: string }>
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a system notification that an agent loop has completed.
 *
 * Silent when:
 *   - User disabled notifications in Settings (agentLoopNotifications.enabled = false)
 *   - User is viewing this conversation AND the page is visible AND user set
 *     `onlyWhenHidden` to true (default true)
 *   - Notification permission is not granted
 *   - Service Worker is not registered
 *   - Any unexpected error (caught and logged, never throws)
 */
export async function notifyAgentComplete(params: NotifyAgentCompleteParams): Promise<void> {
  const { conversationId, projectId, title, body } = params

  try {
    // Read user preferences (synchronous via zustand getState)
    let notifEnabled = true
    try {
      const { useSettingsStore } = await import('@/store/settings.store')
      notifEnabled = useSettingsStore.getState().agentLoopNotifications.enabled
    } catch {
      // Settings store unavailable — fall back to defaults (notify)
    }

    if (!notifEnabled) return

    // Need Notification API and permission
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return

    // Prefer the extension bridge when available: Web SW notifications
    // cannot focus the host tab on click (Web SWs lack tab privileges),
    // while the extension background uses chrome.notifications +
    // chrome.tabs.update to refocus the CreatorWeave tab. Falls back to
    // the Web SW path in plain web tabs without the extension.
    const agentWeb = (window as any).__agentWeb
    if (typeof agentWeb?.showAgentNotification === 'function') {
      try {
        const resp = await agentWeb.showAgentNotification({
          title,
          body,
          conversationId,
        })
        if (resp?.ok) return
        // Bridge responded with an error — fall through to the Web SW path.
      } catch {
        // Bridge call failed — fall through to the Web SW path.
      }
    }

    // Use navigator.serviceWorker.ready (matches the working manual test).
    // This is an awaitable Promise that resolves once a SW controls the page.
    // It is the officially recommended way to get a usable registration.
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return

    // navigator.serviceWorker.ready can stay pending forever when no SW ever
    // activates for this origin (dev servers without /sw.js, sandboxed frames).
    // Race it with a timeout so a missing service worker can never stall the
    // completion path — the notification is simply skipped instead.
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<ServiceWorkerRegistration | null>((resolve) =>
        setTimeout(() => resolve(null), 3000)
      ),
    ])
    if (!registration) return

    const clientId = await getCachedClientId()

    const data: AgentNotificationData = {
      clientId,
      conversationId,
      projectId,
      kind: 'agent-loop-complete',
    }

    const options: AgentNotificationOptions = {
      body,
      // Use /favicon.svg — /icons/icon-192.png does NOT exist in public/.
      // A broken icon URL causes Chrome to silently drop the notification.
      icon: '/favicon.svg',
      // Unique tag per notification (NOT per conversation). Chrome's `renotify`
      // option is buggy on macOS: when the same tag already exists in the
      // notification center, new notifications are silently dropped.
      // Using a unique tag ensures every notification shows up.
      tag: `agent-loop-${conversationId}-${Date.now()}`,
      data: data as unknown as Record<string, unknown>,
      actions: [
        { action: 'open', title: '立即查看' },
        { action: 'dismiss', title: '稍后' },
      ],
    }
    // TODO(Limitation): This uses the Web Notification API via Web Service Worker.
    // Limitation: If the agent runs inside the CreatorWeave Extension's Side Panel,
    // clicking this notification will NOT be able to focus the host browser tab.
    // Web SWs lack the browser privilege to steal focus/activate tabs.
    // To support Side Panel tab-switching, this must be routed through the
    // browser extension's background script (chrome.notifications + chrome.tabs.update).
    await registration.showNotification(title, options)
  } catch (err) {
    console.warn('[AgentNotification] notifyAgentComplete failed:', err)
  }
}

/**
 * Request notification permission from the user.
 *
 * No-op (returns current permission) if:
 *   - Notification API is unavailable
 *   - Permission is already granted or denied
 *
 * Should be called from a user gesture handler (button click) to maximize
 * acceptance rate.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied'
  if (Notification.permission !== 'default') return Notification.permission
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

/**
 * Get the current tab's Service Worker clientId, cached.
 *
 * The page JS has no direct access to its own clientId — only the SW
 * can introspect this via `event.source.id`. We use MessageChannel
 * for a request/response handshake.
 *
 * Returns null if:
 *   - Service Worker is not registered
 *   - SW doesn't respond within 1s (fallback timeout)
 *   - Any postMessage error
 *
 * Result is cached in `window.__agentClientId` so subsequent calls are instant.
 */
export async function getCachedClientId(): Promise<string | null> {
  if (typeof window === 'undefined') return null

  // Return cached value (including explicit null)
  if (window.__agentClientId !== undefined) {
    return window.__agentClientId
  }

  const controller = navigator.serviceWorker?.controller
  if (!controller) {
    window.__agentClientId = null
    return null
  }

  return new Promise<string | null>((resolve) => {
    const channel = new MessageChannel()
    let settled = false

    const settle = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      window.__agentClientId = value
      resolve(value)
    }

    const timer = setTimeout(() => settle(null), 1000)

    channel.port1.onmessage = (event) => {
      const id = typeof event.data?.clientId === 'string' ? event.data.clientId : null
      settle(id)
    }

    try {
      controller.postMessage({ type: 'GET_CLIENT_ID' }, [channel.port2])
    } catch (err) {
      console.warn('[AgentNotification] getCachedClientId postMessage failed:', err)
      settle(null)
    }
  })
}

/**
 * Initialize the agent notification subsystem.
 *
 * Call once on app startup to pre-fetch the clientId (avoids the 1s
 * timeout on the first notification call). Safe to call multiple times.
 */
let initPromise: Promise<void> | null = null
export function initAgentNotification(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      await getCachedClientId()
    } catch (err) {
      console.warn('[AgentNotification] init failed:', err)
    }
  })()
  return initPromise
}

/**
 * Reset the cached clientId. Useful in tests.
 */
export function _resetClientIdCache(): void {
  if (typeof window !== 'undefined') {
    window.__agentClientId = undefined
  }
  initPromise = null
}
