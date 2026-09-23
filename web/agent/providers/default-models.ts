/**
 * Default pinned ("favorite") models per built-in provider.
 *
 * Seeding behavior: when the user saves an API key (or logs in via a device
 * flow) for a provider and has NEVER pinned a model for it, the settings UI
 * auto-pins the entries below so the top-bar model switcher is immediately
 * usable. Removing the pins is always respected — the seed only runs on an
 * empty pin list and never re-runs afterwards.
 *
 * Curation rule: pick the best value-for-money ("性价比") model per provider,
 * typically the fast/flash/mini tier that is still strong enough for agent
 * work. Model ids must match what the provider's API actually serves; ids
 * absent from a fetched /models response are simply not pinned (the helper
 * intersects against the live catalog when one is available).
 *
 * Deliberately NOT listed here:
 *   - openrouter: dynamic catalog (static models: []) — any static guess
 *     would risk stale pins; seed from the fetched list only (the helper
 *     returns [] without a catalog for these providers).
 *   - codex-oauth: models come from the extension's live catalog; the
 *     recommended-first ordering (GPT-6 Luna → GPT-5.6 Luna fallback) lives
 *     in store/extension.store.ts (RECOMMENDED_FIRST).
 *   - custom-* providers: user-defined catalogs.
 *
 * 火山方舟 Coding (volcengine-coding) has an empty static list too, but IS
 * listed: its catalog is fetched from the ARK API at key-save time and the
 * helper intersects, so a curated id only pins when actually served. The
 * id follows ByteDance's Doubao Seed naming; dated variants (e.g.
 * `seed-2.0-code-20260730`) are matched via the dated-suffix rule below.
 */

export const DEFAULT_PINNED_MODELS: Partial<Record<string, readonly string[]>> = {
  // ── International ──
  openai: ['gpt-4o-mini'],
  anthropic: ['claude-3-5-haiku-20241022'],
  google: ['gemini-2.0-flash'],
  groq: ['llama-3.3-70b-versatile'],
  mistral: ['mistral-medium-latest'],
  // OpenRouter: dynamic catalog — see module docblock.

  // ── Chinese ──
  deepseek: ['deepseek-v4-flash'],
  glm: ['glm-5.3-flash'],
  'glm-coding': ['glm-5.3-flash'],
  kimi: ['moonshot-v1-32k'],
  minimax: ['MiniMax-M2.7-highspeed'],
  'minimax-cn': ['MiniMax-M2.7-highspeed'],
  qwen: ['qwen-turbo'],
  // 火山方舟 Coding — ARK coding endpoint; Doubao Seed Code is the value pick.
  'volcengine-coding': ['doubao-seed-2.0-code'],

  // ── Dynamic providers ──
  // Nutstore AI (坚果云 AI) gateway — catalog comes from GET /v1/models;
  // deepseek-v4.1-flash is the curated value default.
  'llm-gateway': ['deepseek-v4.1-flash'],
}

/**
 * Default pinned models for a provider.
 *
 * @param providerType  Provider id (built-in, 'llm-gateway', 'custom-*', …)
 * @param availableIds  When given, defaults are intersected with the live
 *                      catalog so we never pin a model the provider doesn't
 *                      serve; an empty intersection returns [] (no seed).
 *                      Match rules per curated id:
 *                        1. exact id match; or
 *                        2. dated-suffix variant — `<id>-<YYYYMMDD>` (model
 *                           catalogs commonly expose dated snapshots under
 *                           the same logical id, e.g. `seed-2.0-code` →
 *                           `seed-2.0-code-20260730`), in which case the
 *                           DATED variant is pinned (it is a real served id).
 *                      When omitted, the curated defaults are returned as-is
 *                      (blind seed — used when no catalog fetch happened).
 */
export function getDefaultPinnedModels(
  providerType: string,
  availableIds?: readonly string[],
): string[] {
  const defaults = DEFAULT_PINNED_MODELS[providerType]
  if (!defaults || defaults.length === 0) return []
  if (!availableIds) return [...defaults]
  const served = new Set(availableIds)
  const result: string[] = []
  for (const id of defaults) {
    if (served.has(id)) {
      result.push(id)
      continue
    }
    // Dated-suffix variant: only `-YYYYMMDD` counts — a bare prefix rule
    // would wrongly match unrelated families like `seed-2.0-code-pro`.
    const suffix = id.length + 9 // '-' + 8 digits
    const variant = availableIds.find(
      (a) => a.length === suffix && a.startsWith(`${id}-`) && /^\d{8}$/.test(a.slice(id.length + 1)),
    )
    if (variant) result.push(variant)
  }
  return result
}
