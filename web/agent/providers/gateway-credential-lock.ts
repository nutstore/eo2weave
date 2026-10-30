/** One origin-wide commit lock for gateway login, refresh and credential repair. */
export const GATEWAY_CREDENTIAL_LOCK = 'eo2weave-gateway-credential-commit'

interface GatewayWebLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
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
 */
export function trackPendingKeyStoreOp(op: Promise<unknown>): void {
  const tracked = op.then(
    () => {},
    () => {},
  )
  pendingKeyStoreOps.add(tracked)
  void tracked.finally(() => pendingKeyStoreOps.delete(tracked))
}

/**
 * Overall cap on the registry wait: an op that NEVER settles (a hung
 * worker) must not block credential commits forever. The bounded ops'
 * grace-resolved `settled` promises fire at deadline+grace, so lock
 * holders are never stuck — only this extra-conservative wait for the
 * real settlement is abandoned past the cap, with a diagnostic.
 */
const KEYSTORE_QUIESCENCE_CAP_MS = 30_000

/**
 * Wait until no bounded key-store op is pending. Loops because settling
 * these ops may itself schedule further bounded sub-ops.
 */
async function waitKeyStoreOpsQuiescent(): Promise<void> {
  const capAt = Date.now() + KEYSTORE_QUIESCENCE_CAP_MS
  while (pendingKeyStoreOps.size > 0) {
    const remaining = capAt - Date.now()
    if (remaining <= 0) {
      console.warn(
        '[gateway-credential-lock] key-store ops still pending after the quiescence cap — proceeding with the credential commit',
      )
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
      console.warn(
        '[gateway-credential-lock] key-store ops still pending after the quiescence cap — proceeding with the credential commit',
      )
      return
    }
  }
}

export function withGatewayCredentialLock<T>(commit: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined'
    ? undefined
    : (navigator as Navigator & { locks?: GatewayWebLocks }).locks
  // Without a cross-tab primitive, a local mutex cannot protect the shared
  // token pair and API-key store. Reject before writing either credential.
  if (!locks) return Promise.reject(new Error('Web Locks are required for safe gateway login.'))
  return locks.request(GATEWAY_CREDENTIAL_LOCK, async () => {
    // Wait out any grace-expired key-store ops from EARLIER lock holders
    // before this commit begins — the store must be quiescent so the
    // commit's read-modify-write sees their final effect.
    await waitKeyStoreOpsQuiescent()
    return commit()
  })
}
