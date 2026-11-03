/**
 * Unit tests for resolveDefaultModelSelection's failed vs authoritative-empty
 * catalog handling (PR #150 round 4).
 *
 * - A FAILED catalog is UNKNOWN: the resolver DEFERS, both when the current
 *   provider failed and when only alternative providers failed (never switch
 *   onto a provider whose catalog is unknown).
 * - An AUTHORITATIVE empty catalog is real information: the resolver moves
 *   off the emptied provider onto one with a KNOWN non-empty catalog.
 */
import { describe, expect, it } from 'vitest'
import { resolveDefaultModelSelection, type AvailableProviderLike } from '@/store/model-selection'

function provider(partial: Partial<AvailableProviderLike> & { providerType: string }): AvailableProviderLike {
  return {
    models: [],
    authoritativeIds: [],
    catalogStatus: 'ready',
    ...partial,
  }
}

describe('resolveDefaultModelSelection: failed vs authoritative-empty catalogs', () => {
  const current = { providerType: 'p1', modelName: 'm-gone' }

  it('defers when the CURRENT provider catalog failed, even with another provider available', () => {
    const providers = [
      provider({ providerType: 'p1', catalogStatus: 'failed' }),
      provider({ providerType: 'p2', models: [{ id: 'a-1', name: 'A' }], authoritativeIds: ['a-1'] }),
    ]
    expect(resolveDefaultModelSelection(providers, current)).toEqual({
      action: 'defer',
      providerType: 'p1',
      modelName: 'm-gone',
      reason: 'catalog-failed',
    })
  })

  it('never switches onto a provider whose catalog is unknown (failed)', () => {
    const providers = [
      provider({ providerType: 'p1', catalogStatus: 'empty' }),
      provider({ providerType: 'p2', catalogStatus: 'failed', models: [{ id: 'x', name: 'X' }] }),
    ]
    const resolution = resolveDefaultModelSelection(providers, current)
    // p2 is skipped despite exposing a model — its catalog is unknown.
    expect(resolution.action).not.toBe('switch')
    expect(resolution.providerType).not.toBe('p2')
  })

  it('switches to the alternative on an AUTHORITATIVE empty current catalog', () => {
    const providers = [
      provider({ providerType: 'p1', catalogStatus: 'empty' }),
      provider({ providerType: 'p2', models: [{ id: 'a-1', name: 'A' }], authoritativeIds: ['a-1'] }),
    ]
    expect(resolveDefaultModelSelection(providers, current)).toEqual({
      action: 'switch',
      providerType: 'p2',
      modelName: 'a-1',
      reason: 'first-available',
    })
  })

  it('reports no-models when every catalog is authoritatively empty', () => {
    const providers = [
      provider({ providerType: 'p1', catalogStatus: 'empty' }),
      provider({ providerType: 'p2', catalogStatus: 'empty' }),
    ]
    expect(resolveDefaultModelSelection(providers, current).action).toBe('none')
  })
})
