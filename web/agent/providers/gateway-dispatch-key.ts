import { resolveGatewayDispatchCredential } from '@/agent/providers/llm-gateway-auth'
import { getLLMGatewayBaseURL, getLLMGatewayClientId } from '@/agent/providers/llm-gateway-provider'
import { isGatewayCredentialKey } from '@/agent/providers/gateway-credential-alias'

export type DispatchApiKey =
  | { ok: true; apiKey: string }
  | { ok: false; kind: 'expired' | 'missing' | 'temporary'; error?: Error }

/**
 * Resolve the credential a dispatch path must send, for a provider identified
 * by its api-key-store key.
 *
 * Most providers are "one key in the store". The gateway is a session, so it
 * has no store key to load (#277) — its token comes from the authoritative
 * resolver, which refreshes when needed and reports whether the session is
 * expired, missing, or temporarily unreadable. Call sites therefore pass the
 * key they loaded (if any) and get a uniform verdict instead of each one
 * hand-rolling the gateway special case.
 */
export async function resolveDispatchApiKey(
  providerKey: string | null | undefined,
  loadedKey: string | null | undefined,
): Promise<DispatchApiKey> {
  if (!isGatewayCredentialKey(providerKey)) {
    return loadedKey
      ? { ok: true, apiKey: loadedKey }
      : { ok: false, kind: 'missing' }
  }

  const resolved = await resolveGatewayDispatchCredential(
    getLLMGatewayBaseURL(),
    getLLMGatewayClientId(),
  )
  if (!resolved.ok) {
    return { ok: false, kind: resolved.kind, error: resolved.error as Error | undefined }
  }
  return { ok: true, apiKey: resolved.accessToken }
}
