import { t } from '@creatorweave/i18n'
import { useI18nStore } from '@/i18n/store'
import { isGatewayCredentialKey } from '@/agent/providers/gateway-credential-alias'
import type { DispatchApiKey } from '@/agent/providers/gateway-dispatch-key'

/** Describe the recovery action without exposing storage or refresh errors. */
export function describeCredentialFailure(
  failure: Extract<DispatchApiKey, { ok: false }>,
  providerKey: string,
): { code: string; message: string; retryable: boolean } {
  const key = failure.kind === 'temporary'
    ? 'credential.temporary.retry'
    : failure.kind === 'expired'
      ? 'credential.expired.signIn'
      : isGatewayCredentialKey(providerKey)
        ? 'credential.missing.signIn'
        : 'credential.missing.configure'

  return {
    code: `credential_${failure.kind}`,
    message: t(useI18nStore.getState().locale, key),
    retryable: failure.kind === 'temporary',
  }
}
