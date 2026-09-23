import { getModel } from '@earendil-works/pi-ai'
import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai'
import type { LLMProviderType } from '@/agent/providers/types'
import { isChineseProviderType, isPotentiallyDynamicProviderType, getModelsForProvider } from '@/agent/providers/types'
import { getModelContextWindow } from '@/agent/providers/model-store'
import { getOpenRouterInputModalities } from '@/agent/providers/openrouter-pricing'
import { CW_OPENAI_FETCH_API } from './pi-ai-custom-openai-fetch'
import { normalizeBaseUrl } from './pi-ai-url-utils'

// Output ceiling for OpenAI-compatible fallback models (deepseek, minimax,
// custom providers, …) whose real limit is unknown to the pi-ai catalog.
// This is the total budget shared by reasoning/thinking tokens AND visible
// output. 8192 was far too small for agentic loops: with thinking enabled,
// pi-ai's adjustMaxTokensForThinking() carves a thinking budget out of this
// cap and reserves only 1024 tokens for the actual reply, silently truncating
// long drafts mid-tool-call-planning (e.g. drafting a full article inside the
// thinking block). 64K is safely below the output ceilings of modern fallback
// models (DeepSeek V4 allows up to 384K) while large enough that truncation
// from this constant should no longer be the binding constraint.
const DEFAULT_MAX_TOKENS = 65536

const PROVIDER_MAP: Partial<Record<LLMProviderType, KnownProvider>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  groq: 'groq',
  mistral: 'mistral',
  kimi: 'kimi-coding',
  glm: 'zai',
  'glm-coding': 'zai',
}

const MODEL_ALIASES: Partial<Record<LLMProviderType, Record<string, string>>> = {
  google: {
    'gemini-2.0-pro': 'gemini-2.0-flash',
  },
  minimax: {
    'abab6.5s-chat': 'MiniMax-M2.7',
    'MiniMax-M2': 'MiniMax-M2.7',
    'MiniMax-M2.1': 'MiniMax-M2.7',
    'MiniMax-M2.5': 'MiniMax-M2.7',
    'MiniMax-M2.5-highspeed': 'MiniMax-M2.7-highspeed',
  },
  'minimax-cn': {
    'abab6.5s-chat': 'MiniMax-M2.7',
    'MiniMax-M2': 'MiniMax-M2.7',
    'MiniMax-M2.1': 'MiniMax-M2.7',
    'MiniMax-M2.5': 'MiniMax-M2.7',
    'MiniMax-M2.5-highspeed': 'MiniMax-M2.7-highspeed',
  },
  kimi: {
    'moonshot-v1-8k': 'k2p5',
  },
  glm: {
    'glm-4-flash': 'glm-4.7-flash',
    'glm-4': 'glm-4.7',
    'glm-4-long': 'glm-4.7',
  },
  'glm-coding': {
    'glm-4-flash': 'glm-4.7-flash',
  },
}

function tryGetNativeModel(
  providerType: LLMProviderType,
  modelName: string,
  baseUrl: string
): Model<Api> | null {
  const provider = PROVIDER_MAP[providerType]
  if (!provider) return null

  const alias = MODEL_ALIASES[providerType]?.[modelName]
  const candidates = alias && alias !== modelName ? [modelName, alias] : [modelName]

  for (const candidate of candidates) {
    try {
      const model = getModel(provider, candidate as never) as Model<Api>
      if (!model) continue
      if (baseUrl) {
        return { ...model, baseUrl: normalizeBaseUrl(baseUrl) }
      }
      return model
    } catch {
      // try next candidate
    }
  }

  return null
}

function lookupContextWindow(providerType: LLMProviderType, modelName: string): number {
  return getModelContextWindow(providerType, modelName)
}

/**
 * Resolve a model's input modalities (e.g. ['text', 'image']) from the
 * OpenRouter snapshot. Returns ['text'] as the conservative fallback when
 * the model is unknown or has no modality info — sending image_url to a model
 * that doesn't support it causes the entire API request to fail.
 */
function resolveInputModalities(modelName: string, providerType?: LLMProviderType): Array<'text' | 'image'> {
  const modalities = getOpenRouterInputModalities(modelName)
  if (modalities && modalities.includes('image')) {
    return ['text', 'image']
  }
  // Fallback for models missing from the OpenRouter snapshot (newly released
  // models, e.g. gpt-6-sol/gpt-6-luna): consult the dynamic provider registry's
  // declared capabilities (codex-oauth models carry 'vision' from the
  // extension response).
  if (providerType) {
    try {
      // Static import is safe: types.ts does not import this module.
      const found = getModelsForProvider(providerType).find((m) => m.id === modelName)
      if (found?.capabilities?.includes('vision')) return ['text', 'image']
    } catch { /* registry unavailable — keep conservative default */ }
  }
  return ['text']
}

/**
 * Check whether a model accepts image input, as determined by the OpenRouter
 * snapshot.  Use this from UI contexts (model pickers, capability badges) that
 * need to render vision-capability indicators without constructing a full
 * `Model<Api>` — those callers usually don't have a `baseUrl` / `apiMode` in
 * hand, and `resolvePiAIModel`'s 3rd arg is required.
 *
 * Pass `providerType` when available: for models missing from the OpenRouter
 * snapshot (newly released, e.g. gpt-6-sol/luna), the dynamic provider
 * registry's declared capabilities are consulted as a fallback. Runtime
 * call sites (attach-image gating, OCR skip, page_screenshot registration)
 * MUST pass it — otherwise the UI badge and the actual send path disagree.
 */
export function supportsImageInput(modelName: string, providerType?: LLMProviderType): boolean {
  return resolveInputModalities(modelName, providerType).includes('image')
}
function createOpenAICompatibleFallback(
  providerType: LLMProviderType,
  modelName: string,
  baseUrl: string,
  apiMode?: 'chat-completions' | 'responses'
): Model<Api> {
  // Codex OAuth: use openai-responses handler with bridge fetch interception
  if (providerType === 'codex-oauth') {
    const contextWindow = lookupContextWindow(providerType, modelName)
    return {
      id: modelName,
      name: modelName,
      api: 'openai-responses', // Use official handler — fetch is intercepted by streamFn
      provider: providerType,
      baseUrl: normalizeBaseUrl(baseUrl),
      reasoning: true,
      input: resolveInputModalities(modelName, providerType),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: DEFAULT_MAX_TOKENS,
    }
  }

  // Dynamically-registered providers (llm-gateway, custom-*, and any future
  // async-registered provider id) must ALL use the CW_OPENAI_FETCH_API handler
  // regardless of registration state. Their upstream endpoints include
  // OpenAI-compatible providers that reject role:"developer" with 400 ("is not
  // one of ['system', 'assistant', 'user', 'tool', 'function']").
  //
  // isPotentiallyDynamicProviderType (NOT isCustomProviderType) is the correct
  // predicate here: custom-* providers are restored asynchronously from
  // persisted settings, and llm-gateway registers in AppBootstrap. During that
  // bootstrap window isCustomProviderType returns false, which used to fall
  // through to pi-ai's openai-completions handler, whose detectCompat()
  // defaults unknown URLs to supportsDeveloperRole:true — emitting a
  // developer-role system prompt that such endpoints reject. Routing these
  // providers through CW_OPENAI_FETCH_API guarantees system role on every
  // request (the custom handler never emits "developer").
  //
  // Literal 'llm-gateway' in the predicate (instead of importing
  // LLM_GATEWAY_PROVIDER_TYPE) keeps this module free of the gateway
  // provider's i18n/store import chain (same practice as
  // pi-ai-custom-openai-fetch.ts).
  const usesCwOpenAIFetch =
    providerType === 'minimax' ||
    providerType === 'minimax-cn' ||
    isPotentiallyDynamicProviderType(providerType)
  const fallbackApi: Api = usesCwOpenAIFetch
    ? (apiMode === 'responses' ? 'openai-responses' : CW_OPENAI_FETCH_API)
    : 'openai-completions'
  const contextWindow = lookupContextWindow(providerType, modelName)

  // Zhipu bigmodel.cn (GLM Coding Plan & standard API) rejects role:"developer"
  // with error 1214 (invalid role) — it only accepts system/user/assistant/tool.
  // pi-ai's detectCompat() only recognizes api.z.ai as "non-standard" and would
  // emit developer-role system prompts for models missing from its native zai
  // catalog (e.g. glm-5.2, glm-5.3-flash resolved via this fallback path).
  //
  // Same belt-and-braces for every provider whose upstream may reject
  // role:"developer" with 400:
  //
  // 1. Chinese-classified providers (qwen, volcengine-coding, and every other
  //    category:'chinese' entry): they are OpenAI-compatible EXCEPT for the
  //    developer role. qwen and volcengine-coding always resolve through this
  //    fallback (no PROVIDER_MAP entry), and pi-ai's detectCompat() does not
  //    recognize dashscope.aliyuncs.com or ark.volces.com as non-standard —
  //    so reasoning models would get developer-role system prompts they
  //    reject. deepseek/kimi are also covered here (harmless double-cover:
  //    pi-ai already detects them, but the explicit flag wins either way).
  // 2. Dynamically-registered providers (llm-gateway + custom-*): same
  //    reasoning as 1 — their upstream backends include direct vendor APIs.
  //
  // The compat flag does not affect CW_OPENAI_FETCH_API (which always emits
  // system), but keeps the model object safe when routed through pi-ai's
  // built-in openai-completions handler (getCompat respects the explicit
  // compat over URL auto-detection).
  const isBigmodel = /bigmodel\.cn/i.test(baseUrl)
  const noDeveloperRole =
    isBigmodel ||
    isChineseProviderType(providerType) ||
    isPotentiallyDynamicProviderType(providerType)

  return {
    id: modelName,
    name: modelName,
    api: fallbackApi,
    provider: providerType,
    baseUrl: normalizeBaseUrl(baseUrl),
    reasoning: true,
    // Resolve vision capability from the OpenRouter snapshot. If the model is
    // known to support image input (per authoritative metadata), declare it;
    // otherwise fall back to text-only. Sending image_url to a model that
    // doesn't support it causes the entire API request to fail, so the
    // conservative default (['text']) is used when the model is unknown.
    input: resolveInputModalities(modelName),
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow,
    maxTokens: DEFAULT_MAX_TOKENS,
    ...(noDeveloperRole ? { compat: { supportsDeveloperRole: false } } : {}),
  }
}

export function resolvePiAIModel(
  providerType: LLMProviderType,
  modelName: string,
  baseUrl: string,
  apiMode?: 'chat-completions' | 'responses'
): Model<Api> {
  const native = tryGetNativeModel(providerType, modelName, baseUrl)
  if (native) return native
  const resolvedModelName = MODEL_ALIASES[providerType]?.[modelName] || modelName
  return createOpenAICompatibleFallback(providerType, resolvedModelName, baseUrl, apiMode)
}

/**
 * Resolve the effective output token cap for a model without constructing a
 * full Model object. Mirrors resolvePiAIModel: native pi-ai catalog models use
 * their catalog maxTokens, everything else gets DEFAULT_MAX_TOKENS.
 *
 * Used by the settings UI to display the (read-only) output cap — the value is
 * determined by the model, not user-configurable.
 */
export function resolveModelOutputCap(
  providerType: LLMProviderType,
  modelName: string
): number {
  const provider = PROVIDER_MAP[providerType]
  if (!provider) return DEFAULT_MAX_TOKENS

  const alias = MODEL_ALIASES[providerType]?.[modelName]
  const candidates = alias && alias !== modelName ? [modelName, alias] : [modelName]
  for (const candidate of candidates) {
    try {
      const model = getModel(provider, candidate as never) as Model<Api>
      if (model?.maxTokens) return model.maxTokens
    } catch {
      // try next candidate
    }
  }
  return DEFAULT_MAX_TOKENS
}
