import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────

const { settingsState } = vi.hoisted(() => {
  const settingsState = {
    hasApiKey: false as boolean,
    providerType: 'llm-gateway' as string,
    lastUsedModelByProvider: {} as Record<string, string>,
    lastSwitchedModel: null as string | null,
    switchProviderAndModel: (providerType: string, modelName: string) => {
      settingsState.providerType = providerType
      settingsState.lastUsedModelByProvider[providerType] = modelName
      settingsState.lastSwitchedModel = modelName
    },
  }
  return { settingsState }
})

vi.mock('@/lib/deploy-region', () => ({
  ENABLE_LLM_GATEWAY: true,
  IS_CN_BUILD: true,
}))

const getValidAccessTokenMock = vi.fn<() => Promise<string | null>>()
const fetchGatewayRateLimitsMock = vi.fn<() => Promise<{ available_credit: number }>>()

vi.mock('@/agent/providers/llm-gateway-provider', () => ({
  ENABLE_LLM_GATEWAY: true,
  isLLMGatewayConfigured: () => true,
  getLLMGatewayBaseURL: () => 'https://gateway.example',
  getLLMGatewayClientId: () => 'client-1',
  LLM_GATEWAY_API_KEY_ID: '__llm_gateway_token__',
  LLM_GATEWAY_PROVIDER_TYPE: 'llm-gateway',
  fetchGatewayRateLimits: (...args: unknown[]) => fetchGatewayRateLimitsMock(...(args as [])),
}))

vi.mock('@/agent/providers/llm-gateway-auth', () => ({
  getValidAccessToken: (...args: unknown[]) => getValidAccessTokenMock(...(args as [])),
  LLM_GATEWAY_REFRESH_TOKEN_KEY_ID: '__llm_gateway_refresh_token__',
}))

vi.mock('@/store/settings.store', () => ({
  useSettingsStore: { getState: () => settingsState },
}))

const getAllApiKeyProvidersMock = vi.fn<() => Promise<string[]>>()
// Per-provider key lookup: "openai" has a saved key, others report none —
// used by the readiness branch that switches to a provider with a key.
const loadApiKeyMock = vi.fn<(
  provider: string,
) => Promise<string | null>>(async (provider: string) =>
  provider === 'openai' ? 'openai-key' : null,
)

vi.mock('@/security/api-key-store', () => ({
  getAllApiKeyProviders: (...args: unknown[]) => getAllApiKeyProvidersMock(...(args as [])),
  loadApiKey: (provider: string) => loadApiKeyMock(provider),
}))

vi.mock('@/agent/providers/types', () => ({
  // Registry lookups: `openai` is a built-in provider with a small catalog,
  // unknown ids (non-model secrets) resolve to null meta. Async-registered
  // ids count as model providers via the potentially-dynamic check.
  getModelsForProvider: (providerType: string) =>
    providerType === 'openai'
      ? [{ id: 'gpt-4o-mini', name: 'GPT-4o mini' }, { id: 'gpt-4o', name: 'GPT-4o' }]
      : [],
  getProviderMeta: (providerType: string) =>
    providerType === 'openai' ? { displayName: 'OpenAI' } : null,
  isPotentiallyDynamicProviderType: (type: string) =>
    type === 'llm-gateway' || type === 'codex-oauth' || type.startsWith('custom-'),
}))

vi.mock('@/agent/providers/default-models', () => ({
  DEFAULT_PINNED_MODELS: { openai: ['gpt-4o-mini'] },
}))

import {
  buildPrefillText,
  checkAiReadiness,
  mergePrefillText,
  pickConversationTarget,
  waitForCondition,
} from '@/lib/skill-install-flow'

describe('checkAiReadiness (issue #126 login-detection branches)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settingsState.hasApiKey = false
    settingsState.providerType = 'openai'
    settingsState.lastUsedModelByProvider = {}
    settingsState.lastSwitchedModel = null
    getAllApiKeyProvidersMock.mockResolvedValue([])
  })

  it('ready when the gateway has a valid access token (llm-gateway logged in)', async () => {
    getValidAccessTokenMock.mockResolvedValue('tok-1')
    fetchGatewayRateLimitsMock.mockResolvedValue({ available_credit: 100 })

    await expect(checkAiReadiness()).resolves.toEqual({ ready: true, creditExhausted: false })
    expect(getValidAccessTokenMock).toHaveBeenCalledWith('https://gateway.example', 'client-1')
  })

  it('flags creditExhausted when /v1/rate-limits reports 0 available credit', async () => {
    getValidAccessTokenMock.mockResolvedValue('tok-1')
    fetchGatewayRateLimitsMock.mockResolvedValue({ available_credit: 0 })
    // The selected provider is UNKEYED — readiness comes from the gateway,
    // and the flow switches the selection to it (the first conversation
    // request would otherwise go through the unconfigured provider).
    loadApiKeyMock.mockResolvedValueOnce(null)

    const result = await checkAiReadiness()
    expect(result.ready).toBe(true)
    expect(result.creditExhausted).toBe(true)
    expect(settingsState.providerType).toBe('llm-gateway')
  })

  it('keeps a keyed selected provider when the gateway is also ready', async () => {
    // The visitor's selected provider has its own usable key: their choice
    // stands (no switch to the gateway) and the gateway's credit state is
    // irrelevant to the conversation they will actually run.
    getValidAccessTokenMock.mockResolvedValue('tok-1')
    fetchGatewayRateLimitsMock.mockResolvedValue({ available_credit: 0 })

    const result = await checkAiReadiness()
    expect(result).toEqual({ ready: true, creditExhausted: false })
    expect(settingsState.providerType).toBe('openai')
  })

  it('RE-EVALUATES when the visitor switches mid-lookup and the OLD selection turns out keyed', async () => {
    // Sourcery round-18 (2026-10-31T00:20:21Z): the keyed-return in the
    // gateway-valid branch vouched for the provider it CHECKED, not the one
    // selected after the visitor's mid-lookup switch — the conversation
    // would start through an unconfigured provider. The lookup must be
    // followed by a fresh selection read: when it changed, the stale pass
    // restarts (the safe default is not-ready/login for an unconfigured
    // new choice), never plain ready for the checked provider.
    getValidAccessTokenMock.mockResolvedValue('tok-1')
    fetchGatewayRateLimitsMock.mockResolvedValue({ available_credit: 100 })
    settingsState.providerType = 'anthropic'
    let releaseLookup!: (value?: string) => void
    loadApiKeyMock.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          releaseLookup = (value?: string) => resolve(value ?? 'anthropic-key')
        }),
    )

    const pending = checkAiReadiness()
    for (let i = 0; i < 20 && releaseLookup === undefined; i++) {
      await Promise.resolve()
    }
    expect(releaseLookup).toBeTypeOf('function')
    // Visitor switches to an unconfigured provider while the selected
    // provider's key lookup is pending; the lookup then resolves WITH a key.
    settingsState.providerType = 'deepseek'
    releaseLookup()

    await expect(pending).resolves.toEqual({ ready: true, creditExhausted: false })
    // The stale pass must NOT vouch for the switched-away provider: the
    // restart re-evaluates the visitor's newer choice ('deepseek'), finds it
    // unconfigured, and — per the round-16 `!keyed` branch — switches the
    // selection to the gateway (which provably holds the valid token) so the
    // conversation never starts through an unconfigured provider.
    expect(settingsState.providerType).toBe('llm-gateway')
  })

  it('reports ready mid-lookup switch in the gateway branch only when the NEW provider is keyed', async () => {
    // Same race, but the NEW selection genuinely holds a key: readiness is
    // reported for the visitor's actual choice (no overwrite, no switch).
    getValidAccessTokenMock.mockResolvedValue('tok-1')
    fetchGatewayRateLimitsMock.mockResolvedValue({ available_credit: 100 })
    settingsState.providerType = 'anthropic'
    let releaseLookup!: (value?: string) => void
    loadApiKeyMock.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          releaseLookup = (value?: string) => resolve(value ?? 'anthropic-key')
        }),
    )
    loadApiKeyMock.mockImplementationOnce(async (provider: string) =>
      provider === 'deepseek' ? 'deepseek-key' : null,
    )

    const pending = checkAiReadiness()
    for (let i = 0; i < 20 && releaseLookup === undefined; i++) {
      await Promise.resolve()
    }
    expect(releaseLookup).toBeTypeOf('function')
    settingsState.providerType = 'deepseek'
    releaseLookup()

    await expect(pending).resolves.toEqual({ ready: true, creditExhausted: false })
    expect(settingsState.providerType).toBe('deepseek')
    // Restore the file-default per-provider mock so later tests are unaffected.
    loadApiKeyMock.mockImplementation(
      async (provider: string) => (provider === 'openai' ? 'openai-key' : null),
    )
  })

  it('does NOT fail readiness when the quota probe throws (best-effort)', async () => {
    getValidAccessTokenMock.mockResolvedValue('tok-1')
    fetchGatewayRateLimitsMock.mockRejectedValue(new Error('401'))

    await expect(checkAiReadiness()).resolves.toEqual({ ready: true, creditExhausted: false })
  })

  it('skips the gateway branch when no valid token (expired / never logged in)', async () => {
    getValidAccessTokenMock.mockResolvedValue(null)
    // Current provider is NOT the gateway → its saved key is an independent
    // credential → ready via branch 2.
    settingsState.providerType = 'openai'
    settingsState.hasApiKey = true

    await expect(checkAiReadiness()).resolves.toEqual({ ready: true, creditExhausted: false })
    expect(fetchGatewayRateLimitsMock).not.toHaveBeenCalled()
    settingsState.providerType = 'llm-gateway'
  })

  it('ready when settings.store.hasApiKey is true (current NON-gateway provider key)', async () => {
    getValidAccessTokenMock.mockResolvedValue(null)
    settingsState.providerType = 'openai'
    settingsState.hasApiKey = true
    await expect(checkAiReadiness()).resolves.toEqual({ ready: true, creditExhausted: false })
    // The gateway branch ran first (token null) but did NOT throw; the
    // settings branch is what made it ready.
    expect(fetchGatewayRateLimitsMock).not.toHaveBeenCalled()
    settingsState.providerType = 'llm-gateway'
  })

  it('an expired gateway credential does NOT count via settings.hasApiKey (no login skip)', async () => {
    // Gateway selected, token expired/purged, hasApiKey still true: the key
    // IS the unusable gateway token — readiness must NOT report ready (the
    // visitor would skip login and fail on the first send).
    getValidAccessTokenMock.mockResolvedValue(null)
    settingsState.providerType = 'llm-gateway'
    settingsState.hasApiKey = true
    getAllApiKeyProvidersMock.mockResolvedValue(['__llm_gateway_token__'])

    await expect(checkAiReadiness()).resolves.toEqual({ ready: false, creditExhausted: false })
  })

  it('ready when ANOTHER provider has a key in the api-key store', async () => {
    getValidAccessTokenMock.mockResolvedValue(null)
    // Fixture intentionally contains ONLY the non-gateway provider: the
    // ready assertion must depend on `openai` alone, not on the presence
    // of multiple provider ids or the gateway shadow.
    getAllApiKeyProvidersMock.mockResolvedValue(['openai'])
    // The visitor must END UP on the provider holding the saved key —
    // reporting ready while leaving the unconfigured provider selected
    // would fail on the first conversation send.
    settingsState.providerType = 'anthropic'

    await expect(checkAiReadiness()).resolves.toEqual({ ready: true, creditExhausted: false })
    expect(settingsState.providerType).toBe('openai')
    // The saved model resolution: last-used → default → first catalog entry.
    // No last-used model exists here, so the provider's DEFAULT wins and the
    // selection is NOT empty (an empty model would leave the conversation
    // without a selectable model and erase the saved preference).
    expect(settingsState.lastSwitchedModel).toBe('gpt-4o-mini')
  })

  it('switches to the candidate with its LAST-USED model when one is saved', async () => {
    getValidAccessTokenMock.mockResolvedValue(null)
    getAllApiKeyProvidersMock.mockResolvedValue(['openai'])
    settingsState.providerType = 'anthropic'
    settingsState.lastUsedModelByProvider = { openai: 'gpt-4o' }

    await expect(checkAiReadiness()).resolves.toEqual({ ready: true, creditExhausted: false })
    expect(settingsState.providerType).toBe('openai')
    // The visitor's saved last-used model must survive the switch — the
    // mock records the model argument, so an empty/default selection fails
    // this assertion.
    expect(settingsState.lastSwitchedModel).toBe('gpt-4o')
  })

  it('ignores non-model secret keys in the api-key store', async () => {
    // The api-key store also holds non-model secrets (e.g. Jianguoyun WebDAV
    // app passwords). Only a registered model provider's key counts as a
    // usable credential — selecting a secret id as the provider would start
    // the conversation with no usable model configuration.
    getValidAccessTokenMock.mockResolvedValue(null)
    getAllApiKeyProvidersMock.mockResolvedValue(['jianguoyun-webdav', 'some-random-secret'])
    settingsState.providerType = 'llm-gateway'
    settingsState.hasApiKey = false

    await expect(checkAiReadiness()).resolves.toEqual({ ready: false, creditExhausted: false })
    expect(settingsState.providerType).toBe('llm-gateway')
  })

  it('RE-CHECKS readiness when the visitor picks a provider while the key lookup is pending', async () => {
    // The visitor changed the selection while the candidate key lookup was
    // in flight: the stale probe must not overwrite their newer choice, but
    // it must ALSO not report ready without checking the new provider —
    // readiness is re-evaluated against 'deepseek' (which has no key).
    getValidAccessTokenMock.mockResolvedValue(null)
    getAllApiKeyProvidersMock.mockResolvedValue(['openai'])
    settingsState.providerType = 'anthropic'
    let releaseLookup!: (value?: string) => void
    loadApiKeyMock.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          releaseLookup = (value?: string) => resolve(value ?? 'openai-key')
        }),
    )

    const pending = checkAiReadiness()
    // Flush the probe chain until the candidate key lookup is actually
    // pending (token probe → getAllApiKeyProviders → loadApiKey), then
    // simulate the visitor selecting a different provider mid-lookup.
    for (let i = 0; i < 20 && releaseLookup === undefined; i++) {
      await Promise.resolve()
    }
    expect(releaseLookup).toBeTypeOf('function')
    settingsState.providerType = 'deepseek'
    releaseLookup()

    // The recheck finds 'deepseek' unconfigured and 'openai' keyed — the
    // corrected flow switches to the provider that actually has a key.
    await expect(pending).resolves.toEqual({ ready: true, creditExhausted: false })
    expect(settingsState.providerType).toBe('openai')
  })

  it('reports NOT ready when the visitor picks an UNCONFIGURED provider mid-lookup and nothing else is keyed', async () => {
    getValidAccessTokenMock.mockResolvedValue(null)
    settingsState.providerType = 'anthropic'
    settingsState.hasApiKey = false
    let releaseProbe!: () => void
    getAllApiKeyProvidersMock.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          releaseProbe = () => resolve([])
        }),
    )

    const pending = checkAiReadiness()
    for (let i = 0; i < 40 && releaseProbe === undefined; i++) {
      await Promise.resolve()
    }
    expect(releaseProbe).toBeTypeOf('function')
    // Visitor switches to an unconfigured provider while the probe runs.
    settingsState.providerType = 'deepseek'
    releaseProbe()

    await expect(pending).resolves.toEqual({ ready: false, creditExhausted: false })
    expect(settingsState.providerType).toBe('deepseek')
  })

  it('reports ready mid-lookup switch only when the NEW provider holds a live key', async () => {
    // Same race as above, but the new provider ('deepseek') genuinely has a
    // key in the store even though the cached flag was stale FALSE.
    getValidAccessTokenMock.mockResolvedValue(null)
    getAllApiKeyProvidersMock.mockResolvedValue(['openai', 'deepseek'])
    settingsState.providerType = 'anthropic'
    settingsState.hasApiKey = false
    // 1st call: the candidate 'openai' lookup pends so the visitor can
    // switch mid-flight; 2nd call (the race branch's re-validation) reads
    // 'deepseek' — the NEW selection — and finds a live key.
    let releaseLookup!: (value?: string) => void
    loadApiKeyMock.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          releaseLookup = (value?: string) => resolve(value ?? 'openai-key')
        }),
    )
    loadApiKeyMock.mockImplementationOnce(async (provider: string) =>
      provider === 'deepseek' ? 'deepseek-key' : null,
    )

    const pending = checkAiReadiness()
    for (let i = 0; i < 20 && releaseLookup === undefined; i++) {
      await Promise.resolve()
    }
    expect(releaseLookup).toBeTypeOf('function')
    settingsState.providerType = 'deepseek'
    releaseLookup()

    await expect(pending).resolves.toEqual({ ready: true, creditExhausted: false })
    expect(settingsState.providerType).toBe('deepseek')
    // Restore the file-default per-provider mock so later tests are unaffected.
    loadApiKeyMock.mockImplementation(
      async (provider: string) => (provider === 'openai' ? 'openai-key' : null),
    )
  })

  it('reports NOT ready (no switch) when the keyed candidate has no resolvable model', async () => {
    // A keyed dynamic provider with no catalog, no last-used model and no
    // default (e.g. a brand-new custom provider): resolving `''` and
    // switching would persist an empty model — readiness must stay false
    // and leave the visitor's selection untouched.
    getValidAccessTokenMock.mockResolvedValue(null)
    getAllApiKeyProvidersMock.mockResolvedValue(['custom-brand-new'])
    settingsState.providerType = 'openai'
    settingsState.hasApiKey = false
    loadApiKeyMock.mockImplementationOnce(async (provider: string) =>
      provider === 'custom-brand-new' ? 'custom-key' : null,
    )

    await expect(checkAiReadiness()).resolves.toEqual({ ready: false, creditExhausted: false })
    expect(settingsState.providerType).toBe('openai')
    expect(settingsState.lastSwitchedModel).toBeNull()
    // Restore the file-default per-provider mock so later tests are unaffected.
    loadApiKeyMock.mockImplementation(
      async (provider: string) => (provider === 'openai' ? 'openai-key' : null),
    )
  })

  it('gateway token-lookup failure falls through to other usable credentials', async () => {
    // The gateway probe itself throws (storage not ready) — a valid
    // other-provider key must still make the visitor ready.
    getValidAccessTokenMock.mockRejectedValue(new Error('token storage unavailable'))
    getAllApiKeyProvidersMock.mockResolvedValue(['openai'])

    await expect(checkAiReadiness()).resolves.toEqual({ ready: true, creditExhausted: false })
    expect(fetchGatewayRateLimitsMock).not.toHaveBeenCalled()
  })

  it('gateway token-lookup failure falls through to settings.hasApiKey', async () => {
    getValidAccessTokenMock.mockRejectedValue(new Error('token storage unavailable'))
    settingsState.providerType = 'openai'
    settingsState.hasApiKey = true

    await expect(checkAiReadiness()).resolves.toEqual({ ready: true, creditExhausted: false })
    settingsState.hasApiKey = false
    settingsState.providerType = 'llm-gateway'
  })

  it('gateway token-lookup failure with nothing else configured stays not-ready', async () => {
    getValidAccessTokenMock.mockRejectedValue(new Error('token storage unavailable'))

    await expect(checkAiReadiness()).resolves.toEqual({ ready: false, creditExhausted: false })
  })

  it('does NOT report ready when the cached hasApiKey flag is stale (key removed in another tab)', async () => {
    // Round-20: `hasApiKey` is a cached snapshot — another tab may have
    // removed the current provider's key without re-deriving the flag.
    // Readiness must verify the key against the LIVE store before
    // reporting ready.
    getValidAccessTokenMock.mockResolvedValue(null)
    settingsState.providerType = 'openai'
    settingsState.hasApiKey = true
    // No other provider holds a key either — nothing can rescue readiness.
    getAllApiKeyProvidersMock.mockResolvedValue([])
    loadApiKeyMock.mockImplementation(async () => null)

    await expect(checkAiReadiness()).resolves.toEqual({ ready: false, creditExhausted: false })
    // The stale branch actually probed the live store instead of trusting
    // the flag.
    expect(loadApiKeyMock).toHaveBeenCalledWith('openai')
    loadApiKeyMock.mockImplementation(
      async (provider: string) => (provider === 'openai' ? 'openai-key' : null),
    )
  })

  it('reports ready when the live store confirms the current provider key', async () => {
    // The flag is true AND the live store still holds the key: readiness
    // must not regress (the round-20 verification is additive, not a
    // new gate on the happy path).
    getValidAccessTokenMock.mockResolvedValue(null)
    settingsState.providerType = 'openai'
    settingsState.hasApiKey = true
    getAllApiKeyProvidersMock.mockResolvedValue([])
    loadApiKeyMock.mockImplementation(async (provider: string) =>
      provider === 'openai' ? 'openai-key' : null,
    )

    await expect(checkAiReadiness()).resolves.toEqual({ ready: true, creditExhausted: false })
    loadApiKeyMock.mockImplementation(
      async (provider: string) => (provider === 'openai' ? 'openai-key' : null),
    )
  })

  it('verifies the NEW selection when the visitor switches while the hasApiKey probe is pending', async () => {
    // Round-20: the visitor switches to an UNKEYED provider while the
    // current-provider key lookup is in flight — reporting ready for the
    // original (keyed) provider would vouch for a provider the conversation
    // will not use.
    getValidAccessTokenMock.mockResolvedValue(null)
    settingsState.providerType = 'openai'
    settingsState.hasApiKey = true
    getAllApiKeyProvidersMock.mockResolvedValue([])
    let releaseLookup!: () => void
    loadApiKeyMock.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          releaseLookup = () => resolve('openai-key')
        }),
    )
    // The re-validation of the NEW selection finds no key.
    loadApiKeyMock.mockImplementationOnce(async () => null)

    const pending = checkAiReadiness()
    for (let i = 0; i < 20 && releaseLookup === undefined; i++) {
      await Promise.resolve()
    }
    expect(releaseLookup).toBeTypeOf('function')
    settingsState.providerType = 'deepseek'
    releaseLookup()

    await expect(pending).resolves.toEqual({ ready: false, creditExhausted: false })
    loadApiKeyMock.mockImplementation(
      async (provider: string) => (provider === 'openai' ? 'openai-key' : null),
    )
  })

  it('reports ready when the visitor switches to a KEYED provider during the hasApiKey probe', async () => {
    getValidAccessTokenMock.mockResolvedValue(null)
    settingsState.providerType = 'openai'
    settingsState.hasApiKey = true
    getAllApiKeyProvidersMock.mockResolvedValue([])
    let releaseLookup!: () => void
    loadApiKeyMock.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          releaseLookup = () => resolve('openai-key')
        }),
    )
    loadApiKeyMock.mockImplementationOnce(async (provider: string) =>
      provider === 'anthropic' ? 'anthropic-key' : null,
    )

    const pending = checkAiReadiness()
    for (let i = 0; i < 20 && releaseLookup === undefined; i++) {
      await Promise.resolve()
    }
    expect(releaseLookup).toBeTypeOf('function')
    settingsState.providerType = 'anthropic'
    releaseLookup()

    await expect(pending).resolves.toEqual({ ready: true, creditExhausted: false })
    expect(settingsState.providerType).toBe('anthropic')
    loadApiKeyMock.mockImplementation(
      async (provider: string) => (provider === 'openai' ? 'openai-key' : null),
    )
  })

  it('still reports ready via the stale-flag branch when the key-store probe FAILS (non-timeout)', async () => {
    // Degradation discipline: a store failure (not a stall) must not turn
    // a ready visitor not-ready — the failure falls through to the broader
    // probe below, which keeps the happy path (flag true + scan finding
    // nothing else is not reached because the scan throws →
    // keyStoreUnavailable, but a KEYED scan result still rescues).
    getValidAccessTokenMock.mockResolvedValue(null)
    settingsState.providerType = 'openai'
    settingsState.hasApiKey = true
    loadApiKeyMock.mockRejectedValueOnce(new Error('sqlite unavailable'))
    getAllApiKeyProvidersMock.mockRejectedValueOnce(new Error('sqlite unavailable'))

    await expect(checkAiReadiness()).resolves.toEqual({
      ready: false,
      creditExhausted: false,
      keyStoreUnavailable: true,
    })
    loadApiKeyMock.mockImplementation(
      async (provider: string) => (provider === 'openai' ? 'openai-key' : null),
    )
  })

  it('not ready when nothing is configured (triggers the inline login step)', async () => {
    getValidAccessTokenMock.mockResolvedValue(null)
    await expect(checkAiReadiness()).resolves.toEqual({ ready: false, creditExhausted: false })
  })

  it('a gateway-token shadow alone does NOT count as another-provider key', async () => {
    getValidAccessTokenMock.mockResolvedValue(null)
    getAllApiKeyProvidersMock.mockResolvedValue(['__llm_gateway_token__'])

    await expect(checkAiReadiness()).resolves.toEqual({ ready: false, creditExhausted: false })
  })

  it('a gateway refresh-token backup alone does NOT count as another-provider key', async () => {
    // The SQLite refresh-token backup lives in the same api-key-store as real
    // provider keys; counting it as one let a visitor skip login with no
    // usable credential.
    getValidAccessTokenMock.mockResolvedValue(null)
    getAllApiKeyProvidersMock.mockResolvedValue(['__llm_gateway_refresh_token__'])

    await expect(checkAiReadiness()).resolves.toEqual({ ready: false, creditExhausted: false })
  })

  it('the refresh-token backup does not mask a missing key when mixed with the shadow', async () => {
    // Both gateway-owned keys present and nothing else: still not ready.
    getValidAccessTokenMock.mockResolvedValue(null)
    getAllApiKeyProvidersMock.mockResolvedValue([
      '__llm_gateway_token__',
      '__llm_gateway_refresh_token__',
    ])

    await expect(checkAiReadiness()).resolves.toEqual({ ready: false, creditExhausted: false })
  })

  it('does not trust cached hasApiKey for an expired selected gateway credential', async () => {
    settingsState.providerType = 'llm-gateway'
    settingsState.hasApiKey = true
    getValidAccessTokenMock.mockResolvedValue(null)
    getAllApiKeyProvidersMock.mockResolvedValue(['__llm_gateway_token__'])

    await expect(checkAiReadiness()).resolves.toEqual({ ready: false, creditExhausted: false })
  })

  it('offers a retry when the gateway token probe stalls and no other key exists', async () => {
    vi.useFakeTimers()
    try {
      getValidAccessTokenMock.mockReturnValue(new Promise(() => {}))
      const pending = checkAiReadiness()
      const assertion = expect(pending).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('key-store failure degrades to not-ready but flags the verdict as unproven', async () => {
    getValidAccessTokenMock.mockResolvedValue(null)
    getAllApiKeyProvidersMock.mockRejectedValue(new Error('storage not ready'))

    await expect(checkAiReadiness()).resolves.toEqual({
      ready: false,
      creditExhausted: false,
      keyStoreUnavailable: true,
    })
  })

  it('a STALLED gateway token probe propagates its retryable timeout (no login prompt)', async () => {
    vi.useFakeTimers()
    try {
      // A probe that NEVER settles: without the deadline readiness would
      // hang forever. A stalled probe means the outcome is UNKNOWN — the
      // timeout must surface so the page offers a retry instead of the
      // login step (or a false "ready" from an unproven credential).
      getValidAccessTokenMock.mockReturnValue(new Promise(() => {}))
      const pending = checkAiReadiness()
      const assertion = expect(pending).rejects.toThrow(/timed out.*try again/i)
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a valid gateway credential usable when the quota probe stalls', async () => {
    vi.useFakeTimers()
    try {
      getValidAccessTokenMock.mockResolvedValue('tok-1')
      fetchGatewayRateLimitsMock.mockReturnValue(new Promise(() => {}))
      const pending = checkAiReadiness()
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(pending).resolves.toEqual({ ready: true, creditExhausted: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('throws a retryable timeout error when the api-key store probe stalls', async () => {
    vi.useFakeTimers()
    try {
      getValidAccessTokenMock.mockResolvedValue(null)
      getAllApiKeyProvidersMock.mockReturnValue(new Promise(() => {}))
      const pending = checkAiReadiness()
      const assertion = expect(pending).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('pickConversationTarget (issue #126 navigation-target selection)', () => {
  const createNew = vi.fn(() => ({ id: 'new-conv-1' }))

  beforeEach(() => {
    createNew.mockClear()
  })

  it('picks the MOST RECENT workspace by lastAccessedAt when history exists', () => {
    const target = pickConversationTarget(
      [
        { id: 'old', lastAccessedAt: 1_000 },
        { id: 'recent', lastAccessedAt: 5_000 },
        { id: 'mid', lastAccessedAt: 3_000 },
      ],
      createNew,
    )
    expect(target).toEqual({ id: 'recent', created: false })
    expect(createNew).not.toHaveBeenCalled()
  })

  it('treats missing lastAccessedAt as 0 (oldest)', () => {
    const target = pickConversationTarget(
      [
        { id: 'no-ts' },
        { id: 'with-ts', lastAccessedAt: 42 },
      ],
      createNew,
    )
    expect(target.id).toBe('with-ts')
  })

  it('createNew() when there is no history; its id is the navigation target', () => {
    const target = pickConversationTarget([], createNew)
    expect(target).toEqual({ id: 'new-conv-1', created: true })
    expect(createNew).toHaveBeenCalledTimes(1)
  })

  it('createNew() when the list is non-empty but… empty arrays only — a single workspace is used directly', () => {
    const target = pickConversationTarget([{ id: 'only', lastAccessedAt: 1 }], createNew)
    expect(target).toEqual({ id: 'only', created: false })
  })
})

describe('buildPrefillText (issue #126 input prefill)', () => {
  it('bare slash command when no prompt param', () => {
    expect(buildPrefillText('cw-legal-evidence-chain')).toBe('/cw-legal-evidence-chain')
  })

  it('appends the prompt suffix separated by one space', () => {
    expect(buildPrefillText('cw-legal-evidence-chain', '整理本案证据链')).toBe(
      '/cw-legal-evidence-chain 整理本案证据链',
    )
  })

  it('trims whitespace-only prompts to the bare command', () => {
    expect(buildPrefillText('my-skill', '   ')).toBe('/my-skill')
  })
})

describe('mergePrefillText (issue #128 draft preservation)', () => {
  it('returns the bare prefill when the conversation has no draft', () => {
    expect(mergePrefillText(null, '/my-skill')).toBe('/my-skill')
    expect(mergePrefillText('', '/my-skill prompt')).toBe('/my-skill prompt')
  })

  it('keeps an existing unsent draft below the command', () => {
    expect(mergePrefillText('my unsent question', '/my-skill')).toBe(
      '/my-skill\nmy unsent question',
    )
  })

  it('is idempotent when the draft already starts with the command', () => {
    expect(mergePrefillText('/my-skill my unsent question', '/my-skill')).toBe(
      '/my-skill my unsent question',
    )
  })

  it('stacks the prefill when the draft starts with a LONGER command sharing the prefix', () => {
    // "/my-skill-extra" starts with "/my-skill" but is a different command —
    // the requested command must not be treated as already present.
    expect(mergePrefillText('/my-skill-extra old question', '/my-skill')).toBe(
      '/my-skill\n/my-skill-extra old question',
    )
  })

  it('stacks the prefill when the same command carries a DIFFERENT prompt', () => {
    expect(mergePrefillText('/my-skill old prompt', '/my-skill new prompt')).toBe(
      '/my-skill new prompt\n/my-skill old prompt',
    )
  })

  it('is idempotent when the draft matches the command AND the requested prompt exactly', () => {
    expect(mergePrefillText('/my-skill new prompt', '/my-skill new prompt')).toBe(
      '/my-skill new prompt',
    )
  })
})

describe('waitForCondition', () => {
  it('resolves true as soon as the predicate turns true', async () => {
    let ready = false
    setTimeout(() => { ready = true }, 50)
    await expect(waitForCondition(() => ready, 2_000, 20)).resolves.toBe(true)
  })

  it('resolves false on timeout (caller falls back safely)', async () => {
    await expect(waitForCondition(() => false, 150, 50)).resolves.toBe(false)
  })
})
