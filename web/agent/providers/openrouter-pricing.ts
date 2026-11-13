/**
 * OpenRouter Pricing & Context-Window Reference (static snapshot + runtime refresh)
 *
 * Per-token USD pricing and context-window lengths, sourced from OpenRouter's
 * public /api/v1/models endpoint.
 *
 * Two layers:
 *   1. Static snapshot (src/data/openrouter-models.json) — bundled at build
 *      time, imported directly. BOOTSTRAP fallback: guarantees data on first
 *      load even with zero network. May lag upstream (new models missing).
 *   2. Runtime refresh overlay — background fetch of the live endpoint on
 *      app start (throttled to once per day, persisted in localStorage).
 *      Once fetched, the overlay REPLACES the snapshot in the in-memory index
 *      so newly-released models (e.g. a V4.1 two weeks after the snapshot)
 *      resolve correctly.
 *
 * The snapshot avoids the GLM-5.2 prefix-match bug (missing from a
 * hand-maintained table → fell back to glm-5's wrong price) by covering all
 * models automatically.
 *
 * To manually refresh the bundled snapshot:
 *   curl https://openrouter.ai/api/v1/models > src/data/openrouter-models.json
 */

// Static JSON import (resolveJsonModule: true in base tsconfig).
// `as unknown as` is required — TypeScript infers each entry as a precise
// literal with per-object optional fields (e.g. web_search?: undefined),
// which doesn't directly satisfy the relaxed `Record<string, string>`
// pricing shape we read.
import orSnapshotRaw from '@/data/openrouter-models.json'
import { llmFetch } from '@/agent/llm/llm-fetch'

interface ORSnapshotShape {
  data?: Array<{
    id: string
    pricing?: Record<string, string>
    context_length?: number
    architecture?: { input_modalities?: string[] }
  }>
}
const orSnapshot = orSnapshotRaw as unknown as ORSnapshotShape

// ─── Types ───────────────────────────────────────────────────────────────────

/** Pricing in USD per 1M tokens (already converted from per-token). */
export interface ORPricing {
  input: number
  output: number
  cacheRead?: number
}

interface ORModelEntry {
  id: string // full OpenRouter id, e.g. "z-ai/glm-5.2"
  input: number | null
  output: number | null
  cacheRead: number | null
  contextLength: number | null
  inputModalities: string[] | null // e.g. ["text", "image", "file"]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip a leading "vendor/" prefix, e.g. "z-ai/glm-5.2" → "glm-5.2". */
function stripVendorPrefix(id: string): string {
  const idx = id.lastIndexOf('/')
  return idx >= 0 ? id.slice(idx + 1) : id
}

/** Parse a per-token USD string → USD/1M, or null if absent/invalid. */
function perTokenToPerMillion(s: string | undefined | null): number | null {
  if (s == null) return null
  const n = parseFloat(s)
  // Reject sentinel values like "-1" (OpenRouter uses this for "dynamic")
  if (!Number.isFinite(n) || n < 0) return null
  return n * 1_000_000
}

// ─── Index ───────────────────────────────────────────────────────────────────

function buildIndex(
  data: {
    data?: Array<{
      id: string
      pricing?: Record<string, string>
      context_length?: number
      architecture?: { input_modalities?: string[] }
    }>
  }
): {
  byBare: Record<string, ORModelEntry>
  byFull: Record<string, ORModelEntry>
} {
  const models = data.data ?? []
  const byBare: Record<string, ORModelEntry> = {}
  const byFull: Record<string, ORModelEntry> = {}

  for (const m of models) {
    const p = m.pricing ?? {}
    const inputModalities =
      Array.isArray(m.architecture?.input_modalities) &&
      m.architecture!.input_modalities!.length > 0
        ? m.architecture!.input_modalities!
        : null
    const entry: ORModelEntry = {
      id: m.id,
      input: perTokenToPerMillion(p.prompt),
      output: perTokenToPerMillion(p.completion),
      cacheRead: perTokenToPerMillion(p.input_cache_read),
      contextLength:
        typeof m.context_length === 'number' && m.context_length > 0
          ? m.context_length
          : null,
      inputModalities,
    }
    // Skip entries with no usable pricing AND no context length AND no modalities
    if (
      entry.input == null &&
      entry.output == null &&
      entry.contextLength == null &&
      entry.inputModalities == null
    )
      continue

    byFull[m.id] = entry
    const bare = stripVendorPrefix(m.id)
    if (bare) byBare[bare] = entry
  }

  return { byBare, byFull }
}

let index = buildIndex(orSnapshot)

/**
 * Swap the in-memory index for a fresher dataset (runtime refresh overlay).
 * All synchronous getters below consult the live `index` binding, so once a
 * refresh lands, newly-released models resolve without any code change.
 * Returns false (index untouched) for empty payloads — a degenerate response
 * must not evict the bundled snapshot, nor count as a successful refresh.
 */
function swapIndex(data: ORSnapshotShape): boolean {
  const next = buildIndex(data)
  if (Object.keys(next.byFull).length === 0) return false
  index = next
  return true
}

/**
 * Run the refresh immediately: fetch the live model list with a bounded
 * timeout, swap the in-memory index on success, persist the throttle
 * timestamp. Resolves to true only when a fresh dataset actually replaced
 * the index.
 *
 * Concurrent callers share a single in-flight attempt (one fetch, one swap);
 * the slot is cleared on settle so a failed attempt can be retried at once
 * (e.g. the manual settings button after a failed auto-refresh).
 */
let inflight: Promise<boolean> | null = null

export function refreshOpenRouterModelsNow(): Promise<boolean> {
  if (inflight) return inflight
  inflight = doRefreshOpenRouterModels()
  void inflight.finally(() => {
    inflight = null
  })
  return inflight
}

async function doRefreshOpenRouterModels(): Promise<boolean> {
  try {
    const res = await llmFetch(MODELS_ENDPOINT, {
      headers: { Accept: 'application/json' },
      // Same 10s bound as every other provider fetch (model-fetcher,
      // deepseek-provider): a hung gateway must not spin the manual refresh
      // spinner forever or occupy the daily auto-refresh window.
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return false
    // Proxied challenge/error pages are usually HTML — reject before parsing.
    // Absent content-type stays lenient; the shape check below still rules.
    const contentType = res.headers.get('content-type')
    if (contentType && !contentType.includes('json')) return false
    const parsed = (await res.json()) as ORSnapshotShape
    if (!parsed || !Array.isArray(parsed.data)) return false
    const swapped = swapIndex(parsed)
    if (!swapped) return false
    try {
      localStorage.setItem(STORAGE_KEY_FRESH_AT, String(Date.now()))
    } catch {
      /* private mode / storage disabled — skip persistence, refetch next boot */
    }
    return true
  } catch (err) {
    // Offline / timeout / bad JSON — no user-facing noise, but leave one
    // diagnostics line: a persistently failing refresh is otherwise
    // indistinguishable from "already refreshed today".
    console.warn('[openrouter-pricing] refresh failed:', err)
    return false
  }
}

/**
 * Background auto-refresh, throttled to once per 24h via localStorage.
 * Fire-and-forget: never blocks startup, never throws, and stays quiet to
 * users on failure (one diagnostics console.warn; the bundled snapshot keeps
 * serving as fallback). Called once from AppBootstrap on app start.
 */
export function maybeRefreshOpenRouterModels(): void {
  if (typeof window === 'undefined') return
  try {
    const last = Number(localStorage.getItem(STORAGE_KEY_FRESH_AT) ?? 0)
    if (Number.isFinite(last) && Date.now() - last < REFRESH_INTERVAL_MS) return
  } catch {
    /* storage unavailable — still attempt the refresh */
  }
  void refreshOpenRouterModelsNow()
}

/** Look up a raw ORModelEntry by model id (sync). Returns null if unknown.
 *  Case-insensitive — OpenRouter ids are always lowercase, but callers may
 *  pass mixed-case (e.g. "Minimax/MiniMax-m3" from a passthrough provider). */
function findEntry(modelId: string): ORModelEntry | null {
  if (!modelId) return null
  // Lowercase the input so OpenRouter's lowercase ids match regardless of
  // how the caller capitalised the model name.
  const lower = modelId.toLowerCase()
  const candidates = [lower, stripVendorPrefix(lower)].filter(Boolean)
  for (const c of candidates) {
    const e = index.byFull[c] ?? index.byBare[c]
    if (e) return e
  }
  return null
}

// ─── Refresh constants & storage keys ───────────────────────────────────────

const MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models'
/** Re-fetch the live model list at most once per day. */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
const STORAGE_KEY_FRESH_AT = 'cw.openrouter-models.fetchedAt'

// ─── Public API (all synchronous) ────────────────────────────────────────────

/**
 * Look up pricing for a model by its name or OpenRouter id.
 *
 * Tries (in order):
 *   1. Exact full-id match (e.g. "z-ai/glm-5.2")
 *   2. Bare-name match after stripping vendor prefix (e.g. "glm-5.2")
 *
 * Returns null if the model is unknown or has no pricing.
 */
export function getOpenRouterPricing(modelId: string): ORPricing | null {
  const entry = findEntry(modelId)
  if (!entry) return null
  if (entry.input == null && entry.output == null) return null

  return {
    input: entry.input ?? 0,
    output: entry.output ?? 0,
    ...(entry.cacheRead != null ? { cacheRead: entry.cacheRead } : {}),
  }
}

/**
 * Look up a model's max context length (in tokens).
 * Returns null if the model is unknown; the caller should fall back
 * to its own default (e.g. 128000) when null.
 */
export function getOpenRouterContextWindow(modelId: string): number | null {
  const entry = findEntry(modelId)
  if (!entry || entry.contextLength == null) return null
  return entry.contextLength
}

/**
 * Look up a model's input modalities (e.g. ["text", "image", "file"]) from the
 * OpenRouter snapshot.
 *
 * Returns null if the model is unknown or has no modality info.
 * Use this to avoid hardcoding vision capabilities — a model's ability to
 * accept image inputs should be driven by authoritative metadata, not by
 * model-name guessing.
 */
export function getOpenRouterInputModalities(modelId: string): string[] | null {
  const entry = findEntry(modelId)
  if (!entry || entry.inputModalities == null) return null
  return entry.inputModalities
}
