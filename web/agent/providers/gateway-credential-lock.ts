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

/** Register an unsettled key-store op (called by the deadline helper). */
export function trackPendingKeyStoreOp(settled: Promise<void>): void {
  pendingKeyStoreOps.add(settled)
  void settled.finally(() => pendingKeyStoreOps.delete(settled))
}

/**
 * Wait until no bounded key-store op is pending. Loops because settling
 * these ops may itself schedule further bounded sub-ops.
 */
async function waitKeyStoreOpsQuiescent(): Promise<void> {
  while (pendingKeyStoreOps.size > 0) {
    await Promise.all([...pendingKeyStoreOps])
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
