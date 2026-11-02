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
//
// Residual race (suspension): a tab whose timers are SUSPENDED (background
// tab frozen by the browser, not crashed) stops heartbeating its entry, so
// after the entry TTL another tab treats the entry as abandoned and admits
// a credential commit while the suspended tab's op is still pending. The
// barrier alone cannot distinguish a frozen tab from a dead one, so a
// second mechanism fences the resumed op's late write: every credential
// commit under the lock stamps a monotonically increasing commit sequence
// into shared storage; each pending op records the sequence it observed at
// registration, and before its key-store write lands it re-reads the
// sequence — a newer commit (any commit orders the sequence bump before
// the resumed write, because both the bump and the earlier commit hold the
// credential lock) marks the op's write as stale, and the caller refuses
// it instead of overwriting the newer credential (see
// `pendingKeyStoreOpIsFenced`).

const PENDING_OPS_STORAGE_KEY = 'eo2weave-gateway-keystore-pending-ops'
/** Web Locks name serializing read-modify-write on the shared registry. */
const PENDING_OPS_COUNTER_LOCK = 'eo2weave-gateway-keystore-pending-ops-counter'
/**
 * Entries not refreshed within this window are treated as abandoned
 * (crashed tab) and pruned. A LIVE tab keeps its entry fresh with a
 * heartbeat (see below), so a genuinely long op never expires out of the
 * barrier while its tab still runs — only a dead tab's stale entry does.
 */
const PENDING_OPS_ENTRY_TTL_MS = 60_000
/**
 * Heartbeat interval keeping a live tab's entry past the entry TTL. A
 * SUSPENDED tab's heartbeat stops — its entry then expires out of the
 * barrier and another tab may commit while the suspended tab's op is
 * still pending. That residual window is closed by commit fencing (see
 * `pendingKeyStoreOpIsFenced` and the barrier comment above), not here:
 * a frozen tab cannot be distinguished from a crashed one by liveness
 * alone.
 */
const PENDING_OPS_HEARTBEAT_INTERVAL_MS = 30_000
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

// ── Commit fencing ───────────────────────────────────────────────────
//
// The barrier prunes an entry whose tab stopped heartbeating — but a
// SUSPENDED (frozen) tab is indistinguishable from a crashed one, so its
// still-pending op can survive past the TTL while another tab commits.
// Fencing closes that window: shared storage holds a commit SEQUENCE that
// `withGatewayCredentialLock` bumps on every credential commit; a pending
// op records the sequence it saw at registration, and the writer re-checks
// it just before its key-store write lands. A higher stored sequence means
// a newer commit fenced this op — the caller must discard its write (or
// retry) instead of overwriting the newer credential or undoing a logout.

/** Shared storage key holding the monotonically increasing commit sequence. */
const COMMIT_SEQ_STORAGE_KEY = 'eo2weave-gateway-credential-commit-seq'
/**
 * Shared storage key PREFIX for per-op fence stamps: each pending op records
 * its sequence under an INDEPENDENT key (`<prefix><opId>`) so concurrent
 * registrations in different tabs can never overwrite each other — a
 * read-modify-write of a shared seq map (the previous design) races when two
 * tabs register concurrently and the later whole-map write drops the
 * earlier op's record, leaving that op permanently unfenced. Per-op keys
 * need no cross-tab serialization at all: each write touches only its own
 * key, and a "missing" record (never written / swept) stays exactly the
 * pre-fencing no-op it already was for a storage outage. Sweep: settled ops
 * delete their own key via `deletePendingOpSeq`; a crashed tab's leftover
 * keys carry a bounded fence value (see `recordPendingOpSeq`) and are
 * removed opportunistically by the sweep below when the map of live stamps
 * is read.
 */
const PENDING_OP_SEQ_KEY_PREFIX = 'eo2weave-gateway-keystore-pending-op-seq:'

function readCommitSeq(): number {
  try {
    const raw = localStorage.getItem(COMMIT_SEQ_STORAGE_KEY)
    const n = raw === null ? 0 : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/** Read ONE op's fence stamp (undefined = unrecorded → never fenced). */
function readPendingOpSeq(opId: string): number | undefined {
  try {
    const raw = localStorage.getItem(PENDING_OP_SEQ_KEY_PREFIX + opId)
    if (raw === null) return undefined
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : undefined
  } catch {
    return undefined
  }
}

/**
 * Bump the shared commit sequence inside the credential lock's critical
 * section (called from `withGatewayCredentialLock` only, so commits cannot
 * interleave their bumps). Storage failures degrade to seq 0 — fencing is
 * then simply inert for this commit (the pre-fencing behavior), never a
 * broken commit.
 */
function bumpCommitSeq(): void {
  try {
    localStorage.setItem(COMMIT_SEQ_STORAGE_KEY, String(readCommitSeq() + 1))
  } catch {
    // Non-fatal: without the stamp the commit still proceeds (pre-fencing
    // semantics); pending ops observe an unchanged sequence and are not
    // fenced.
  }
}

/**
 * Record the CURRENT commit sequence for a pending op under its OWN storage
 * key. A later commit bumps the shared sequence past this value, fencing
 * the op's eventual write. Writes are op-scoped, so concurrent
 * registrations (this tab or another) cannot overwrite each other's stamps
 * — the lost-update race a shared seq map suffered is structurally
 * impossible. Must be called when the op is registered (synchronously with
 * the op's dispatch, before any commit can interleave).
 */
function recordPendingOpSeq(opId: string): void {
  try {
    localStorage.setItem(PENDING_OP_SEQ_KEY_PREFIX + opId, String(readCommitSeq()))
  } catch {
    // Non-fatal: an unrecorded op maps to undefined and is never fenced
    // (pre-fencing semantics for this op).
  }
}

/**
 * Remove one op's fence stamp. Only this op's key is touched — concurrent
 * registrations in other tabs are unaffected. A leftover stamp (crashed
 * tab, or a settle path that threw before the deferred delete) is harmless:
 * the key holds only a bounded registration sequence, and a future op id
 * collision (36^18 random suffixes) is astronomically unlikely — no sweep
 * pass over storage is needed.
 */
function deletePendingOpSeq(opId: string): void {
  try {
    localStorage.removeItem(PENDING_OP_SEQ_KEY_PREFIX + opId)
  } catch {
    // Non-fatal: a stale entry only over-fences (safe direction).
  }
}

/**
 * Whether a newer credential commit landed after `opId` registered — i.e.
 * the op's pending write would overwrite a newer credential or undo a
 * logout. Callers must re-check immediately before the write (not at
 * dispatch time): the fenced window is the whole pending duration.
 * Undefined (unrecorded — storage outage at registration) and 0 (no commit
 * has ever bumped the sequence) both read as NOT fenced.
 */
export function pendingKeyStoreOpIsFenced(opId: string): boolean {
  const seq = readPendingOpSeq(opId)
  if (seq === undefined) return false
  return readCommitSeq() > seq
}

/** Test hook: reset the fencing state (sequences live in shared storage). */
export function __resetGatewayCredentialFencingForTests(): void {
  try {
    localStorage.removeItem(COMMIT_SEQ_STORAGE_KEY)
    // Per-op stamps: remove every key under the fence-stamp prefix.
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key !== null && key.startsWith(PENDING_OP_SEQ_KEY_PREFIX)) doomed.push(key)
    }
    for (const key of doomed) localStorage.removeItem(key)
  } catch {
    // Ignore storage failures — tests fall back to a clean registry.
  }
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
export function trackPendingKeyStoreOp(op: Promise<unknown>): string {
  const tracked = op.then(
    () => {},
    () => {},
  )
  pendingKeyStoreOps.add(tracked)
  const opId = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  ownOpSettled.set(opId, false)
  // Stamp the CURRENT commit sequence for this op: any credential commit
  // that lands while the op stays pending bumps the shared sequence past
  // this value and fences the op's write (checked by the caller right
  // before it writes — `pendingKeyStoreOpIsFenced`). Synchronous with the
  // registration so no commit can interleave before the stamp.
  recordPendingOpSeq(opId)
  void rewriteOwnPendingOpEntry()
  // Heartbeat: refresh this tab's entry `updatedAt` while ANY op remains
  // unsettled, so a live tab's long-running op (past the entry TTL) stays
  // in the cross-tab barrier instead of being pruned as abandoned and
  // later overwriting a newer tab's credential commit. The timer is edge-
  // triggered (armed on unsettled, stopped at the last settle) — idle tabs
  // run no timers. A backgrounded tab whose timers are throttled keeps
  // refreshing at a throttled cadence; browsers only heavily throttle
  // timers in fully hidden tabs with chains >5, and even a slow heartbeat
  // (or one stale tick) still beats treating a live op as a crashed tab.
  // The interval timer handle lives on the module (one per tab, not per
  // op) so an uncaught settle path can never leak a timer.
  startPendingOpsHeartbeat()
  void tracked.finally(() => {
    pendingKeyStoreOps.delete(tracked)
    ownOpSettled.set(opId, true)
    // Defer the fence-record deletion by one macrotask: the caller's
    // landing-point fence check (see `pendingKeyStoreOpIsFenced`) runs in
    // MICROtasks right after the op settles, and microtasks always drain
    // before timers — deleting synchronously here would erase the op's
    // recorded sequence before the check reads it, silently disabling
    // mutation fencing (round-20).
    setTimeout(() => deletePendingOpSeq(opId), 0)
    void rewriteOwnPendingOpEntry()
    startPendingOpsHeartbeat()
  })
  return opId
}

let pendingOpsHeartbeatTimer: ReturnType<typeof setInterval> | null = null

/**
 * Keep this tab's registry entry fresh (heartbeat) while any of its ops is
 * unsettled; stop the timer at the last settle. Also a self-heal: a tab
 * whose write raced a pruner gets its entry re-added here.
 */
function startPendingOpsHeartbeat(): void {
  const hasUnsettled = [...ownOpSettled.values()].some((settled) => !settled)
  if (hasUnsettled && pendingOpsHeartbeatTimer === null) {
    pendingOpsHeartbeatTimer = setInterval(() => {
      if (![...ownOpSettled.values()].some((settled) => !settled)) {
        if (pendingOpsHeartbeatTimer !== null) {
          clearInterval(pendingOpsHeartbeatTimer)
          pendingOpsHeartbeatTimer = null
        }
        return
      }
      void rewriteOwnPendingOpEntry()
    }, PENDING_OPS_HEARTBEAT_INTERVAL_MS)
  } else if (!hasUnsettled && pendingOpsHeartbeatTimer !== null) {
    clearInterval(pendingOpsHeartbeatTimer)
    pendingOpsHeartbeatTimer = null
  }
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
    // Stamp THIS commit into the shared fencing sequence BEFORE running it.
    // Any key-store op registered earlier now reads a strictly higher
    // sequence, so a suspended tab's resumed op (its entry expired out of
    // the barrier while its promise was still pending) is fenced: the
    // op's caller re-checks `pendingKeyStoreOpIsFenced` right before its
    // write and refuses to overwrite this commit's credential state.
    bumpCommitSeq()
    return commit()
  })
}
