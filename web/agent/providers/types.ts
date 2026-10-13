/**
 * Multi-LLM Provider Configuration
 * Supports: Chinese providers (GLM, Kimi, MiniMax, Qwen)
 *           International providers (OpenAI, Anthropic, Google, Groq, Mistral)
 *           Custom OpenAI-compatible endpoints
 */

export interface LLMProviderConfig {
  apiKey: string
  baseURL: string
  modelName: string
  headers?: Record<string, string>
  /** API mode for custom providers: 'chat-completions' or 'responses' */
  apiMode?: 'chat-completions' | 'responses'
}

/** Provider category for grouping in UI */
export type ProviderCategory = 'international' | 'chinese' | 'custom'

/** Model capability tags */
export type ModelCapability = 'code' | 'writing' | 'reasoning' | 'vision' | 'fast' | 'long-context'

/** Model metadata for UI display */
export interface ModelInfo {
  id: string
  name: string
  capabilities: ModelCapability[]
  /** Context window in tokens; absent when unknown (resolved at runtime via OpenRouter data). */
  contextWindow?: number
  description?: string
  /**
   * Input modalities reported by the provider's /models endpoint
   * (e.g. DeepSeek returns `input_modalities: ["text", "image"]`).
   * Present only when the API publishes it; drives vision-capability
   * resolution with higher fidelity than the `capabilities` keyword list.
   */
  inputModalities?: string[]
  /**
   * True when `name`/`contextWindow`/`inputModalities` came directly from
   * the provider API rather than local heuristics. Used to prefer API
   * metadata over static-table guesses when merging.
   */
  metadataFromApi?: boolean
  /**
   * Per-token USD pricing as strings, sourced from the provider's
   * `/models` endpoint (e.g. OpenRouter). Multiply by 1e6 to get
   * USD per 1M tokens. Fields are absent when the provider doesn't
   * publish them (OpenAI, Anthropic, etc.).
   */
  pricing?: {
    prompt?: string
    completion?: string
    request?: string
    image?: string
    /** Cache read; per-token USD */
    input_cache_read?: string
    /** Cache write (e.g. Anthropic ephemeral); per-token USD */
    input_cache_write?: string
  }
}

/** Provider metadata for UI display */
export interface ProviderMeta {
  category: ProviderCategory
  displayName: string
  icon?: string
  website?: string
  models: ModelInfo[]
}

/** Built-in provider types */
export type BuiltinLLMProviderType =
  // International
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'groq'
  | 'mistral'
  | 'openrouter'
  // Chinese
  | 'deepseek'
  | 'glm'
  | 'glm-coding'
  | 'kimi'
  | 'minimax'
  | 'minimax-cn'
  | 'qwen'
  | 'volcengine-coding'

/** Provider type: built-in or dynamically registered custom provider (e.g. "custom-abc123") */
export type LLMProviderType = BuiltinLLMProviderType | string

export const LLM_PROVIDER_CONFIGS: Record<LLMProviderType, Omit<LLMProviderConfig, 'apiKey'>> = {
  // International providers
  openai: {
    baseURL: 'https://api.openai.com/v1',
    modelName: 'gpt-4o',
    headers: {},
  },
  anthropic: {
    baseURL: 'https://api.anthropic.com/v1',
    modelName: 'claude-sonnet-4-20250514',
    headers: {},
  },
  google: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    modelName: 'gemini-2.0-pro',
    headers: {},
  },
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    modelName: 'llama-3.3-70b-versatile',
    headers: {},
  },
  mistral: {
    baseURL: 'https://api.mistral.ai/v1',
    modelName: 'mistral-large-latest',
    headers: {},
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    modelName: '',
    headers: {},
  },
  // Chinese providers
  deepseek: {
    baseURL: 'https://api.deepseek.com',
    modelName: 'deepseek-v4-pro',
    headers: {},
  },
  glm: {
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
    modelName: 'glm-5.1',
    headers: {},
  },
  'glm-coding': {
    baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4/',
    modelName: 'glm-5.1',
    headers: {},
  },
  kimi: {
    baseURL: 'https://api.moonshot.cn/v1',
    modelName: 'moonshot-v1-8k',
    headers: {},
  },
  minimax: {
    baseURL: 'https://api.minimax.io/v1',
    modelName: 'MiniMax-M2.7',
    headers: {},
  },
  'minimax-cn': {
    baseURL: 'https://api.minimaxi.com/v1',
    modelName: 'MiniMax-M2.7',
    headers: {},
  },
  qwen: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelName: 'qwen-turbo',
    headers: {},
  },
  'volcengine-coding': {
    baseURL: 'https://ark.cn-beijing.volces.com/api/coding',
    modelName: '',
    headers: {},
  },
}

// ── Dynamic Custom Provider Registry ──
// Custom providers are registered at runtime; each has its own providerType (e.g. "custom-abc123").

const DYNAMIC_PROVIDER_CONFIGS = new Map<string, Omit<LLMProviderConfig, 'apiKey'>>()
const DYNAMIC_PROVIDER_METAS = new Map<string, ProviderMeta>()

/** Register (or update) a custom provider */
export function registerDynamicProvider(
  id: string,
  config: Omit<LLMProviderConfig, 'apiKey'>,
  meta: ProviderMeta,
) {
  DYNAMIC_PROVIDER_CONFIGS.set(id, config)
  DYNAMIC_PROVIDER_METAS.set(id, meta)
}

/** Remove a custom provider */
export function unregisterDynamicProvider(id: string) {
  DYNAMIC_PROVIDER_CONFIGS.delete(id)
  DYNAMIC_PROVIDER_METAS.delete(id)
}

/** Check if a providerType is a dynamically registered custom provider */
export function isCustomProviderType(type: string): boolean {
  return DYNAMIC_PROVIDER_CONFIGS.has(type)
}

/** Get all dynamic provider IDs */
export function getDynamicProviderIds(): string[] {
  return Array.from(DYNAMIC_PROVIDER_CONFIGS.keys())
}

/** Get config for any provider (built-in or dynamic) */
export function getProviderConfig(type: LLMProviderType): Omit<LLMProviderConfig, 'apiKey'> | null {
  if (DYNAMIC_PROVIDER_CONFIGS.has(type)) return DYNAMIC_PROVIDER_CONFIGS.get(type)!
  return (LLM_PROVIDER_CONFIGS as Record<string, Omit<LLMProviderConfig, 'apiKey'>>)[type] ?? null
}

/**
 * Provider types that are registered asynchronously after app startup.
 * `checkHasApiKey()` defers its conclusion when the user's `providerType`
 * is one of these but the registry doesn't yet have a config — otherwise
 * we'd prematurely report "no API key" while a registration is in flight
 * (e.g. codex-oauth waiting for extension auth, llm-gateway registering
 * in App.tsx, custom-* waiting for restore).
 *
 * NOTE: Keep this in sync with the dynamic registration paths. If you add
 * a new async-registered provider, add it here too.
 */
const POTENTIALLY_DYNAMIC_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'codex-oauth',
  'llm-gateway',
])

const POTENTIALLY_DYNAMIC_PROVIDER_PREFIXES: readonly string[] = ['custom-']

/** True if the given providerType might register itself asynchronously. */
export function isPotentiallyDynamicProviderType(type: string): boolean {
  if (!type) return false
  if (POTENTIALLY_DYNAMIC_PROVIDER_IDS.has(type)) return true
  return POTENTIALLY_DYNAMIC_PROVIDER_PREFIXES.some((p) => type.startsWith(p))
}

/** Get meta for any provider (built-in or dynamic) */
export function getProviderMeta(type: LLMProviderType): ProviderMeta | null {
  if (DYNAMIC_PROVIDER_METAS.has(type)) return DYNAMIC_PROVIDER_METAS.get(type)!
  return (PROVIDER_META as Record<string, ProviderMeta>)[type] ?? null
}

/**
 * True for built-in providers classified as Chinese (deepseek, glm,
 * glm-coding, kimi, minimax-cn, qwen, volcengine-coding). Their
 * OpenAI-compatible endpoints reject role:"developer" with 400 even though
 * they are otherwise OpenAI-compatible — callers must never emit developer
 * role for them (see pi-ai-model-resolver's compat.supportsDeveloperRole).
 */
export function isChineseProviderType(type: string): boolean {
  return getProviderMeta(type)?.category === 'chinese'
}

/** Provider metadata registry for UI display and grouping */
export const PROVIDER_META: Record<LLMProviderType, ProviderMeta> = {
  openai: {
    category: 'international',
    displayName: 'OpenAI',
    website: 'https://platform.openai.com',
    models: [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        capabilities: ['code', 'writing', 'reasoning', 'vision'],
      },
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        capabilities: ['code', 'writing', 'fast'],
      },
      {
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        capabilities: ['code', 'writing', 'reasoning', 'vision'],
      },
      { id: 'o1', name: 'o1', capabilities: ['reasoning', 'code'] },
      {
        id: 'o1-mini',
        name: 'o1-mini',
        capabilities: ['reasoning', 'code', 'fast'],
      },
    ],
  },
  anthropic: {
    category: 'international',
    displayName: 'Anthropic',
    website: 'https://console.anthropic.com',
    models: [
      {
        id: 'claude-sonnet-4-20250514',
        name: 'Claude Sonnet 4',
        capabilities: ['code', 'writing', 'reasoning'],
      },
      {
        id: 'claude-3-5-sonnet-20241022',
        name: 'Claude 3.5 Sonnet',
        capabilities: ['code', 'writing', 'reasoning'],
      },
      {
        id: 'claude-3-5-haiku-20241022',
        name: 'Claude 3.5 Haiku',
        capabilities: ['code', 'fast'],
      },
      {
        id: 'claude-3-opus-20240229',
        name: 'Claude 3 Opus',
        capabilities: ['writing', 'reasoning', 'long-context'],
      },
    ],
  },
  google: {
    category: 'international',
    displayName: 'Google',
    website: 'https://aistudio.google.com',
    models: [
      {
        id: 'gemini-2.0-pro',
        name: 'Gemini 2.0 Pro',
        capabilities: ['code', 'writing', 'reasoning', 'vision'],
      },
      {
        id: 'gemini-2.0-flash',
        name: 'Gemini 2.0 Flash',
        capabilities: ['code', 'writing', 'fast', 'vision'],
      },
      {
        id: 'gemini-1.5-pro',
        name: 'Gemini 1.5 Pro',
        capabilities: ['code', 'writing', 'long-context', 'vision'],
      },
    ],
  },
  groq: {
    category: 'international',
    displayName: 'Groq',
    website: 'https://console.groq.com',
    models: [
      {
        id: 'llama-3.3-70b-versatile',
        name: 'Llama 3.3 70B',
        capabilities: ['code', 'writing', 'fast'],
      },
      {
        id: 'mixtral-8x7b-32768',
        name: 'Mixtral 8x7B',
        capabilities: ['code', 'fast'],
      },
    ],
  },
  mistral: {
    category: 'international',
    displayName: 'Mistral',
    website: 'https://console.mistral.ai',
    models: [
      {
        id: 'mistral-large-latest',
        name: 'Mistral Large',
        capabilities: ['code', 'writing', 'reasoning'],
      },
      {
        id: 'mistral-medium-latest',
        name: 'Mistral Medium',
        capabilities: ['code', 'writing'],
      },
      {
        id: 'codestral-latest',
        name: 'Codestral',
        capabilities: ['code', 'fast'],
      },
    ],
  },
  openrouter: {
    category: 'international',
    displayName: 'OpenRouter',
    website: 'https://openrouter.ai',
    models: [],
  },
  deepseek: {
    category: 'chinese',
    displayName: 'DeepSeek',
    website: 'https://platform.deepseek.com',
    models: [
      // Minimal fallback skeleton only — authoritative metadata (names,
      // context windows, vision) comes from the live /models endpoint.
      {
        id: 'deepseek-flash',
        name: 'DeepSeek V4.1 Flash',
        capabilities: ['fast'],
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        capabilities: ['code', 'writing', 'reasoning'],
      },
    ],
  },
  glm: {
    category: 'chinese',
    displayName: '智谱 GLM',
    website: 'https://open.bigmodel.cn',
    models: [
      {
        id: 'glm-5.1',
        name: 'GLM-5.1',
        capabilities: ['code', 'writing', 'reasoning'],
      },
      {
        id: 'glm-5',
        name: 'GLM-5',
        capabilities: ['code', 'writing', 'reasoning'],
      },
      {
        id: 'glm-4.7',
        name: 'GLM-4.7',
        capabilities: ['code', 'writing', 'reasoning', 'vision'],
      },
      {
        id: 'glm-4.7-flash',
        name: 'GLM-4.7 Flash',
        capabilities: ['code', 'writing', 'fast'],
      },
    ],
  },
  'glm-coding': {
    category: 'chinese',
    displayName: '智谱 GLM (Coding)',
    website: 'https://open.bigmodel.cn',
    models: [
      {
        id: 'glm-5.1',
        name: 'GLM-5.1 (Code)',
        capabilities: ['code', 'reasoning'],
      },
      {
        id: 'glm-5',
        name: 'GLM-5 (Code)',
        capabilities: ['code', 'reasoning'],
      },
      {
        id: 'glm-4.7',
        name: 'GLM-4.7 (Code)',
        capabilities: ['code', 'reasoning'],
      },
      {
        id: 'glm-4.7-flash',
        name: 'GLM-4.7 Flash (Code)',
        capabilities: ['code', 'fast'],
      },
    ],
  },
  kimi: {
    category: 'chinese',
    displayName: 'Kimi (Moonshot)',
    website: 'https://platform.moonshot.cn',
    models: [
      {
        id: 'moonshot-v1-8k',
        name: 'Moonshot v1 8K',
        capabilities: ['writing', 'fast'],
      },
      {
        id: 'moonshot-v1-32k',
        name: 'Moonshot v1 32K',
        capabilities: ['writing', 'long-context'],
      },
      {
        id: 'moonshot-v1-128k',
        name: 'Moonshot v1 128K',
        capabilities: ['writing', 'long-context'],
      },
    ],
  },
  minimax: {
    category: 'international',
    displayName: 'MiniMax',
    website: 'https://www.minimax.io',
    models: [
      {
        id: 'MiniMax-M2.7',
        name: 'MiniMax M2.7',
        capabilities: ['code', 'reasoning'],
      },
      {
        id: 'MiniMax-M2.7-highspeed',
        name: 'MiniMax M2.7 Highspeed',
        capabilities: ['code', 'fast'],
      },
    ],
  },
  'minimax-cn': {
    category: 'chinese',
    displayName: 'MiniMax',
    website: 'https://www.minimaxi.com',
    models: [
      {
        id: 'MiniMax-M2.7',
        name: 'MiniMax M2.7',
        capabilities: ['code', 'reasoning'],
      },
      {
        id: 'MiniMax-M2.7-highspeed',
        name: 'MiniMax M2.7 Highspeed',
        capabilities: ['code', 'fast'],
      },
    ],
  },
  qwen: {
    category: 'chinese',
    displayName: '通义千问 (Qwen)',
    website: 'https://dashscope.console.aliyun.com',
    models: [
      {
        id: 'qwen-turbo',
        name: 'Qwen Turbo',
        capabilities: ['code', 'writing', 'fast'],
      },
      {
        id: 'qwen-plus',
        name: 'Qwen Plus',
        capabilities: ['code', 'writing', 'reasoning'],
      },
      {
        id: 'qwen-max',
        name: 'Qwen Max',
        capabilities: ['code', 'writing', 'reasoning', 'long-context'],
      },
      {
        id: 'qwen-long',
        name: 'Qwen Long',
        capabilities: ['writing', 'long-context'],
      },
    ],
  },
  'volcengine-coding': {
    category: 'chinese',
    displayName: '火山方舟 Coding',
    website: 'https://console.volcengine.com/ark',
    models: [],
  },
}

/** Get providers grouped by category */
export function getProvidersByCategory(): Record<
  ProviderCategory,
  { type: LLMProviderType; meta: ProviderMeta }[]
> {
  const grouped: Record<ProviderCategory, { type: LLMProviderType; meta: ProviderMeta }[]> = {
    international: [],
    chinese: [],
    custom: [],
  }
  for (const [type, meta] of Object.entries(PROVIDER_META)) {
    grouped[meta.category].push({ type: type as LLMProviderType, meta })
  }
  // Add dynamic custom providers
  for (const [id, meta] of DYNAMIC_PROVIDER_METAS.entries()) {
    grouped.custom.push({ type: id, meta })
  }
  return grouped
}

/** Get static model list for a provider (from PROVIDER_META or dynamic registry) */
export function getModelsForProvider(providerType: LLMProviderType): ModelInfo[] {
  if (DYNAMIC_PROVIDER_METAS.has(providerType)) {
    return DYNAMIC_PROVIDER_METAS.get(providerType)!.models
  }
  return (PROVIDER_META as Record<string, ProviderMeta>)[providerType]?.models ?? []
}

export interface ProviderOptions {
  providerType: LLMProviderType
  apiKey: string
  modelName?: string
  baseURL?: string
}
