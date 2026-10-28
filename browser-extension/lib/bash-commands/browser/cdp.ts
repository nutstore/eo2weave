/// <reference types="chrome" />
// Adapted from agentic-sandbox browser automation.
export const CDP_VERSION = "1.3"

/**
 * Chrome keeps the "This extension is debugging your browser" banner up
 * until the extension detaches, so a tab used once would keep the banner
 * alive forever. Tabs without CDP activity for this long are detached
 * automatically; the next command re-attaches transparently.
 */
export const CDP_IDLE_TIMEOUT_MS = 120_000

/** Sweep alarm — covers service workers that were suspended or discarded. */
const IDLE_SWEEP_ALARM = "cw-cdp-idle-sweep"
const IDLE_SWEEP_MINUTES = 1
/** Last activity per tab, mirrored into session storage across SW restarts. */
const ACTIVITY_STORAGE_KEY = "cw_cdp_activity"
/** Storage writes are throttled — activity is recorded on every command. */
const ACTIVITY_PERSIST_INTERVAL_MS = 5_000

export const attachedTabs = new Set<number>()
const attachInFlight = new Map<number, Promise<void>>()

export type DebuggerSession = {
    tabId: number
    sessionId?: string
}

/** Epoch ms of the last CDP command per tab. */
const lastActivity = new Map<number, number>()
/** Pending idle-detach timers per tab (alive while the SW is running). */
const idleTimers = new Map<number, ReturnType<typeof setTimeout>>()
/** Last persisted epoch per tab (persist throttle). */
const tabPersistedAt = new Map<number, number>()
/** In-flight detaches — a command must not skip attaching while one runs. */
const detachInFlight = new Map<number, Promise<void>>()
let activityLoaded: Promise<void> | undefined

// Per-tab operation queue — serialises concurrent click/fill actions on the same tab.
const tabOpQueue = new Map<number, Promise<void>>()

export async function withTabLock<T>(
    tabId: number,
    fn: () => Promise<T>,
): Promise<T> {
    const prev = tabOpQueue.get(tabId) ?? Promise.resolve()
    let release!: () => void
    const barrier = new Promise<void>((r) => {
        release = r
    })
    tabOpQueue.set(tabId, barrier)
    await prev
    try {
        return await fn()
    } finally {
        release()
        if (tabOpQueue.get(tabId) === barrier) tabOpQueue.delete(tabId)
    }
}

export function getLastErrorMessage(): string | undefined {
    return chrome.runtime.lastError?.message
}

function sessionStore(): chrome.storage.StorageArea | undefined {
    try {
        return chrome.storage?.session
    } catch {
        return undefined
    }
}

/** Restore activity recorded before the service worker was discarded. */
async function loadPersistedActivity(): Promise<void> {
    if (activityLoaded) return activityLoaded
    activityLoaded = (async () => {
        const stored = (await sessionStore()?.get(ACTIVITY_STORAGE_KEY))?.[ACTIVITY_STORAGE_KEY]
        if (!stored || typeof stored !== "object") return
        for (const [tab, at] of Object.entries(stored as Record<string, unknown>)) {
            const tabId = Number(tab)
            const value = Number(at)
            if (!Number.isSafeInteger(tabId) || !Number.isFinite(value)) continue
            // Never overwrite fresher in-memory activity with an older snapshot.
            const known = lastActivity.get(tabId)
            if (known === undefined || value > known) lastActivity.set(tabId, value)
        }
    })().catch(() => {
        // Allow a later sweep to retry the read instead of caching the failure.
        activityLoaded = undefined
    })
    return activityLoaded
}

function persistActivity(force = false): void {
    const now = Date.now()
    // A per-tab guard, not a global one: throttling globally could drop a
    // just-activated tab from the stored snapshot, and a discarded service
    // worker would then leave its debugger attached forever (banner stays).
    let scheduled = 0
    for (const tabId of lastActivity.keys()) {
        if (!force && now - (tabPersistedAt.get(tabId) ?? 0) < ACTIVITY_PERSIST_INTERVAL_MS) continue
        tabPersistedAt.set(tabId, now)
        scheduleTabPersist(tabId)
        scheduled++
    }
    // Removals (detach, clearDebuggerState) shrink lastActivity without
    // scheduling anything; when the map empties, the final tab's timestamp
    // would linger in storage and every later sweep would revisit that tab.
    if (scheduled === 0 && lastActivity.size === 0) scheduleTabPersist(-1)
}

const pendingPersists = new Map<number, ReturnType<typeof setTimeout>>()

/**
 * Coalesce a tab's storage write; only the newest timestamp per tab lands.
 * The write hydrates persisted activity first: right after a service-worker
 * restart the in-memory map is empty or partial, and writing it directly
 * would erase other tabs' saved timestamps.
 */
function scheduleTabPersist(tabId: number): void {
    const pending = pendingPersists.get(tabId)
    if (pending !== undefined) clearTimeout(pending)
    const timer = setTimeout(() => {
        pendingPersists.delete(tabId)
        void loadPersistedActivity().then(writePersistedActivity)
    }, 0)
    pendingPersists.set(tabId, timer)
}

function writePersistedActivity(): void {
    const store = sessionStore()
    if (!store) return
    const snapshot: Record<string, number> = {}
    for (const [tabId, at] of lastActivity) snapshot[String(tabId)] = at
    void store.set({ [ACTIVITY_STORAGE_KEY]: snapshot }).catch(() => {})
}

function clearIdleTimer(tabId: number): void {
    const timer = idleTimers.get(tabId)
    if (timer === undefined) return
    clearTimeout(timer)
    idleTimers.delete(tabId)
}

/** (Re)arm the idle detach — a new command cancels the pending one. */
function armIdleTimer(tabId: number): void {
    clearIdleTimer(tabId)
    const timer = setTimeout(() => {
        idleTimers.delete(tabId)
        void detachIfIdle(tabId)
    }, CDP_IDLE_TIMEOUT_MS)
    idleTimers.set(tabId, timer)
}

/** Record CDP activity for a tab and restart its idle window. */
export function noteCdpActivity(tabId: number): void {
    lastActivity.set(tabId, Date.now())
    // Hydrate before the first write of this worker's lifetime: persisting a
    // snapshot from an empty in-memory map right after a restart would erase
    // the saved timestamps of every other attached tab.
    void loadPersistedActivity()
    persistActivity()
    armIdleTimer(tabId)
}

/**
 * Detach a tab that is still idle at fire time. The timestamp is re-checked
 * after the async attach check: a command that started meanwhile must not be
 * interrupted mid-operation.
 */
async function detachIfIdle(tabId: number): Promise<void> {
    if (!(attachedTabs.has(tabId) || await isDebuggerAttached(tabId))) return
    if (!isIdle(tabId)) {
        armIdleTimer(tabId)
        return
    }
    await detachDebugger(tabId)
}

function isIdle(tabId: number): boolean {
    const last = lastActivity.get(tabId)
    return last !== undefined && Date.now() - last >= CDP_IDLE_TIMEOUT_MS
}

/**
 * True when this extension's debugger is attached to the tab. The in-memory
 * attachedTabs set dies with a discarded service worker; getTargets survives.
 * Foreign sessions (devTools, other extensions) do not count — treating those
 * as ours would send commands into a session we cannot control.
 */
async function isDebuggerAttached(tabId: number): Promise<boolean> {
    try {
        const targets = await chrome.debugger.getTargets()
        return targets.some(target => target.tabId === tabId && target.attached
            && (!target.extensionId || target.extensionId === chrome.runtime.id))
    } catch {
        return false
    }
}

/** Detach every tab that has been idle past the timeout. */
export async function sweepIdleTabs(): Promise<void> {
    await loadPersistedActivity()
    for (const tabId of [...lastActivity.keys()]) {
        if (!isIdle(tabId)) continue
        // A discarded service worker loses attachedTabs while the debugger
        // stays attached — consult the browser, not the stale set.
        if (!(attachedTabs.has(tabId) || await isDebuggerAttached(tabId))) continue
        // A command may have started while the attach check was in flight.
        if (!isIdle(tabId)) continue
        await detachDebugger(tabId)
    }
}

/**
 * Register the idle sweep. A service worker can be suspended (freezing its
 * timers) or discarded (losing its memory), so the alarm keeps the sweep
 * running and session storage keeps the activity timestamps.
 */
export function installCdpIdleWatch(): void {
    try {
        chrome.alarms?.create(IDLE_SWEEP_ALARM, { periodInMinutes: IDLE_SWEEP_MINUTES })
        chrome.alarms?.onAlarm?.addListener?.((alarm: chrome.alarms.Alarm) => {
            if (alarm.name === IDLE_SWEEP_ALARM) void sweepIdleTabs()
        })
    } catch {
        // Alarms are unavailable (older browser, restricted context).
    }
}

export function attachDebugger(tabId: number): Promise<void> {
    return new Promise((resolve, reject) => {
        chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
            const err = getLastErrorMessage()
            if (err) {
                // A discarded service worker loses its attach bookkeeping while
                // the debugger stays attached — treat that as already attached,
                // but only when the attached debugger is OURS (devTools or
                // another extension owning the tab must surface as a failure).
                if (/already attached/i.test(err)) {
                    void isDebuggerAttached(tabId).then(ours => {
                        if (!ours) {
                            reject(new Error(err))
                            return
                        }
                        attachedTabs.add(tabId)
                        noteCdpActivity(tabId)
                        resolve()
                    })
                    return
                }
                reject(new Error(err))
                return
            }
            attachedTabs.add(tabId)
            noteCdpActivity(tabId)
            resolve()
        })
    })
}

export function detachDebugger(tabId: number): Promise<void> {
    const detaching = detachInFlight.get(tabId)
    if (detaching) return detaching
    // Register in-flight before invoking detach: a synchronous callback
    // (mocked APIs, some Chrome errors) would otherwise run and delete the
    // entry before the code below stores it, leaving the promise stranded in
    // the map and blocking every later detach of this tab.
    let resolveDetach!: () => void
    const promise = new Promise<void>((resolve) => { resolveDetach = resolve })
    detachInFlight.set(tabId, promise)
    chrome.debugger.detach({ tabId }, () => {
            detachInFlight.delete(tabId)
            // On failure the debugger may still be attached: keep the activity
            // record (and re-arm the idle timer) so cleanup can retry on the
            // next sweep — even when attachedTabs does not list the tab, e.g.
            // right after a service-worker restart, or the retried sweep would
            // have nothing to act on while the banner stays up.
            if (getLastErrorMessage()) {
                if (!idleTimers.has(tabId) && lastActivity.has(tabId)) armIdleTimer(tabId)
                resolveDetach()
                return
            }
            attachedTabs.delete(tabId)
            attachInFlight.delete(tabId)
            lastActivity.delete(tabId)
            tabPersistedAt.delete(tabId)
            clearIdleTimer(tabId)
            persistActivity(true)
            resolveDetach()
        })
    return promise
}

export function sendCommand<T = any>(
    target: number | DebuggerSession,
    method: string,
    params: Record<string, unknown> = {},
): Promise<T> {
    return new Promise((resolve, reject) => {
        chrome.debugger.sendCommand(
            typeof target === "number" ? { tabId: target } : target,
            method,
            params,
            (result: any) => {
                const err = getLastErrorMessage()
                if (err) {
                    reject(new Error(err))
                    return
                }
                noteCdpActivity(typeof target === "number" ? target : target.tabId)
                resolve(result as T)
            },
        )
    })
}

export async function ensureAttached(tabId: number) {
    // An idle-detach (or explicit detach) may be mid-flight for this tab:
    // waiting it out prevents sending CDP commands during detachment.
    const detaching = detachInFlight.get(tabId)
    if (detaching) await detaching.catch(() => {})
    if (attachedTabs.has(tabId)) return
    let attaching = attachInFlight.get(tabId)
    if (!attaching) {
        attaching = attachDebugger(tabId)
        attachInFlight.set(tabId, attaching)
        void attaching.then(
            () => {
                if (attachInFlight.get(tabId) === attaching) {
                    attachInFlight.delete(tabId)
                }
            },
            () => {
                if (attachInFlight.get(tabId) === attaching) {
                    attachInFlight.delete(tabId)
                }
            },
        )
    }
    await attaching
}

export function clearDebuggerState(tabId: number): void {
    // Hydrate first so the forced snapshot write below cannot erase records of
    // other attached tabs before this worker has read them.
    void loadPersistedActivity()
    attachedTabs.delete(tabId)
    attachInFlight.delete(tabId)
    lastActivity.delete(tabId)
    tabPersistedAt.delete(tabId)
    const pending = pendingPersists.get(tabId)
    if (pending !== undefined) { clearTimeout(pending); pendingPersists.delete(tabId) }
    clearIdleTimer(tabId)
    persistActivity(true)
}
