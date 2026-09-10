/**
 * PWA install prompt — captures the `beforeinstallprompt` event so the app can
 * offer a first-class install card instead of relying on the (easy-to-miss)
 * address-bar install icon.
 *
 * Why installability matters for EO2Weave specifically:
 *
 * Chrome only fires `beforeinstallprompt` (and shows any install affordance)
 * when the manifest satisfies the installability criteria — notably a 192px
 * AND a 512px icon. With the criteria unmet there is no way to install at all.
 *
 * Install status feeds back into the storage-persistence heuristics:
 * `navigator.storage.persist()` is silently granted/denied based on site
 * engagement, installed/bookmarked status and notification permission. For a
 * local-first app whose entire workspace lives in OPFS with no server copy,
 * an install is the cheapest lever to flip Best-effort storage into
 * Persistent storage (protected from automatic eviction).
 *
 * Timing note: `beforeinstallprompt` can fire BEFORE React hydrates (the app
 * tree is client-only behind a dynamic-import gate). app/layout.tsx therefore
 * buffers the raw event on `window.__cwInstallPromptCapture` from an inline
 * script; the controller adopts the buffered event when constructed.
 *
 * Framework-free by design: state lives in a plain controller object so it
 * can be unit-tested without a DOM and consumed from React (or anything else).
 * Following the fx-rate.ts lesson: module-level mutable singletons plus
 * `vi.resetModules()` do not mix — the app uses the lazy default singleton
 * from `getInstallPromptController()`, tests build isolated instances via
 * `createInstallPromptController()`.
 */

export interface InstallPromptState {
  /** `beforeinstallprompt` was captured and `prompt()` is available. */
  available: boolean
  /** The app is already running as an installed app (display-mode). */
  installed: boolean
  /** User chose "not now" — never nag again (until the app is installed). */
  dismissed: boolean
}

export type InstallPromptOutcome = 'accepted' | 'dismissed' | 'unavailable'

/** localStorage key remembering the user's "not now" across sessions. */
const DISMISSAL_STORAGE_KEY = 'cw-pwa-install-dismissed-v1'

/** Global set by the inline capture script in app/layout.tsx (pre-hydration). */
const BUFFERED_EVENT_KEY = '__cwInstallPromptCapture'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export interface InstallPromptController {
  /**
   * Re-read persisted dismissal + installed display-mode. Call after mount
   * (listeners are wired at construction so no early event can be missed).
   */
  refresh(): void
  /**
   * Stable snapshot for `useSyncExternalStore` — the returned object identity
   * only changes when state actually changes.
   */
  getState(): InstallPromptState
  /** Synchronously read the persisted "not now" flag (localStorage). */
  isDismissedPersisted(): boolean
  /** Subscribe to state changes. Returns an unsubscribe function. */
  onStateChange(listener: () => void): () => void
  /** Show the native install dialog. Resolves with the user's choice. */
  prompt(): Promise<InstallPromptOutcome>
  /** Record the user's "not now" (persisted) and stop offering the card. */
  dismiss(): void
}

export function createInstallPromptController(win: Window): InstallPromptController {
  let capturedEvent: BeforeInstallPromptEvent | null = null
  let installed = false
  let dismissed = false
  const listeners = new Set<() => void>()

  // Stable snapshot object: useSyncExternalStore compares by identity.
  let state: InstallPromptState = { available: false, installed: false, dismissed: false }

  const commit = () => {
    const next: InstallPromptState = {
      available: capturedEvent !== null,
      installed,
      dismissed,
    }
    if (next.available !== state.available || next.installed !== state.installed || next.dismissed !== state.dismissed) {
      state = next
      listeners.forEach((listener) => listener())
    }
  }

  const readDismissal = (): boolean => {
    try {
      return win.localStorage.getItem(DISMISSAL_STORAGE_KEY) === '1'
    } catch {
      return false // storage unavailable — in-memory dismissal still works
    }
  }

  const detectInstalled = (): boolean => {
    // Desktop Chrome/Edge: display-mode media query. iOS Safari: the
    // non-standard navigator.standalone flag.
    try {
      if (typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches) {
        return true
      }
    } catch {
      // fall through to the iOS check
    }
    const iosNavigator = win.navigator as Navigator & { standalone?: boolean }
    return iosNavigator.standalone === true
  }

  // Wire listeners immediately — beforeinstallprompt can fire before the
  // React tree mounts, and a missed event cannot be replayed by Chrome.
  win.addEventListener('beforeinstallprompt', (event) => {
    // Suppress the browser's own mini-infobar; we own the install UX.
    event.preventDefault()
    capturedEvent = event as BeforeInstallPromptEvent
    if (process.env.NODE_ENV === 'development') {
      console.info('[PWA] beforeinstallprompt captured — install card eligible')
    }
    commit()
  })

  win.addEventListener('appinstalled', () => {
    installed = true
    capturedEvent = null // the captured event is spent once installed
    dismissed = false
    if (process.env.NODE_ENV === 'development') {
      console.info('[PWA] appinstalled — app is now running installed')
    }
    commit()
  })

  // Adopt an event buffered by the pre-hydration inline script, if any.
  const bufferedHost = win as unknown as Record<string, unknown>
  const buffered = bufferedHost[BUFFERED_EVENT_KEY]
  if (buffered) {
    capturedEvent = buffered as BeforeInstallPromptEvent
    try {
      delete bufferedHost[BUFFERED_EVENT_KEY]
    } catch {
      bufferedHost[BUFFERED_EVENT_KEY] = null
    }
    if (process.env.NODE_ENV === 'development') {
      console.info('[PWA] adopted pre-hydration install prompt capture')
    }
    commit()
  }

  return {
    refresh() {
      dismissed = dismissed || readDismissal()
      installed = installed || detectInstalled()
      commit()
    },

    getState: () => state,

    isDismissedPersisted: () => readDismissal(),

    onStateChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async prompt(): Promise<InstallPromptOutcome> {
      if (!capturedEvent) return 'unavailable'
      const event = capturedEvent
      // Chrome hands out exactly one prompt per page load: drop the capture
      // upfront so double-clicks cannot re-prompt and the card state stays
      // consistent even if userChoice rejects.
      capturedEvent = null
      commit()
      try {
        await event.prompt()
        return (await event.userChoice).outcome
      } catch {
        return 'unavailable'
      }
    },

    dismiss() {
      dismissed = true
      try {
        win.localStorage.setItem(DISMISSAL_STORAGE_KEY, '1')
      } catch {
        // storage unavailable — session-scoped dismissal only
      }
      commit()
    },
  }
}

let defaultController: InstallPromptController | null = null

/**
 * App-wide singleton (lazily created against the real `window`). Components
 * share one controller so a dismissal in one place is visible everywhere.
 */
export function getInstallPromptController(win?: Window): InstallPromptController {
  if (!defaultController) {
    const target = win ?? window
    defaultController = createInstallPromptController(target)
    // Dev-only diagnostic handle: `__cwInstallPrompt.getState()` from the
    // console is the single source of truth (the raw buffer global is
    // consumed on adoption, so it cannot be used as a probe).
    if (process.env.NODE_ENV === 'development') {
      (target as unknown as Record<string, unknown>).__cwInstallPrompt = defaultController
    }
  }
  return defaultController
}

/** Exported for tests — drops the singleton so each test starts clean. */
export function __resetDefaultInstallPromptControllerForTests(): void {
  defaultController = null
}
