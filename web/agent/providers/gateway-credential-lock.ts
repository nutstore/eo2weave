/** One origin-wide commit lock for gateway login, refresh and credential repair. */
export const GATEWAY_CREDENTIAL_LOCK = 'eo2weave-gateway-credential-commit'

interface GatewayWebLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
}

export function withGatewayCredentialLock<T>(commit: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined'
    ? undefined
    : (navigator as Navigator & { locks?: GatewayWebLocks }).locks
  // Without a cross-tab primitive, a local mutex cannot protect the shared
  // token pair and API-key store. Reject before writing either credential.
  if (!locks) return Promise.reject(new Error('Web Locks are required for safe gateway login.'))
  return locks.request(GATEWAY_CREDENTIAL_LOCK, commit)
}
