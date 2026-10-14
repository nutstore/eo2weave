import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDynamicModels } from '../use-dynamic-models'

const mocks = vi.hoisted(() => ({
  fetchModelsForProvider: vi.fn(),
  getCachedModels: vi.fn(),
  getCachedModelsResult: vi.fn(),
  isCacheStale: vi.fn(),
  loadApiKey: vi.fn(),
  setCachedModels: vi.fn(),
}))

vi.mock('../model-fetcher', () => ({
  fetchModelsForProvider: mocks.fetchModelsForProvider,
}))

vi.mock('../model-store', () => ({
  getCachedModels: mocks.getCachedModels,
  getCachedModelsResult: mocks.getCachedModelsResult,
  isCacheStale: mocks.isCacheStale,
  setCachedModels: mocks.setCachedModels,
}))

vi.mock('@/security/api-key-store', () => ({
  loadApiKey: mocks.loadApiKey,
}))

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.getCachedModels.mockReturnValue(null)
  mocks.getCachedModelsResult.mockReturnValue(null)
  mocks.isCacheStale.mockReturnValue(true)
  mocks.loadApiKey.mockResolvedValue('saved-secret')
  mocks.fetchModelsForProvider.mockResolvedValue({
    models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', capabilities: ['fast'] }],
    source: 'dynamic',
    fetchedAt: Date.now(),
  })
})

describe('useDynamicModels stale refresh', () => {
  it('loads the saved credential instead of using the provider cache key as an API key', async () => {
    renderHook(() => useDynamicModels('deepseek', 'deepseek'))

    await waitFor(() => expect(mocks.fetchModelsForProvider).toHaveBeenCalled())
    expect(mocks.loadApiKey).toHaveBeenCalledWith('deepseek')
    expect(mocks.fetchModelsForProvider).toHaveBeenCalledWith('deepseek', {
      apiKey: 'saved-secret',
      baseUrl: 'https://api.deepseek.com',
    })
  })

  it('does not fetch a built-in provider when no credential is stored', async () => {
    mocks.loadApiKey.mockResolvedValue(null)

    renderHook(() => useDynamicModels('deepseek', 'deepseek'))

    await waitFor(() => expect(mocks.loadApiKey).toHaveBeenCalledWith('deepseek'))
    expect(mocks.fetchModelsForProvider).not.toHaveBeenCalled()
  })
})
