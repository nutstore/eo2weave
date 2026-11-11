/**
 * Nutstore AI (坚果云 AI) — persisted provider id: `llm-gateway`
 *
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
const GATEWAY_CREDENTIAL_KEY_ALIAS = '__llm_gateway_token__'

/** Internal dispatch sentinel; it is not a credential-store key. */
export function getGatewayDispatchCredentialKey(): string {
  return GATEWAY_CREDENTIAL_KEY_ALIAS
}

export function isGatewayCredentialKey(providerKey: string | null | undefined): boolean {
  // Only the marker: the bare provider type is ALSO a valid id for a
  // custom provider, so matching it would misclassify that provider as the
  // gateway and route it through session resolution.
  return providerKey === GATEWAY_CREDENTIAL_KEY_ALIAS
}
