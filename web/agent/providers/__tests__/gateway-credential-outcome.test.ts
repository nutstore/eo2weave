/**
 * Regression tests for the credential-outcome writes (review of #221).
 *
 * `getValidAccessToken()` collapsed four credential states into `null`;
 * `resolveGatewayDispatchCredential()` keeps them apart, and each one needs a
 * DIFFERENT write. Getting it wrong is invisible in a happy-path test:
 *
 * - an 'expired' verdict has ALREADY purged the token pair, so branching on
 *   `hasStoredTokens()` treats a dead session as "never signed in" and makes
 *   the gateway (and its Retry / re-login route) disappear;
 * - a 'temporary' failure is not evidence of an outage: demoting a catalog
 *   that is already loaded puts the switcher's "catalog unavailable" banner
 *   over a working model list, and it returns on every boot;
 * - a 'missing' session that stays registered leaves a provider whose catalog
 *   can never load in every future app context.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  applyGatewayCredentialOutcome,
  isGatewayCredentialOutcomeCurrent,
  registerGatewayModels,
  unregisterLLMGatewayProvider,
  LLM_GATEWAY_PROVIDER_TYPE,
} from '@/agent/providers/llm-gateway-provider'
import { getModelsForProvider, getProviderCatalogStatus, getProviderConfig, registerDynamicProvider } from '@/agent/providers/types'
import type { ModelInfo } from '@/agent/providers/types'

const model: ModelInfo = {
  id: 'glm-5.2',
  name: 'GLM-5.2',
  capabilities: ['code', 'writing', 'reasoning'],
  contextWindow: 200_000,
}

function seedLoadedCatalog(): void {
  registerDynamicProvider(
    LLM_GATEWAY_PROVIDER_TYPE,
    { baseURL: 'https://gw.example/v1', modelName: model.id, headers: {}, apiMode: 'chat-completions' },
    { models: [model], catalogStatus: 'ready', category: 'chinese', displayName: 'Nutstore AI' },
  )
}

describe('applyGatewayCredentialOutcome', () => {
  beforeEach(() => {
    unregisterLLMGatewayProvider()
  })

  it('unregisters the provider for a never-signed-in session', () => {
    registerGatewayModels([model], 'ready')

    applyGatewayCredentialOutcome('missing')

    expect(getProviderConfig(LLM_GATEWAY_PROVIDER_TYPE)).toBeFalsy()
    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE)).toEqual([])
  })

  it("keeps an expired session's provider with a failed catalog so Retry/re-login stay reachable", () => {
    // The resolver purges the stored pair on an 'expired' verdict, so the
    // token store is empty by the time the caller sees the outcome — the
    // branch must key off the verdict, never off `hasStoredTokens()`.
    applyGatewayCredentialOutcome('expired')

    expect(getProviderConfig(LLM_GATEWAY_PROVIDER_TYPE)).toBeTruthy()
    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('failed')
  })

  it("does not demote a catalog that is already loaded when resolution is transient", () => {
    seedLoadedCatalog()

    applyGatewayCredentialOutcome('temporary')

    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('ready')
    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE)).toEqual([model])
  })

  it('marks a transient failure with nothing to show as failed so the switcher offers Retry', () => {
    // A context that never had a catalog and could not fetch one is not
    // "still loading": leaving it 'loading' hides the provider from the
    // switcher entirely, with no way to refresh.
    applyGatewayCredentialOutcome('temporary')

    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('failed')
  })

  it('ignores a stale catalog refresh version', () => {
    const staleVersion = -1

    applyGatewayCredentialOutcome('expired', staleVersion)

    expect(getProviderConfig(LLM_GATEWAY_PROVIDER_TYPE)).toBeFalsy()
  })
})

describe('isGatewayCredentialOutcomeCurrent', () => {
  it('accepts an unchanged generation', () => {
    expect(isGatewayCredentialOutcomeCurrent(4, 4, 'temporary')).toBe(true)
    expect(isGatewayCredentialOutcomeCurrent(4, 4, 'expired')).toBe(true)
    expect(isGatewayCredentialOutcomeCurrent(4, 4, 'missing')).toBe(true)
  })

  it("accepts the single bump an expired verdict's own purge causes", () => {
    expect(isGatewayCredentialOutcomeCurrent(4, 5, 'expired')).toBe(true)
  })

  it('rejects a bump that a non-purging verdict did not cause', () => {
    expect(isGatewayCredentialOutcomeCurrent(4, 5, 'temporary')).toBe(false)
    expect(isGatewayCredentialOutcomeCurrent(4, 5, 'missing')).toBe(false)
  })

  it('rejects a superseded session even for an expired verdict', () => {
    expect(isGatewayCredentialOutcomeCurrent(4, 6, 'expired')).toBe(false)
  })
})
