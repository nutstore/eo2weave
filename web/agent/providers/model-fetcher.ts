/**
 * Dynamic Model Fetcher
 *
 * Fetches available models from provider APIs (OpenAI-compatible /v1/models endpoint).
 * Falls back to static PROVIDER_META models if the API call fails.
 *
 * Supported providers:
 * - OpenAI-compatible: OpenAI, Groq, Mistral, GLM, Kimi, MiniMax, Qwen, Custom
 * - Google Gemini: uses /v1beta/models endpoint with API key auth
 * - Anthropic: no list models API → always falls back to static list
 */

import type { LLMProviderType, ModelInfo, ModelCapability } from './types'
import { LLM_PROVIDER_CONFIGS, PROVIDER_META, getModelsForProvider, isCustomProviderType } from './types'
import { getOpenRouterContextWindow } from './openrouter-pricing'
import { assertHeaderAscii } from '../llm/http-headers'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FetchModelsResult {
  models: ModelInfo[]
  source: 'dynamic' | 'static'
  fetchedAt: number
  error?: string
}

// ─── Provider-specific fetch strategies ──────────────────────────────────────

/**
 * Providers that support OpenAI-compatible GET /v1/models
 */
const OPENAI_COMPATIBLE_PROVIDERS: LLMProviderType[] = [
  'openai',
  'groq',
  'mistral',
  'openrouter',
  'glm',
  'glm-coding',
  'kimi',
  'minimax',
  'minimax-cn',
  'qwen',
  'deepseek',
  'custom',
]

/**
 * Anthropic has no list models API
 */
const STATIC_ONLY_PROVIDERS: LLMProviderType[] = ['anthropic']
const CODEX_OAUTH_PROVIDER = 'codex-oauth'

/**
 * Check if a provider supports dynamic model fetching
 */
export function canFetchModels(providerType: LLMProviderType): boolean {
  return providerType !== CODEX_OAUTH_PROVIDER && !STATIC_ONLY_PROVIDERS.includes(providerType)
}

// ─── Fetch implementations ──────────────────────────────────────────────────

/**
 * Fetch models from OpenAI-compatible /v1/models endpoint.
 *
 * `apiKey` is optional: local OpenAI-compatible runtimes (Ollama, LM Studio,
 * llama.cpp server) don't require authentication, so we send a keyless GET.
 */
async function fetchOpenAICompatibleModels(
  baseUrl: string,
  apiKey?: string
): Promise<ModelInfo[]> {
  const url = `${baseUrl}/models`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  assertHeaderAscii(headers, 'model list request headers')

  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(10000), // 10s timeout
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const data = await response.json()

  // OpenAI format: { data: [{ id: "model-name", ... }, ...] }
  // OpenRouter extends with top_provider.context_length (actual usable context)
  // and per-model pricing.prompt / pricing.completion / pricing.input_cache_read
  const rawModels: Array<{
    id: string
    owned_by?: string
    created?: number
    // OpenAI-legacy / OpenRouter: snake_case context fields
    context_length?: number
    top_provider?: { context_length?: number }
    // DeepSeek (2026+): rich metadata format
    name?: string
    context_window?: number
    input_modalities?: string[]
    output_modalities?: string[]
    pricing?: {
      prompt?: string
      completion?: string
      request?: string
      image?: string
      input_cache_read?: string
      input_cache_write?: string
    }
  }> = data.data || data

  if (!Array.isArray(rawModels)) {
    throw new Error('Unexpected response format: expected array of models')
  }

  return rawModels
    .filter((m) => m.id && typeof m.id === 'string')
    .map((m) => {
      // Context window resolution (first non-null wins):
      // 1. DeepSeek-style `context_window`
      // 2. OpenRouter's `top_provider.context_length` (actual usable context,
      //    may be smaller than the model's theoretical limit)
      // 3. OpenAI-legacy `context_length`
      const effectiveContext = m.context_window ?? m.top_provider?.context_length ?? m.context_length
      const hasApiMetadata = Boolean(
        m.context_window != null || m.input_modalities || m.name
      )
      return parseModelInfo(m.id, effectiveContext, m.pricing, {
        apiName: m.name,
        apiInputModalities: m.input_modalities,
        metadataFromApi: hasApiMetadata,
      })
    })
    .sort((a, b) => {
      // Sort: put more capable/recent models first
      const aScore = getModelSortScore(a.id)
      const bScore = getModelSortScore(b.id)
      return bScore - aScore || a.id.localeCompare(b.id)
    })
}

/**
 * Fetch models from Google Gemini API
 */
async function fetchGoogleModels(apiKey: string): Promise<ModelInfo[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`

  const response = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(10000),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const data = await response.json()

  // Google format: { models: [{ name: "models/gemini-pro", displayName: "...", ... }] }
  const rawModels: Array<{
    name: string
    displayName?: string
    supportedGenerationMethods?: string[]
  }> = data.models || []

  return rawModels
    .filter((m) => {
      // Only include models that support generateContent (chat completion)
      const methods = m.supportedGenerationMethods || []
      return methods.includes('generateContent') && m.name
    })
    .map((m) => {
      // Google model names are like "models/gemini-2.0-flash" → extract the id
      const id = m.name.replace(/^models\//, '')
      return {
        id,
        name: m.displayName || id,
        capabilities: guessCapabilities(id),
        contextWindow: guessContextWindow(id),
      }
    })
    .sort((a, b) => getModelSortScore(b.id) - getModelSortScore(a.id))
}

// ─── Main fetch function ────────────────────────────────────────────────────

/**
 * Fetch available models for a given provider.
 *
 * @returns FetchModelsResult with models and metadata about the source
 */
export async function fetchModelsForProvider(
  providerType: LLMProviderType,
  options?: { apiKey?: string; baseUrl?: string }
): Promise<FetchModelsResult> {
  const now = Date.now()

  // The ChatGPT Codex backend exposes response generation only, not an
  // OpenAI-compatible /models endpoint. Its model list comes from the extension.
  if (providerType === CODEX_OAUTH_PROVIDER) {
    return {
      models: getModelsForProvider(providerType),
      source: 'static',
      fetchedAt: now,
    }
  }

  const isCustom = isCustomProviderType(providerType)
  const staticModels = isCustom ? [] : (PROVIDER_META[providerType]?.models ?? [])

  // Static-only providers always return static list
  if (!isCustom && STATIC_ONLY_PROVIDERS.includes(providerType)) {
    return {
      models: staticModels,
      source: 'static',
      fetchedAt: now,
    }
  }

  const apiKey = options?.apiKey
  const baseUrl =
    options?.baseUrl || LLM_PROVIDER_CONFIGS[providerType]?.baseURL || ''

  // Custom providers may run keyless (e.g. Ollama at localhost:11434/v1),
  // so a missing key is not an immediate error for them — only built-in
  // OpenAI-compatible providers fall back to the static list without a key.
  if (!apiKey && !isCustom) {
    return {
      models: staticModels,
      source: 'static',
      fetchedAt: now,
      error: 'No API key provided',
    }
  }

  try {
    let models: ModelInfo[]

    if (providerType === 'google') {
      // Google is not custom → the !apiKey early-return above guarantees a key here.
      models = await fetchGoogleModels(apiKey || '')
    } else if (isCustom || OPENAI_COMPATIBLE_PROVIDERS.includes(providerType)) {
      models = await fetchOpenAICompatibleModels(baseUrl, apiKey || undefined)
    } else {
      // Unknown provider → static fallback
      return {
        models: staticModels,
        source: 'static',
        fetchedAt: now,
      }
    }

    // If API returned empty, fall back to static
    if (models.length === 0) {
      return {
        models: staticModels,
        source: 'static',
        fetchedAt: now,
        error: 'API returned empty model list',
      }
    }

    return {
      models,
      source: 'dynamic',
      fetchedAt: now,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[model-fetcher] Failed to fetch models for ${providerType}:`, message)

    return {
      models: staticModels,
      source: 'static',
      fetchedAt: now,
      error: message,
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a raw model ID string into a ModelInfo object.
 *
 * Metadata resolution order (API-provided values win over local guesses):
 * - Display name: API `name` field → formatModelName(id)
 * - Context window: API `context_window`/`context_length` → guessContextWindow(id)
 * - Capabilities: API `input_modalities` (image → vision) merged with
 *   guessCapabilities(id) keyword heuristics
 */
function parseModelInfo(
  modelId: string,
  apiContextLength?: number,
  pricing?: ModelInfo['pricing'],
  apiMeta?: {
    apiName?: string
    apiInputModalities?: string[]
    metadataFromApi?: boolean
  }
): ModelInfo {
  const info: ModelInfo = {
    id: modelId,
    name: apiMeta?.apiName || formatModelName(modelId),
    capabilities: guessCapabilities(modelId),
    contextWindow: apiContextLength ?? guessContextWindow(modelId),
  }
  if (apiMeta?.apiInputModalities?.length) {
    info.inputModalities = apiMeta.apiInputModalities
    // Translate input modalities into capability tags so existing UI
    // (vision eye icon etc.) picks them up without further changes.
    if (apiMeta.apiInputModalities.includes('image') && !info.capabilities.includes('vision')) {
      info.capabilities = [...info.capabilities, 'vision']
    }
  }
  if (apiMeta?.metadataFromApi) {
    info.metadataFromApi = true
  }
  if (pricing && Object.keys(pricing).length > 0) {
    info.pricing = pricing
  }
  return info
}

/**
 * Format a model ID into a human-readable name
 */
function formatModelName(id: string): string {
  // Try to make a readable name from the model ID
  let name = id

  // Common patterns
  name = name.replace(/^(accounts\/[^/]+\/models\/)/, '') // Fireworks AI pattern
  name = name.replace(/^(models\/)/, '') // Google pattern

  // Capitalize known prefixes
  const knownPrefixes: Record<string, string> = {
    'gpt-4': 'GPT-4',
    'gpt-3': 'GPT-3',
    'o1': 'o1',
    'o3': 'o3',
    'o4': 'o4',
    'claude': 'Claude',
    'gemini': 'Gemini',
    'llama': 'Llama',
    'mixtral': 'Mixtral',
    'mistral': 'Mistral',
    'codestral': 'Codestral',
    'glm': 'GLM',
    'moonshot': 'Moonshot',
    'qwen': 'Qwen',
    'deepseek': 'DeepSeek',
    'MiniMax': 'MiniMax',
    'abab': 'ABAB',
  }

  for (const [prefix, replacement] of Object.entries(knownPrefixes)) {
    if (name.toLowerCase().startsWith(prefix.toLowerCase())) {
      name = replacement + name.slice(prefix.length)
      break
    }
  }

  return name
}

/**
 * Guess model capabilities based on the model ID
 */
function guessCapabilities(id: string): ModelCapability[] {
  const lower = id.toLowerCase()
  const caps: ModelCapability[] = []

  // Most modern models support code and writing
  caps.push('code')

  if (lower.includes('vision') || lower.includes('4o') || lower.includes('gemini')) {
    caps.push('vision')
  }
  if (lower.includes('flash') || lower.includes('mini') || lower.includes('turbo') || lower.includes('fast')) {
    caps.push('fast')
  }
  if (lower.includes('reason') || lower.includes('o1') || lower.includes('o3') || lower.includes('o4') || lower.includes('pro') || lower.includes('max')) {
    caps.push('reasoning')
  }
  if (lower.includes('128k') || lower.includes('200k') || lower.includes('1m') || lower.includes('long')) {
    caps.push('long-context')
  }

  // Default: add writing if nothing else
  if (caps.length <= 1) {
    caps.push('writing')
  }

  return caps
}

/**
 * Context window registry (static mapping).
 *
 * Maintained manually. When adding a new model, add an entry here.
 * - Exact match has highest priority.
 * - Prefix match is used as fallback (e.g. "gpt-4o-2024-08-06" matches "gpt-4o").
 * - Order matters: more specific patterns should come first.
 *
 * Last updated: 2025-05
 */
const CONTEXT_WINDOW_MAP: Array<{ pattern: string; context: number }> = [
  // ─── OpenAI ──────────────────────────────────────────────────────────────
  { pattern: 'gpt-4o', context: 128000 },
  { pattern: 'gpt-4-turbo', context: 128000 },
  { pattern: 'gpt-4-0125-preview', context: 128000 },
  { pattern: 'gpt-4-1106-preview', context: 128000 },
  { pattern: 'gpt-4-vision', context: 128000 },
  { pattern: 'gpt-4-32k', context: 32768 },
  { pattern: 'gpt-4', context: 8192 },
  { pattern: 'gpt-3.5-turbo-16k', context: 16384 },
  { pattern: 'gpt-3.5-turbo', context: 16385 },
  { pattern: 'o4-mini', context: 200000 },
  { pattern: 'o3', context: 200000 },
  { pattern: 'o3-mini', context: 200000 },
  { pattern: 'o1', context: 200000 },
  { pattern: 'o1-mini', context: 128000 },
  { pattern: 'o1-pro', context: 200000 },

  // ─── Anthropic ───────────────────────────────────────────────────────────
  { pattern: 'claude-opus-4', context: 200000 },
  { pattern: 'claude-sonnet-4', context: 200000 },
  { pattern: 'claude-3-7-sonnet', context: 200000 },
  { pattern: 'claude-3-5-sonnet', context: 200000 },
  { pattern: 'claude-3-5-haiku', context: 200000 },
  { pattern: 'claude-3-opus', context: 200000 },
  { pattern: 'claude-3-sonnet', context: 200000 },
  { pattern: 'claude-3-haiku', context: 200000 },
  { pattern: 'claude', context: 200000 },

  // ─── Google Gemini ──────────────────────────────────────────────────────
  { pattern: 'gemini-2.5-pro', context: 1048576 },
  { pattern: 'gemini-2.5-flash', context: 1048576 },
  { pattern: 'gemini-2.0-pro', context: 1048576 },
  { pattern: 'gemini-2.0-flash', context: 1048576 },
  { pattern: 'gemini-1.5-pro', context: 2097152 },
  { pattern: 'gemini-1.5-flash', context: 1048576 },
  { pattern: 'gemini', context: 1048576 },

  // ─── Groq ───────────────────────────────────────────────────────────────
  { pattern: 'llama-3.3-70b', context: 131072 },
  { pattern: 'llama-3.1-405b', context: 131072 },
  { pattern: 'llama-3.1-70b', context: 131072 },
  { pattern: 'llama-3.1-8b', context: 131072 },
  { pattern: 'llama3-70b', context: 8192 },
  { pattern: 'llama3-8b', context: 8192 },
  { pattern: 'mixtral-8x7b', context: 32768 },
  { pattern: 'gemma2-9b', context: 8192 },

  // ─── Mistral ────────────────────────────────────────────────────────────
  { pattern: 'mistral-large', context: 128000 },
  { pattern: 'mistral-medium', context: 32000 },
  { pattern: 'mistral-small', context: 32000 },
  { pattern: 'codestral', context: 256000 },
  { pattern: 'mistral-7b', context: 32000 },
  { pattern: 'mixtral-8x22b', context: 65536 },
  { pattern: 'mixtral-8x7b', context: 32768 },

  // ─── GLM (智谱) ────────────────────────────────────────────────────────
  { pattern: 'glm-4-plus', context: 128000 },
  { pattern: 'glm-4-air', context: 128000 },
  { pattern: 'glm-4-flash', context: 128000 },
  { pattern: 'glm-4-long', context: 1048576 },
  { pattern: 'glm-4', context: 128000 },
  { pattern: 'glm-4v', context: 128000 },
  { pattern: 'glm', context: 128000 },

  // ─── Kimi (月之暗面) ───────────────────────────────────────────────────
  { pattern: 'moonshot-v1-128k', context: 131072 },
  { pattern: 'moonshot-v1-32k', context: 32768 },
  { pattern: 'moonshot-v1-8k', context: 8192 },
  { pattern: 'kimi', context: 131072 },
  { pattern: 'moonshot', context: 131072 },

  // ─── MiniMax ────────────────────────────────────────────────────────────
  { pattern: 'abab6.5s', context: 245760 },
  { pattern: 'abab6.5', context: 245760 },
  { pattern: 'abab5.5', context: 16384 },
  { pattern: 'minimax', context: 245760 },

  // ─── Qwen (通义千问) ──────────────────────────────────────────────────
  { pattern: 'qwen-max', context: 32768 },
  { pattern: 'qwen-plus', context: 131072 },
  { pattern: 'qwen-turbo', context: 131072 },
  { pattern: 'qwen-long', context: 1048576 },
  { pattern: 'qwen2.5', context: 131072 },
  { pattern: 'qwen2', context: 131072 },
  { pattern: 'qwen', context: 131072 },

  // ─── DeepSeek ──────────────────────────────────────────────────────────
  { pattern: 'deepseek-v4-pro', context: 1048576 },
  { pattern: 'deepseek-v4-flash', context: 1048576 },
  { pattern: 'deepseek-v4', context: 1048576 },
  { pattern: 'deepseek-r1', context: 131072 },
  { pattern: 'deepseek-v3', context: 131072 },
  { pattern: 'deepseek-chat', context: 131072 },
  { pattern: 'deepseek-coder', context: 16384 },
  { pattern: 'deepseek', context: 131072 },
]

/**
 * Look up context window size from the static registry.
 * Longer (more specific) patterns are tried first to avoid shorter patterns
 * matching prematurely (e.g. "deepseek-v4-pro" must match before "deepseek").
 */
function guessContextWindow(id: string): number {
  // 0. OpenRouter static snapshot (authoritative — covers 338 models).
  //    This is the primary source, checked before the heuristic table below.
  const orCtx = getOpenRouterContextWindow(id)
  if (orCtx != null && orCtx > 0) return orCtx

  const lower = id.toLowerCase()

  // 1. Explicit size hints in the ID (e.g. "128k", "32k")
  if (lower.includes('128k')) return 128000
  if (lower.includes('32k')) return 32000
  if (lower.includes('8k')) return 8000

  // 2. Lookup from registry — sort by pattern length descending so
  //    more specific patterns (e.g. "deepseek-v4-pro") take priority
  //    over generic ones (e.g. "deepseek").
  const sorted = [...CONTEXT_WINDOW_MAP].sort((a, b) => b.pattern.length - a.pattern.length)
  for (const { pattern, context } of sorted) {
    if (lower.startsWith(pattern) || lower.includes(pattern)) {
      return context
    }
  }

  // 3. Default fallback
  return 128000
}

/**
 * Score a model ID for sorting (higher = shown first)
 */
function getModelSortScore(id: string): number {
  const lower = id.toLowerCase()
  let score = 0

  // Prefer specific known models
  if (lower.includes('gpt-4o') && !lower.includes('mini')) score += 100
  if (lower.includes('claude-sonnet-4') || lower.includes('claude-4')) score += 100
  if (lower.includes('gemini-2') && lower.includes('pro')) score += 100
  if (lower.includes('glm-5')) score += 100
  if (lower.includes('qwen-max') || lower.includes('qwen-plus')) score += 90
  if (lower.includes('llama-3.3')) score += 80

  // Deprioritize embedding models, TTS, image generation, etc.
  if (lower.includes('embed')) score -= 200
  if (lower.includes('tts')) score -= 200
  if (lower.includes('dall-e') || lower.includes('dalle')) score -= 200
  if (lower.includes('whisper')) score -= 200
  if (lower.includes('audio')) score -= 100
  if (lower.includes('image')) score -= 100
  if (lower.includes('moderation')) score -= 200
  if (lower.includes('text-embedding')) score -= 200
  if (lower.includes('text-moderation')) score -= 200

  // Prefer non-mini/flash for general listing
  if (lower.includes('mini') || lower.includes('flash')) score -= 10

  return score
}
