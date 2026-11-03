/**
 * Cross-context advisory lock for WebMCP package operations (issue #117).
 *
 * Package transactions — install, uninstall, enable/disable — must run one
 * at a time per package id across EVERY context that can mutate the mount:
 * the settings page (through the provider bridge), the extension management
 * page and the background service worker. A module-local mutex only
 * serializes within one JS context, so an install in the settings tab and
 * an uninstall in the background could interleave and leave a torn package
 * behind.
 *
 * The lock lives in `chrome.storage.local` (visible to every extension
 * context) and uses a lease-and-heartbeat protocol:
 *
 *   1. Acquire writes `{ owner, expiresAt }` for the package id when no
 *      live lease exists; a stale lease (expired heartbeat) is stolen.
 *   2. The holder heartbeats the `expiresAt` forward while it works, so a
 *      crashed context's lease is detectably dead instead of blocking
 *      everyone forever.
 *   3. Release clears the key only when the caller still owns it — a lock
 *      that was stolen mid-transaction is never released by its loser.
 *
 * `chrome.storage.local` has no compare-and-swap primitive, so atomicity is
 * achieved CONTEXTUALLY: every lease caller in this codebase reaches
 * `acquireLease`/`heartbeatLease`/`releaseLease` from the BACKGROUND service
 * worker (pages go through the `webmcp_package_lock` bridge, management and
 * opt-in run in-process) — and a Chrome extension runs exactly ONE service
 * worker instance at a time. Each read→write→read-back sequence therefore
 * runs inside a PER-PACKAGE in-process promise queue (round-2 finding
 * "Concurrent package transactions corrupt data"): two acquirers interleave
 * only between sequences, never inside one, so the last writer of a sequence
 * is decided by the event loop, not by a storage race. A caller that lost
 * the race never sees itself as the owner: it verifies its own owner token
 * after the write or keeps waiting. (If a future context ever acquired the
 * lease directly from a page, this guarantee would not hold — the queue is
 * per JS context.)
 *
 * Two further rules close the stale-mutation gap (finding: "Stale writes
 * still overlap"):
 *
 *   - A new lease gets a full TTL from its grant time. A global clock
 *     boundary could otherwise expire it immediately after acquisition.
 *   - QUISCENCE: a transaction that LOSES its lease registers its still-
 *     pending callback promise on a per-package quiescence gate BEFORE the
 *     wrapper releases the lease, and the next `acquireLease` sequence
 *     waits on that gate (inside the same per-package queue) before it
 *     even reads the lease. The fences make the loser stop STARTING new
 *     writes; the gate makes the winner wait out the one write that was
 *     already in flight — so a stale write can never land under a new
 *     owner's lease.
 */

export { USER_PACKAGE_LOCK_KEY_PREFIX } from './package-lock-protocol'

import { USER_PACKAGE_LOCK_KEY_PREFIX } from './package-lock-protocol'

/** A lease must be heartbeated at least this often to stay alive. */
export const PACKAGE_LOCK_LEASE_TTL_MS = 15_000
const HEARTBEAT_INTERVAL_MS = 5_000
/** Conflict backoff bounds (jittered in between). */
const RETRY_MIN_MS = 40
const RETRY_MAX_MS = 200
/** Give up acquiring after this long — the operation fails with EBUSY. */
const ACQUIRE_TIMEOUT_MS = 30_000

interface LockLease {
  owner: string
  expiresAt: number
}

function lockKey(packageId: string): string {
  return `${USER_PACKAGE_LOCK_KEY_PREFIX}${packageId}`
}

function randomOwner(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `lock_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function readLease(raw: unknown): LockLease | null {
  if (
    typeof raw === 'object' && raw !== null &&
    typeof (raw as LockLease).owner === 'string' &&
    typeof (raw as LockLease).expiresAt === 'number'
  ) {
    return raw as LockLease
  }
  return null
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Per-package serialization of the lease's read→write→read-back sequences.
 * All lease callers live in the single background service worker (pages
 * reach the lease only through the `webmcp_package_lock` bridge), so
 * queueing the sequences in-process makes each one ATOMIC with respect to
 * every other lease caller — chrome.storage.local has no CAS, and this is
 * the only honest way to get the "last writer of a sequence is decided by
 * the event loop" guarantee the read-back verification relies on (round-2
 * finding: "Concurrent package transactions corrupt data").
 */
const leaseQueues = new Map<string, Promise<unknown>>()

function runExclusively<T>(packageId: string, step: () => Promise<T>): Promise<T> {
  const previous = leaseQueues.get(packageId) ?? Promise.resolve()
  const gate = previous.catch(() => {}).then(step)
  leaseQueues.set(packageId, gate)
  // Finding: "Lease failures cause unhandled rejections" — `gate` itself
  // rejects when `step` throws, and `gate.finally(...)` returns a NEW
  // promise that inherits that rejection; `void`-ing it left an unhandled
  // rejection even when the caller handled the step's failure. Chain
  // `catch` FIRST so the cleanup chain never carries a rejection, then run
  // the queue-entry cleanup on the (always-fulfilled) caught chain.
  void gate
    .catch(() => {})
    .finally(() => {
      if (leaseQueues.get(packageId) === gate) leaseQueues.delete(packageId)
    })
  return gate
}

/**
 * Quiescence gates per package id (finding: "Stale writes still overlap").
 * When a transaction LOSES its lease while its callback still has a
 * mutation in flight, the wrapper registers that pending callback here
 * BEFORE the `finally` releases the lease; the next acquirer's lease
 * sequence waits on the gate first. Without it, the released lease could
 * be granted to a new owner while the LOSING transaction's write was still
 * pending — the stale write landing under the new owner's lease.
 */
const quiescenceGates = new Map<string, Promise<unknown>>()

async function waitUntilPackageQuiescent(packageId: string): Promise<void> {
  const gate = quiescenceGates.get(packageId)
  if (gate) await gate.catch(() => {})
}

/** Low-level acquire: returns the owner token, or null on timeout. */
async function acquireLease(packageId: string, timeoutMs: number = ACQUIRE_TIMEOUT_MS): Promise<string | null> {
  const owner = randomOwner()
  const key = lockKey(packageId)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // QUISCENCE (finding: "Stale writes still overlap"): before even READING
    // the lease, wait out any losing transaction's still-pending mutation
    // that the previous owner registered on this package. The wait runs
    // before the read (and the conditioned write below runs as its own
    // queued step), so the grant decision is made no earlier than the
    // moment every stale mutation has settled.
    await waitUntilPackageQuiescent(packageId)
    const stored = await chrome.storage.local.get(key)
    const existing = readLease(stored[key])
    if (!existing || existing.expiresAt <= Date.now()) {
      // ATOMIC attempt (finding: "Concurrent package transactions corrupt
      // data"): the free-check → conditioned write → read-back verification
      // sequence runs inside the per-package queue, so a concurrent
      // acquirer can only start its own sequence AFTER this one finished —
      // it observes our lease live and waits instead of verifying its own
      // token over it. (Same guarantee as before, without the storage-level
      // interleaving window between the three storage calls.)
      const won = await runExclusively(packageId, async () => {
        // Re-wait INSIDE the queue too: a losing transaction may have
        // registered its gate after the read above but before this queued
        // step ran (the takeover that aborts it happens in between).
        await waitUntilPackageQuiescent(packageId)
        const atWrite = readLease((await chrome.storage.local.get(key))[key])
        if (atWrite && atWrite.expiresAt > Date.now()) return false
        await chrome.storage.local.set({ [key]: { owner, expiresAt: Date.now() + PACKAGE_LOCK_LEASE_TTL_MS } satisfies LockLease })
        // Read-back: the last writer wins; if we are not the owner any more,
        // another acquirer overwrote us and we must wait for it instead.
        const verify = readLease((await chrome.storage.local.get(key))[key])
        return verify?.owner === owner
      })
      if (won) return owner
    }
    if (Date.now() > deadline) return null
    await delay(RETRY_MIN_MS + Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS))
  }
}

/**
 * Extend OUR lease (heartbeat). Never resurrects a stolen lease; returns
 * FALSE when the lease is no longer ours so the holder can ABORT the
 * transaction instead of mutating an unlocked package (finding: "Expired
 * lock holders keep mutating"). The ownership check and the write run
 * inside the per-package queue, so a concurrent acquirer can never slip
 * between them and see its lease overwritten by this stale heartbeat
 * (round-2 finding: "Concurrent package transactions corrupt data").
 */
async function heartbeatLease(packageId: string, owner: string): Promise<boolean> {
  const key = lockKey(packageId)
  return runExclusively(packageId, async () => {
    const stored = readLease((await chrome.storage.local.get(key))[key])
    if (stored?.owner !== owner) return false
    await chrome.storage.local.set({ [key]: { owner, expiresAt: Date.now() + PACKAGE_LOCK_LEASE_TTL_MS } satisfies LockLease })
    return true
  })
}

/** Release the lease only if we still own it. */
async function releaseLease(packageId: string, owner: string): Promise<void> {
  const key = lockKey(packageId)
  try {
    await runExclusively(packageId, async () => {
      const stored = readLease((await chrome.storage.local.get(key))[key])
      if (stored?.owner === owner) await chrome.storage.local.remove(key)
    })
  } catch {
    // A leftover lease expires on its own via the TTL.
  }
}

/**
 * Run `fn` while holding the cross-context lock for one package id.
 *
 * `fn` receives the transaction's {@link AbortSignal}: it must check
 * `signal.aborted` between WRITE steps and stop (ideally roll back) instead
 * of continuing to mutate the package once the lease is gone (finding:
 * "Lost lease does not stop mutations"). The wrapper still fails the whole
 * call with `LOCK_LOST` when the heartbeat reports loss — even if `fn` had
 * already finished.
 */
export async function withPackageLock<T>(
  packageId: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const owner = await acquireLease(packageId)
  if (owner === null) {
    throw Object.assign(new Error(`Package ${packageId} is busy: another operation is in progress`), { code: 'EBUSY' })
  }
  // Finding: "Enable continues after lease loss" — when the heartbeat
  // reports `false` the lease EXPIRED and another context took it; the
  // callback must stop mutating state. The signal is surfaced so the
  // transaction can bail at its next step instead of writing unowned.
  const controller = new AbortController()
  // Finding: "Lease loss leaves writers active" — heartbeat STORAGE errors
  // (get/set rejecting) were swallowed, so a storage outage longer than the
  // lease TTL let the lease expire while the holder kept mutating. Count
  // consecutive failures: after two missed heartbeats (~2 TTLs with no
  // successful extension) the holder must assume the lease is gone and
  // abort — fail closed beats mutating an unowned package. A single
  // transient hiccup (one failed heartbeat followed by a good one) stays
  // harmless because the TTL only expires after 15s without a successful
  // refresh and one interval is 5s.
  let heartbeatFailures = 0
  const heartbeat = setInterval(() => {
    void heartbeatLease(packageId, owner).then(alive => {
      if (!alive) {
        controller.abort()
        return
      }
      heartbeatFailures = 0
    }, () => {
      heartbeatFailures += 1
      if (heartbeatFailures >= 2) controller.abort()
    })
  }, HEARTBEAT_INTERVAL_MS)
  let lockLost = false
  controller.signal.addEventListener('abort', () => { lockLost = true })
  // Transaction-internal cancellation (finding: "Lost lease does not stop
  // mutations"): `fn` receives this signal and checks it between WRITE
  // steps. Raising it here means a transaction that loses its lease stops
  // mutating the package at its very next write instead of finishing under
  // the new owner's lease.
  const loser = fn(controller.signal)
  void loser.catch(() => {}) // never an unhandled rejection while racing
  // QUISCENCE (finding: "Stale writes still overlap"): registered by the
  // abort listener — the MOMENT the lease loss is detected, while `fn` (and
  // its in-flight write) is still pending. The wrapper's `finally` runs only
  // after `await loser` in the loss path, and a replacement owner with an
  // already-expired/free lease could acquire in that window; the gate
  // registered here closes it. The GATE promise settles only when `fn`
  // settles, so any acquire attempt raised between "lease lost" and "stale
  // write settled" waits out the stale write.
  controller.signal.addEventListener('abort', () => {
    const gate = loser.catch(() => {})
    quiescenceGates.set(packageId, gate)
    void gate.finally(() => {
      if (quiescenceGates.get(packageId) === gate) quiescenceGates.delete(packageId)
    })
  })
  const winner = loser.then(result => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error }))
  const lost = new Promise<{ ok: false; error: unknown }>(resolve => {
    controller.signal.addEventListener('abort', () => {
      resolve({
        ok: false,
        error: Object.assign(new Error('The package transaction was aborted: the lease was lost mid-transaction'), {
          code: 'LOCK_LOST',
        }),
      })
    })
  })
  let raceLost = false
  const outcome = await Promise.race([
    winner,
    lost.then(result => { raceLost = true; return result }),
  ])
  try {
    if (!outcome.ok) {
      if (raceLost) {
        // Do NOT release the lease while a mutation of the LOSING
        // transaction is still pending (finding: "Stale writes corrupt
        // packages"): `fn`'s writes are fenced against this signal and
        // stop at their next fence, but a write that was ALREADY in
        // flight when the lease was lost can still be pending. Releasing
        // the lease now would let the next owner start mutating while
        // that stale write lands underneath it. Await the loser (its
        // fences make it settle promptly) before the finally releases.
        await loser.catch(() => {})
      }
      throw outcome.error
    }
    const { result } = outcome
    if (lockLost) {
      // `fn` finished right as the lease was lost — the writes are the new
      // owner's problem now, but the caller must not see a silent success.
      throw Object.assign(
        new Error(`The lease for ${packageId} was lost mid-transaction; re-run the operation`),
        { code: 'LOCK_LOST' },
      )
    }
    return result
  } catch (error) {
    if (lockLost && (error as { code?: string }).code !== 'LOCK_LOST') {
      throw Object.assign(new Error(`Operation on ${packageId} aborted: the package lock was lost mid-transaction`), { code: 'LOCK_LOST' })
    }
    throw error
  } finally {
    clearInterval(heartbeat)
    await releaseLease(packageId, owner)
  }
}

/**
 * Bridge-side lease used by pages that cannot touch chrome.storage
 * themselves (the settings page talks to the extension through the
 * content-script relay): acquire returns an owner token, and the page
 * heartbeats and releases with it. The token is unguessable (crypto UUID),
 * so another page cannot release or extend someone else's lease.
 */

/** Acquire on behalf of a bridge caller. Returns the owner token. */
export async function bridgeAcquirePackageLock(packageId: string, timeoutMs?: number): Promise<{ ok: boolean; owner?: string; code?: string }> {
  const owner = await acquireLease(packageId, timeoutMs)
  return owner === null ? { ok: false, code: 'EBUSY' } : { ok: true, owner }
}

/**
 * Heartbeat a bridge-held lease. `ok:false` means the lease was LOST
 * (expired and stolen) — the caller must abort its transaction.
 */
export async function bridgeHeartbeatPackageLock(packageId: string, owner: string): Promise<{ ok: boolean }> {
  const alive = await heartbeatLease(packageId, owner)
  return { ok: alive }
}

/** Release a bridge-held lease (owner-verified). */
export async function bridgeReleasePackageLock(packageId: string, owner: string): Promise<{ ok: boolean }> {
  await releaseLease(packageId, owner)
  return { ok: true }
}
