import { describe, expect, it } from 'vitest'
import { RESOLUTION_COUNTS, resetResolutionCounts, resolvePiAIModel } from '@/agent/llm/pi-ai-model-resolver'
import { getOpenRouterInputModalities } from '@/agent/providers/openrouter-pricing'

// setCachedModels seeds a module-level memory cache that removeItem alone
// cannot clear (Sourcery: "Cached fixture leaks between tests") — reset the
// memory layer through the public API by overwriting it with an empty result.
async function clearModelCache(providerType: string): Promise<void> {
  const mod = await import('@/agent/providers/model-store')
  const clear = (mod as unknown as { __clearMemoryCacheForTests?: (k: string) => void }).__clearMemoryCacheForTests
  if (clear) clear(providerType)
}

describe('resolvePiAIModel', () => {
  it('should resolve known native provider/model', () => {
    const model = resolvePiAIModel('openai', 'gpt-4o', 'https://api.openai.com/v1')
    expect(model.provider).toBe('openai')
    expect(model.id).toBe('gpt-4o')
  })

  it('should use alias for known model mismatch', () => {
    const model = resolvePiAIModel('google', 'gemini-2.0-pro', 'https://generativelanguage.googleapis.com/v1beta')
    expect(model.provider).toBe('google')
    expect(model.id).toBe('gemini-2.0-flash')
  })

  it('should fallback to openai-completions for custom provider', () => {
    const model = resolvePiAIModel('custom', 'my-model', 'https://example.com/v1/')
    expect(model.api).toBe('openai-completions')
    expect(model.id).toBe('my-model')
    expect(model.baseUrl).toBe('https://example.com/v1')
  })

  it('should fallback for unknown model on known provider', () => {
    const model = resolvePiAIModel('anthropic', 'non-existent-model', 'https://api.anthropic.com/v1')
    expect(model.api).toBe('openai-completions')
    expect(model.provider).toBe('anthropic')
  })

  it('should resolve latest GLM models', () => {
    const model = resolvePiAIModel('glm-coding', 'glm-5', 'https://open.bigmodel.cn/api/coding/paas/v4/')
    expect(model.provider).toBe('glm-coding')
    expect(model.id).toBe('glm-5')
  })

  it('should map MiniMax M2.7 to custom fetch fallback for browser CORS safety', () => {
    const model = resolvePiAIModel('minimax', 'MiniMax-M2.7', 'https://api.minimax.io/v1')
    expect(model.provider).toBe('minimax')
    expect(model.id).toBe('MiniMax-M2.7')
    expect(model.api).toBe('cw-openai-fetch')
  })

  it('should map MiniMax M2.7 to custom fetch fallback for minimax-cn', () => {
    const model = resolvePiAIModel('minimax-cn', 'MiniMax-M2.7', 'https://api.minimaxi.com/v1')
    expect(model.provider).toBe('minimax-cn')
    expect(model.id).toBe('MiniMax-M2.7')
    expect(model.api).toBe('cw-openai-fetch')
  })

  // ── Nutstore AI gateway (llm-gateway): never emit role:"developer" ──────
  // The gateway's upstream backends include direct vendor APIs that reject
  // role:"developer" with 400 ("is not one of ['system', 'assistant',
  // 'user', 'tool', 'function']"). The resolver must route llm-gateway
  // through cw-openai-fetch (which always emits system) AND declare
  // compat.supportsDeveloperRole:false as belt-and-braces.

  it('should map llm-gateway to custom fetch fallback even when not registered', () => {
    // Deliberately called WITHOUT registering the dynamic provider first —
    // isPotentiallyDynamicProviderType('llm-gateway') is true by id, but the
    // point is that the answer must not depend on registration state at all:
    // before this predicate existed, an unregistered provider fell through to
    // pi-ai's openai-completions handler.
    const model = resolvePiAIModel('llm-gateway', 'gpt-4o', 'https://ai.jianguoyun.com/v1')
    expect(model.provider).toBe('llm-gateway')
    expect(model.api).toBe('cw-openai-fetch')
  })

  it('should map unregistered custom-* providers to custom fetch fallback too', () => {
    // custom-* provider ids are restored asynchronously from persisted
    // settings; before restore completes isCustomProviderType is false. They
    // must still avoid pi-ai's built-in openai-completions handler for the
    // same developer-role reason.
    const model = resolvePiAIModel('custom-1758123456789-abc123', 'my-model', 'https://my-proxy.example.com/v1')
    expect(model.api).toBe('cw-openai-fetch')
  })

  it('should declare llm-gateway fallback models as not supporting developer role', () => {
    const model = resolvePiAIModel('llm-gateway', 'some-gateway-model', 'https://ai.jianguoyun.com/v1')
    // Model<Api>'s compat is a union across API flavors; only the
    // openai-completions flavor carries supportsDeveloperRole.
    const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined
    expect(compat?.supportsDeveloperRole).toBe(false)
  })

  // ── Chinese providers: OpenAI-compatible EXCEPT the developer role ──────
  // category:'chinese' providers must never emit role:"developer" — their
  // endpoints reject it with 400 even though everything else is compatible.
  // pi-ai's detectCompat() only knows deepseek/moonshot/zai URLs, so qwen
  // (dashscope) and volcengine-coding (ark.volces.com) rely on the explicit
  // compat flag.

  it('should declare qwen fallback models as not supporting developer role', () => {
    const model = resolvePiAIModel('qwen', 'qwen-max', 'https://dashscope.aliyuncs.com/compatible-mode/v1')
    const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined
    expect(compat?.supportsDeveloperRole).toBe(false)
  })

  it('should declare volcengine-coding fallback models as not supporting developer role', () => {
    const model = resolvePiAIModel('volcengine-coding', 'kimi-k2', 'https://ark.cn-beijing.volces.com/api/coding')
    const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined
    expect(compat?.supportsDeveloperRole).toBe(false)
  })

  it('should keep developer role allowed for international providers', () => {
    // Guard against over-broadening: OpenAI itself speaks developer natively.
    const model = resolvePiAIModel('openrouter', 'openai/gpt-5.6', 'https://openrouter.ai/api/v1')
    const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined
    expect(compat?.supportsDeveloperRole).not.toBe(false)
  })

  // ── Vision capability via OpenRouter modalities ─────────────────────────

  it('should resolve codex-oauth vision model with image input', () => {
    const model = resolvePiAIModel('codex-oauth', 'gpt-5.6-terra', 'https://chatgpt.com/backend-api/codex')
    expect(model.provider).toBe('codex-oauth')
    expect(model.id).toBe('gpt-5.6-terra')
    expect(model.api).toBe('openai-responses')
    // Terra supports image input per OpenRouter snapshot — must NOT be text-only
    expect(model.input).toContain('image')
  })

  it('should resolve all gpt-5.6 variants as vision models', () => {
    for (const id of ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol']) {
      const model = resolvePiAIModel('codex-oauth', id, 'https://chatgpt.com/backend-api/codex')
      expect(model.input).toContain('image')
    }
  })

  it('should keep unknown codex-oauth model as text-only', () => {
    const model = resolvePiAIModel('codex-oauth', 'some-future-unknown-model', 'https://chatgpt.com/backend-api/codex')
    expect(model.input).toEqual(['text'])
    expect(model.input).not.toContain('image')
  })

  it('should resolve vision for custom provider model known to OpenRouter', () => {
    // Custom OpenAI-compatible endpoint serving a model that OpenRouter knows
    // supports image input.
    const model = resolvePiAIModel('custom', 'gpt-5.6-terra', 'https://my-proxy.example.com/v1')
    expect(model.input).toContain('image')
  })

  it('should keep custom provider model text-only when unknown to OpenRouter', () => {
    const model = resolvePiAIModel('custom', 'my-private-model-v1', 'https://my-proxy.example.com/v1')
    expect(model.input).toEqual(['text'])
  })

  it('should resolve vision for GLM-5.2 text-only model as text-only', () => {
    // GLM-5.2 is text-only per OpenRouter snapshot — must NOT declare image
    const model = resolvePiAIModel('glm-coding', 'glm-5.2', 'https://open.bigmodel.cn/api/coding/paas/v4/')
    expect(model.input).toEqual(['text'])
    expect(model.input).not.toContain('image')
  })

  // ── Reasoning capability gating (issue #88 Sourcery High finding) ────────
  // A blanket reasoning:true on the fallback made the send path forward
  // reasoning_effort to endpoints that reject it (400) once thinking became
  // default-ON for fresh installs. The fallback must gate reasoning on
  // capability evidence and default to FALSE for unknown model ids.

  it('should mark unknown custom-provider model as NOT reasoning-capable', () => {
    const model = resolvePiAIModel('custom', 'my-private-model-v1', 'https://my-proxy.example.com/v1')
    // Finding E guard: assert the FALLBACK path was actually taken — 'custom'
    // has no PROVIDER_MAP entry so tryGetNativeModel can't shadow this, but
    // the explicit api check keeps the assertion honest if providers change.
    expect(model.api).toBe('openai-completions')
    expect(model.reasoning).toBe(false)
  })

  it('should mark unknown dynamic-provider model as NOT reasoning-capable', () => {
    // llm-gateway user-added id absent from any capability source — the
    // conservative default must be false, never a blanket true.
    const model = resolvePiAIModel('llm-gateway', 'brand-new-unknown-id', 'https://gateway.example.com/v1')
    expect(model.api).toBe('cw-openai-fetch')
    expect(model.reasoning).toBe(false)
  })

  it('should keep reasoning:true for fallback models the static catalog declares reasoning', () => {
    // glm-5 declares ['code', 'reasoning'] in the static glm-coding catalog,
    // but has NO entry in pi-ai's native zai catalog (which only knows
    // glm-4.5-air, glm-4.7, glm-5-turbo, glm-5.1, glm-5v-turbo) — so this
    // resolves through createOpenAICompatibleFallback and actually exercises
    // resolveFallbackReasoning (asserting the fallback API first guards the
    // test against future catalog additions silently re-routing it).
    const model = resolvePiAIModel('glm-coding', 'glm-5', 'https://open.bigmodel.cn/api/coding/paas/v4/')
    expect(model.api).toBe('openai-completions')
    expect(model.reasoning).toBe(true)
  })

  it('should mark native-catalog reasoning models as reasoning-capable via the NATIVE path', () => {
    // glm-4.7 IS in pi-ai's native zai catalog with reasoning:true, while
    // the static app catalog also lists it with 'reasoning' — both sources
    // agree on the flag. Round-3 finding: a reasoning-only assertion is
    // vacuous, because if native lookup stopped recognizing the id the
    // fallback would read the same static catalog and report true anyway.
    // The nativeCatalogHits counter proves resolvePiAIModel answered through
    // tryGetNativeModel's pi-ai getModel() call, not the fallback.
    resetResolutionCounts()
    const model = resolvePiAIModel('glm-coding', 'glm-4.7', 'https://open.bigmodel.cn/api/coding/paas/v4/')
    expect(RESOLUTION_COUNTS.nativeCatalogHits).toBe(1)
    expect(RESOLUTION_COUNTS.fallbackContextLookups).toBe(0)
    expect(model.reasoning).toBe(true)
  })

  it('should keep fast-tier native-catalog models NOT reasoning-capable via the NATIVE path', () => {
    // glm-4.7 declares ['code', 'writing', 'fast'] — no reasoning tag — in
    // the static catalog. pi-ai's native zai catalog does NOT know the id,
    // so this resolves through the fallback and asserts its conservative
    // false; the native-path counterpart is the glm-4.7 test above.
    resetResolutionCounts()
    const model = resolvePiAIModel('glm-coding', 'glm-4.7-flash', 'https://open.bigmodel.cn/api/coding/paas/v4/')
    expect(RESOLUTION_COUNTS.nativeCatalogHits).toBe(0)
    expect(RESOLUTION_COUNTS.fallbackContextLookups).toBe(1)
    expect(model.api).toBe('openai-completions')
    expect(model.reasoning).toBe(false)
  })

  it('should keep reasoning disabled for fallback models the static catalog lists without reasoning', async () => {
    // deepseek-flash declares ['fast'] (no reasoning) in the static catalog.
    // deepseek has no PROVIDER_MAP entry, so this always takes the fallback
    // path — asserting the api first proves resolveFallbackReasoning ran.
    // Seed a CONFLICTING heuristic dynamic-cache entry (guessCapabilities
    // output with a 'reasoning' tag) for this exact id: a regression that
    // lets cache tags enable reasoning would flip this to true and fail.
    const { setCachedModels } = await import('@/agent/providers/model-store')
    setCachedModels('deepseek', {
      models: [
        {
          id: 'deepseek-flash',
          name: 'DeepSeek V4.1 Flash',
          capabilities: ['code', 'reasoning', 'fast'],
        },
      ],
      source: 'dynamic',
      fetchedAt: Date.now(),
    })
    try {
      const model = resolvePiAIModel('deepseek', 'deepseek-flash', 'https://api.deepseek.com/v1')
      expect(model.api).toBe('openai-completions')
      expect(model.reasoning).toBe(false)
    } finally {
      // Clear BOTH layers: setCachedModels seeds the module-level memory cache
      // as well as localStorage, and removeItem alone leaves the memory entry
      // reachable for findCachedModelInfo in later tests in this module.
      clearModelCache('deepseek')
      localStorage.removeItem('cw-models:deepseek')
      localStorage.removeItem('cw-models:deepseek:undefined')
    }
  })

  it('should not let heuristic gateway reasoning tags enable reasoning for unknown models', async () => {
    // Seed the REGISTRY the way llm-gateway really does: every fetched model
    // tagged ['code','writing','reasoning'] without real capability data.
    // Registering the provider is what makes the heuristic tag REACHABLE —
    // with an empty registry (as before) this assertion passed trivially even
    // if a regression consulted the registry, because there was nothing to
    // find. A heuristic tag must be treated as UNKNOWN regardless.
    const { registerDynamicProvider, unregisterDynamicProvider } = await import(
      '@/agent/providers/types'
    )
    registerDynamicProvider(
      'llm-gateway',
      { baseURL: 'https://gateway.example.com/v1', modelName: 'vendor-text-max-turbo', headers: {} },
      {
        category: 'custom',
        displayName: 'Nutstore AI',
        models: [
          {
            id: 'vendor-text-max-turbo',
            name: 'Vendor Text Max Turbo',
            capabilities: ['code', 'writing', 'reasoning'],
          },
        ],
      },
    )
    try {
      const model = resolvePiAIModel('llm-gateway', 'vendor-text-max-turbo', 'https://gateway.example.com/v1')
      expect(model.api).toBe('cw-openai-fetch')
      expect(model.reasoning).toBe(false)
    } finally {
      unregisterDynamicProvider('llm-gateway')
    }
  })

  it('should enable reasoning for extension-provided codex-oauth models absent from the static catalog', async () => {
    // Codex thinking is curated, not heuristic: registerCodexOAuthProvider
    // defaults extension catalog entries to ['code','reasoning']. A model id
    // the static PROVIDER_META.codex-oauth list doesn't know must still get
    // reasoning:true via the extension registry, or the send path silently
    // omits thinking params for it. The id below contains no reasoning-ish
    // keyword, so guessCapabilities-style heuristics would NOT produce it —
    // this only passes when the curated registry is consulted.
    const { registerDynamicProvider, unregisterDynamicProvider } = await import(
      '@/agent/providers/types'
    )
    registerDynamicProvider(
      'codex-oauth',
      { baseURL: 'https://chatgpt.com/backend-api/codex', modelName: 'vendor-pulse-9', headers: {} },
      {
        category: 'custom',
        displayName: 'Codex (Browser OAuth)',
        models: [
          { id: 'vendor-pulse-9', name: 'Vendor Pulse 9', capabilities: ['code', 'reasoning'] },
        ],
      },
    )
    try {
      // Round-3 finding: the fallback's reasoning answer is not
      // distinguishable from the curated registry's, so asserting only
      // reasoning:true passes even if the registry lookup is broken (the
      // fallback reports true unconditionally for anything it considers
      // evidence). The curatedRegistryReads counter is bumped exactly when
      // staticCatalogReasoning consults the codex-oauth registry entry —
      // zero reads means the answer came from somewhere else.
      resetResolutionCounts()
      const model = resolvePiAIModel('codex-oauth', 'vendor-pulse-9', 'https://chatgpt.com/backend-api/codex')
      expect(model.api).toBe('openai-responses')
      expect(RESOLUTION_COUNTS.curatedRegistryReads).toBe(1)
      expect(model.reasoning).toBe(true)
    } finally {
      unregisterDynamicProvider('codex-oauth')
    }
  })
})

describe('getOpenRouterInputModalities', () => {
  it('should return modalities for gpt-5.6-terra', () => {
    const mods = getOpenRouterInputModalities('gpt-5.6-terra')
    expect(mods).not.toBeNull()
    expect(mods).toContain('text')
    expect(mods).toContain('image')
  })

  it('should return null for unknown model', () => {
    expect(getOpenRouterInputModalities('totally-nonexistent-model-xyz')).toBeNull()
  })

  it('should match regardless of vendor prefix', () => {
    // Full id "openai/gpt-5.6-terra" and bare id "gpt-5.6-terra" both match
    expect(getOpenRouterInputModalities('openai/gpt-5.6-terra')).toContain('image')
    expect(getOpenRouterInputModalities('gpt-5.6-terra')).toContain('image')
  })
})
