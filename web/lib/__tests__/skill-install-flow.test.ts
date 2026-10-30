import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────

const { settingsState } = vi.hoisted(() => {
  const settingsState = {
    hasApiKey: false as boolean,
    providerType: 'llm-gateway' as string,
    switchProviderAndModel: (providerType: string, _modelName: string) => {
      settingsState.providerType = providerType
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
const loadApiKeyMock = vi.fn(async (provider: string) =>
  provider === 'openai' ? 'openai-key' : null,
)

vi.mock('@/security/api-key-store', () => ({
  getAllApiKeyProviders: (...args: unknown[]) => getAllApiKeyProvidersMock(...(args as [])),
  loadApiKey: (provider: string) => loadApiKeyMock(provider),
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

    const result = await checkAiReadiness()
    expect(result.ready).toBe(true)
    expect(result.creditExhausted).toBe(true)
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

    await expect(checkAiReadiness()).resolves.toEqual({ ready: true, creditExhausted: false })
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
