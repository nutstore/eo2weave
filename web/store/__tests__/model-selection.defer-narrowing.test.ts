/**
 * Functional test for the Sourcery round-4 "Unrelated selection stays
 * invalid" fix: while the gateway catalog is still LOADING, a selection on
 * an INVALID non-gateway model must reconcile to an available fallback —
 * only the current selection's own loading catalog may defer it.
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

describe('resolveDefaultModelSelection: defer narrowing while a catalog is loading', () => {
  it('reconciles an invalid non-gateway selection while the gateway catalog is loading', () => {
    const providers = [
      provider({ providerType: 'openai', models: [{ id: 'gone' }], authoritativeIds: ['gone'] }),
      provider({ providerType: 'llm-gateway', catalogStatus: 'loading' }),
    ]
    expect(
      resolveDefaultModelSelection(providers, { providerType: 'openai', modelName: 'removed-model' }),
    ).toEqual({
      action: 'switch',
      providerType: 'openai',
      modelName: 'gone',
      reason: 'current-provider-fallback',
    })
  })

  it('still defers when the CURRENT selection provider catalog is loading', () => {
    const providers = [
      provider({ providerType: 'llm-gateway', catalogStatus: 'loading' }),
      provider({ providerType: 'p2', models: [{ id: 'a-1', name: 'A' }], authoritativeIds: ['a-1'] }),
    ]
    expect(
      resolveDefaultModelSelection(providers, { providerType: 'llm-gateway', modelName: 'm-gw' }),
    ).toMatchObject({ action: 'defer', reason: 'catalog-loading' })
  })

  it('defers an empty selection while any catalog is loading', () => {
    const providers = [
      provider({ providerType: 'llm-gateway', catalogStatus: 'loading' }),
      provider({ providerType: 'p2', models: [{ id: 'a-1', name: 'A' }], authoritativeIds: ['a-1'] }),
    ]
    expect(
      resolveDefaultModelSelection(providers, { providerType: '', modelName: '' }),
    ).toMatchObject({ action: 'defer', reason: 'catalog-loading' })
  })
})
