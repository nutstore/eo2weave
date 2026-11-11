/**
 * The api-key-store identity the gateway advertises in
 * `getEffectiveProviderConfig().apiKeyProviderKey`.
 *
 * The gateway has no API key of its own: its credential is the shared session
 * (token pair + durable refresh record). Generic key loaders, however, are all
 * shaped "load the key for this provider", so the effective config needs to
 * name *something*. This sentinel is that name, and its only remaining job is
 * to mark "this provider is not key-based — resolve the session instead"
 * (see `resolveDispatchApiKey`). Nothing stores a credential under it any more
 * (#277).
 *
 * Lives in its own leaf module so the auth layer, the settings store and the
 * dispatch helper can share it without an import cycle.
 */
export const GATEWAY_CREDENTIAL_KEY_ALIAS = '__llm_gateway_token__'

export function isGatewayCredentialKey(providerKey: string | null | undefined): boolean {
  return providerKey === GATEWAY_CREDENTIAL_KEY_ALIAS || providerKey === 'llm-gateway'
}
