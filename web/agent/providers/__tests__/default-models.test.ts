import { describe, expect, it } from 'vitest'
import { DEFAULT_PINNED_MODELS, getDefaultPinnedModels } from '../default-models'
import { PROVIDER_META } from '../types'

describe('getDefaultPinnedModels', () => {
  it('returns curated defaults as-is when no catalog is given (blind seed)', () => {
    expect(getDefaultPinnedModels('glm')).toEqual(['glm-5.3-flash'])
    expect(getDefaultPinnedModels('llm-gateway')).toEqual(['deepseek-v4.1-flash'])
    expect(getDefaultPinnedModels('codex-oauth')).toEqual([])
  })

  it('intersects with the live catalog and drops out-of-curation ids', () => {
    // glm default exists in the served list → kept
    expect(getDefaultPinnedModels('glm', ['glm-5.3-flash', 'glm-5.1'])).toEqual(['glm-5.3-flash'])
    // glm default NOT served anymore → nothing seeded
    expect(getDefaultPinnedModels('glm', ['glm-5.1'])).toEqual([])
    // gateway default missing from catalog → nothing seeded
    expect(getDefaultPinnedModels('llm-gateway', ['glm-5.1', 'gpt-4o'])).toEqual([])
  })

  it('never pins anything for unlisted providers (custom-*, openrouter)', () => {
    expect(getDefaultPinnedModels('custom-1758123456789-abc123')).toEqual([])
    expect(getDefaultPinnedModels('custom-xxx', ['any-model'])).toEqual([])
    expect(getDefaultPinnedModels('openrouter', ['openai/gpt-5.6-luna'])).toEqual([])
  })

  it('returns a fresh array copy (callers may sort/mutate)', () => {
    const a = getDefaultPinnedModels('glm')
    const b = getDefaultPinnedModels('glm')
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })

  it('skips openrouter on purpose (documented in module docblock)', () => {
    expect(DEFAULT_PINNED_MODELS['openrouter']).toBeUndefined()
    expect(DEFAULT_PINNED_MODELS['codex-oauth']).toBeUndefined()
  })

  it('static-only providers (no /models fetch) must have curated ids in the static catalog', () => {
    // anthropic has no list-models API (STATIC_ONLY_PROVIDERS in
    // model-fetcher.ts) — its seed is ALWAYS blind, so the curated id must
    // exist in the static catalog or the pin is stale at creation time.
    const served = new Set(PROVIDER_META.anthropic.models.map((m) => m.id))
    for (const id of getDefaultPinnedModels('anthropic')) {
      expect(served.has(id), `anthropic curated default "${id}" not in static catalog`).toBe(true)
    }
  })

  it('fetchable providers may carry forward-looking curated ids (intersection guards at save time)', () => {
    // glm-5.3-flash / deepseek-v4.1-flash are newer than the repo's static
    // snapshots — that's fine: those providers refresh from /models at key
    // save, and getDefaultPinnedModels intersects, so a not-yet-served id is
    // simply skipped. Assert the guard works end-to-end from the static list.
    const glmServed = PROVIDER_META.glm.models.map((m) => m.id)
    // Static snapshot predates 5.3 → blind data would pin nothing wrong.
    expect(getDefaultPinnedModels('glm', glmServed)).toEqual(
      glmServed.includes('glm-5.3-flash') ? ['glm-5.3-flash'] : [],
    )
  })

  it('matches dated-suffix catalog variants (doubao seed snapshots)', () => {
    // Exact id served → pinned as-is.
    expect(getDefaultPinnedModels('volcengine-coding', ['doubao-seed-2.0-code', 'doubao-seed-2.0-mini']))
      .toEqual(['doubao-seed-2.0-code'])
    // Only the dated snapshot is served → the DATED variant is pinned.
    expect(getDefaultPinnedModels('volcengine-coding', ['doubao-seed-2.0-code-20260730']))
      .toEqual(['doubao-seed-2.0-code-20260730'])
    // Unrelated families sharing the prefix must NOT match.
    expect(getDefaultPinnedModels('volcengine-coding', ['doubao-seed-2.0-code-pro', 'doubao-seed-2.0-codex']))
      .toEqual([])
  })
})
