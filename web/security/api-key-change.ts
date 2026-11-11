/** Cross-tab notification contains only the provider identity, never its secret. */
export const API_KEY_CHANGE_STORAGE_KEY = 'eo2weave:api-key-change'

export function notifyApiKeyChanged(provider: string): void {
  // Gateway session keys have their own locking and cross-tab reconciliation.
  if (!provider || provider.startsWith('__') || provider === 'llm-gateway') return
  try {
    localStorage.setItem(API_KEY_CHANGE_STORAGE_KEY, JSON.stringify({
      provider, nonce: `${Date.now()}-${Math.random()}`,
    }))
  } catch {
    // Storage events are best-effort; a later provider switch rechecks SQLite.
  }
}
