import { isGatewayCredentialKey, LLM_GATEWAY_REFRESH_TOKEN_KEY_ID } from '@/agent/providers/gateway-credential-alias'
import { SECRET_KEY_PREFIX } from '@/security/secret-key-scope'

/** Cross-tab notification contains only the provider identity, never its secret. */
export const API_KEY_CHANGE_STORAGE_KEY = 'eo2weave:api-key-change'

/** Gateway credentials and scoped secrets have their own storage semantics. */
export function isApiKeyProviderIdentity(provider: string): boolean {
  return !!provider && provider !== 'llm-gateway' && !isGatewayCredentialKey(provider) &&
    provider !== LLM_GATEWAY_REFRESH_TOKEN_KEY_ID && !provider.startsWith(SECRET_KEY_PREFIX)
}

export function notifyApiKeyChanged(provider: string): void {
  if (!isApiKeyProviderIdentity(provider)) return
  try {
    localStorage.setItem(API_KEY_CHANGE_STORAGE_KEY, JSON.stringify({
      provider, nonce: `${Date.now()}-${Math.random()}`,
    }))
  } catch {
    // Storage events are best-effort; a later provider switch rechecks SQLite.
  }
}
