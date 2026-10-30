/** One origin-wide commit lock for gateway login, refresh and credential repair. */
export const GATEWAY_CREDENTIAL_LOCK = 'eo2weave-gateway-credential-commit'

interface GatewayWebLocks {
  request<T>(name: string, callback: () => T | Promise<T>): Promise<T>
}

/**
 * Registry of key-store ops whose underlying promise has not settled yet —
 * shared with llm-gateway-auth so the lock can wait for grace-expired ops
 * (whose `settled` fired via the helper's grace timer, but whose real
 * completion is still pending) before granting a new credential commit.
 * Without this, a late write could land AFTER a newer login/logout
 * committed under the lock, corrupting the shared credential state.
 */
const pendingKeyStoreOps = new Set<Promise<void>>()

// ── Cross-tab pending-op barrier ─────────────────────────────────────
//
// `pendingKeyStoreOps` is module-local: promises cannot be observed from
// another tab, so a commit running in tab B has no way to wait on tab A's
// late key-store op through the registry alone. Pending ops are mirrored
// into a shared localStorage registry keyed by tab id: each entry holds the
// ids of the ops that tab has DISPATCHED but not yet seen settle. Entries
// are rewritten WHOLE from per-tab truth on every change — a delta counter
// would be vulnerable to a lost or double-applied decrement (a tab whose
// count drifts from its real promise set leaves a permanent ghost entry in
// the barrier, stalling every later commit until the cap). A crashed tab's
// entry is pruned after the TTL instead of blocking commits until the cap.
//
// Residual race (inherent to the browser): an op is dispatched (its promise
// created) a few microtasks BEFORE `trackPendingKeyStoreOp` registers it,
// so a commit in another tab that checks the barrier inside that window can
// miss an op that has already been dispatched. The window is sub-
// millisecond, versus the multi-second window this barrier closes.

const PENDING_OPS_STORAGE_KEY = 'eo2weave-gateway-keystore-pending-ops'
/** Web Locks name serializing read-modify-write on the shared registry. */
const PENDING_OPS_COUNTER_LOCK = 'eo2weave-gateway-keystore-pending-ops-counter'
/** Entries older than this are treated as abandoned (crashed tab) and pruned. */
const PENDING_OPS_ENTRY_TTL_MS = 60_000
/** Poll interval while waiting for OTHER tabs' pending ops to settle. */
const CROSS_TAB_POLL_INTERVAL_MS = 100

interface PendingOpEntry {
  /** Ids of this tab's dispatched-but-unsettled key-store ops. */
  ops: string[]
  updatedAt: number
}

let ownTabId: string | null = null
/** Per-op settled flag — the single source of truth for this tab's entry. */
const ownOpSettled = new Map<string, boolean>()

function getOwnTabId(): string {
  if (ownTabId === null) {
    ownTabId = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
  return ownTabId
}

function getWebLocks(): GatewayWebLocks | null {
  if (typeof navigator === 'undefined') return null
  return (navigator as Navigator & { locks?: GatewayWebLocks }).locks ?? null
}

function readPendingOpEntries(): Record<string, PendingOpEntry> {
  try {
    const raw = localStorage.getItem(PENDING_OPS_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, PendingOpEntry>
  } catch {
    return {}
  }
}

function writePendingOpEntries(entries: Record<string, PendingOpEntry>): void {
  try {
    localStorage.setItem(PENDING_OPS_STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // A storage outage must not break credential commits — the local
    // promise registry (phase 1) still protects this tab's own ops.
  }
}

function isAbandonedEntry(entry: PendingOpEntry | undefined): boolean {
  return (
    !entry ||
    !Array.isArray(entry.ops) ||
    typeof entry.updatedAt !== 'number' ||
    entry.updatedAt < Date.now() - PENDING_OPS_ENTRY_TTL_MS
  )
}

/**
 * Rewrite this tab's entry in the SHARED registry from `ownOpSettled` —
 * the per-op truth this tab holds. Whole-state replacement: no delta to
 * lose or double-apply. Runs under the counter Web Lock so concurrent
 * rewrites from two tabs cannot overwrite each other's entries.
 * Fire-and-forget: a failed rewrite degrades to the pre-barrier behavior,
 * never blocks or breaks the caller.
 */
async function rewriteOwnPendingOpEntry(): Promise<void> {
  const locks = getWebLocks()
  if (!locks) return
  try {
    await locks.request(PENDING_OPS_COUNTER_LOCK, () => {
      const entries = readPendingOpEntries()
      // Prune abandoned entries (crashed tab) while holding the lock.
      for (const [id, entry] of Object.entries(entries)) {
        if (isAbandonedEntry(entry)) delete entries[id]
      }
      const unsettled = [...ownOpSettled.entries()]
        .filter(([, settled]) => !settled)
        .map(([opId]) => opId)
      if (unsettled.length === 0) delete entries[getOwnTabId()]
      else entries[getOwnTabId()] = { ops: unsettled, updatedAt: Date.now() }
      writePendingOpEntries(entries)
    })
  } catch {
    // Non-fatal: fall back to this tab's local registry only.
  }
}

/**
 * Total pending key-store ops across ALL tabs (including this one). The
 * read takes the counter lock so it cannot interleave with another tab's
 * in-flight rewrite. Returns 0 when Web Locks are unavailable (then only
 * the local registry protects the commit, as before).
 */
async function crossTabPendingOps(): Promise<number> {
  const locks = getWebLocks()
  if (!locks) return 0
  try {
    return await locks.request(PENDING_OPS_COUNTER_LOCK, () => {
      let total = 0
      for (const entry of Object.values(readPendingOpEntries())) {
        if (isAbandonedEntry(entry)) continue
        total += entry.ops.length
      }
      return total
    })
  } catch {
    return 0
  }
}

/**
 * Register an unsettled key-store op (called by the deadline helper).
 *
 * The registry tracks the UNDERLYING op's real settlement (rejections
 * ignored), NOT the grace-resolved `settled` promise: an op that ran past
 * its deadline and grace period can still write or delete after `settled`
 * fired — dropping it from the registry then would let
 * `withGatewayCredentialLock` admit a newer credential commit while the
 * old operation is still in flight, letting it overwrite newer
 * credentials or undo a logout.
 *
 * The op is ALSO listed in the shared cross-tab registry so commits in
 * other tabs wait for it too (see the barrier comment above).
 */
export function trackPendingKeyStoreOp(op: Promise<unknown>): void {
  const tracked = op.then(
    () => {},
    () => {},
  )
  pendingKeyStoreOps.add(tracked)
  const opId = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  ownOpSettled.set(opId, false)
  void rewriteOwnPendingOpEntry()
  void tracked.finally(() => {
    pendingKeyStoreOps.delete(tracked)
    ownOpSettled.set(opId, true)
    void rewriteOwnPendingOpEntry()
  })
}

/**
 * Overall cap on the quiescence wait: an op that NEVER settles (a hung
 * worker) must not block credential commits forever. The bounded ops'
 * grace-resolved `settled` promises fire at deadline+grace, so lock
 * holders are never stuck — only this extra-conservative wait for the
 * real settlement is abandoned past the cap, with a diagnostic.
 */
const KEYSTORE_QUIESCENCE_CAP_MS = 30_000

/**
 * Wait until no bounded key-store op is pending — in this tab (precise:
 * the real promises are awaited) and in any other tab (polled through the
 * shared registry). Loops because settling these ops may itself schedule
 * further bounded sub-ops.
 */
async function waitKeyStoreOpsQuiescent(): Promise<void> {
  const capAt = Date.now() + KEYSTORE_QUIESCENCE_CAP_MS
  const warnCapped = () => {
    console.warn(
      '[gateway-credential-lock] key-store ops still pending after the quiescence cap — proceeding with the credential commit',
    )
  }
  // Phase 1 — this tab's registry: await the real promises directly.
  while (pendingKeyStoreOps.size > 0) {
    const remaining = capAt - Date.now()
    if (remaining <= 0) {
      warnCapped()
      return
    }
    let capped = false
    await Promise.race([
      Promise.all([...pendingKeyStoreOps]),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          capped = true
          resolve()
        }, remaining)
      }),
    ])
    if (capped) {
      warnCapped()
      return
    }
  }
  // Phase 2 — other tabs' ops: promises are tab-local, only the shared
  // registry is visible. Poll until every tab reports quiescence; entries
  // abandoned by a crashed tab expire via the TTL instead of stalling
  // commits until the cap.
  for (;;) {
    if ((await crossTabPendingOps()) === 0) {
      // Grant handshake: an op can exist that is dispatched but NOT yet
      // registered (the microtasks between `withKeyStoreDeadline`'s promise
      // creation and `trackPendingKeyStoreOp`'s registry write). When the
      // barrier is empty, re-sample it once more after a macrotask: an op
      // dispatched before we entered the lock (in any tab) must have
      // completed its registration by then, so the re-sample either still
      // shows quiescence (safe — anything dispatched after our GRANT
      // belongs to a LATER lock holder, which the Web Lock serializes
      // behind us) or reveals the missed registration.
      await new Promise((resolve) => setTimeout(resolve, 0))
      if ((await crossTabPendingOps()) === 0) return
    }
    const remaining = capAt - Date.now()
    if (remaining <= 0) {
      warnCapped()
      return
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(CROSS_TAB_POLL_INTERVAL_MS, remaining)),
    )
  }
}

export function withGatewayCredentialLock<T>(commit: () => Promise<T>): Promise<T> {
  const locks = getWebLocks()
  // Without a cross-tab primitive, a local mutex cannot protect the shared
  // token pair and API-key store. Reject before writing either credential.
  if (!locks) return Promise.reject(new Error('Web Locks are required for safe gateway login.'))
  return locks.request(GATEWAY_CREDENTIAL_LOCK, async () => {
    // Wait out any grace-expired key-store ops from EARLIER lock holders —
    // in this tab AND in other tabs (shared registry) — before this commit
    // begins: the store must be quiescent so the commit's read-modify-write
    // sees their final effect.
    await waitKeyStoreOpsQuiescent()
    return commit()
  })
}
