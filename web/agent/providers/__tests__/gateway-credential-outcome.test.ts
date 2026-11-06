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
 *   that already answered puts the switcher's "catalog unavailable" banner
 *   over a working model list, and it returns on every boot;
 * - a 'missing' session that stays registered leaves a provider whose catalog
 *   can never load in every future app context.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Region + client id must be set BEFORE the provider module is evaluated:
// `ENABLE_LLM_GATEWAY` (deploy-region) is a module-load constant, and the
// registration paths are no-ops on a build without the gateway.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_DEPLOY_REGION = 'cn'
  process.env.NEXT_PUBLIC_JIANGUOYUN_AI_CLIENT_ID = 'test-client'
})

import {
  applyGatewayCredentialOutcome,
  beginGatewayCatalogRefresh,
  isGatewayCredentialOutcomeCurrent,
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

function seedCatalog(models: ModelInfo[], catalogStatus: 'ready' | 'empty'): void {
  registerDynamicProvider(
    LLM_GATEWAY_PROVIDER_TYPE,
    { baseURL: 'https://gw.example/v1', modelName: models[0]?.id || '', headers: {}, apiMode: 'chat-completions' },
    { models, catalogStatus, category: 'chinese', displayName: 'Nutstore AI' },
  )
}

describe('applyGatewayCredentialOutcome', () => {
  beforeEach(() => {
    unregisterLLMGatewayProvider()
  })

  it('unregisters the provider for a never-signed-in session', () => {
    seedCatalog([model], 'ready')

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

  it('records an outage for an expired verdict while keeping the model list for display', () => {
    seedCatalog([model], 'ready')

    applyGatewayCredentialOutcome('expired')

    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('failed')
    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE)).toEqual([model])
  })

  it("does not demote a ready catalog when resolution is transient", () => {
    seedCatalog([model], 'ready')

    applyGatewayCredentialOutcome('temporary')

    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('ready')
    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE)).toEqual([model])
  })

  it("does not demote an authoritative empty catalog when resolution is transient", () => {
    // 'empty' is a POSITIVE answer ("this account is served no models"); a
    // transient credential failure says nothing about the catalog.
    seedCatalog([], 'empty')

    applyGatewayCredentialOutcome('temporary')

    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('empty')
  })

  it('marks a transient failure with nothing to show as failed so the switcher offers Retry', () => {
    // A context that never had a catalog and could not fetch one is not
    // "still loading": leaving it 'loading' hides the provider from the
    // switcher entirely, with no way to refresh.
    applyGatewayCredentialOutcome('temporary')

    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('failed')
  })

  it('leaves a newer catalog alone when its refresh version superseded this outcome', () => {
    seedCatalog([model], 'ready')
    const currentVersion = beginGatewayCatalogRefresh()

    applyGatewayCredentialOutcome('expired', currentVersion - 1)

    // The newer work owns the registry: neither its registration nor its
    // catalog may be touched by a superseded boot.
    expect(getProviderConfig(LLM_GATEWAY_PROVIDER_TYPE)).toBeTruthy()
    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('ready')
    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE)).toEqual([model])

    // ...and a current version does apply the outcome.
    applyGatewayCredentialOutcome('expired', beginGatewayCatalogRefresh())
    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('failed')
  })

  it('does not unregister a newer registration on a superseded missing verdict', () => {
    const currentVersion = beginGatewayCatalogRefresh()
    seedCatalog([model], 'ready')

    applyGatewayCredentialOutcome('missing', currentVersion - 1)

    expect(getProviderConfig(LLM_GATEWAY_PROVIDER_TYPE)).toBeTruthy()
    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE)).toEqual([model])
  })

  it('re-registers an absent provider on a superseded non-missing verdict', () => {
    const currentVersion = beginGatewayCatalogRefresh()

    applyGatewayCredentialOutcome('expired', currentVersion - 1)

    // Without this the purge would leave the gateway invisible with no
    // recovery entry at all.
    expect(getProviderConfig(LLM_GATEWAY_PROVIDER_TYPE)).toBeTruthy()
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
