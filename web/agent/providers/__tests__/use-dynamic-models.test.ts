import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDynamicModels } from '../use-dynamic-models'

// The negative-cache window lives in the module under test; importing the
// real module's constant keeps the test in sync with it.
const FAILED_FETCH_RETRY_MS = 5 * 60 * 1000

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

  it('retries automatically after the failed-fetch negative-cache window expires (Sourcery: failed fetches do not retry)', async () => {
    vi.useFakeTimers()
    try {
      // First fetch fails → records failedFetchAt and suppresses the
      // automatic retry for FAILED_FETCH_RETRY_MS (5 min). The mounted
      // provider's deps never change, so only the scheduled retry timer can
      // re-trigger the fetch.
      mocks.fetchModelsForProvider.mockRejectedValueOnce(new Error('network down'))

      renderHook(() => useDynamicModels('deepseek', 'deepseek'))
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.fetchModelsForProvider).toHaveBeenCalledTimes(1)

      // Still inside the window: no retry.
      await vi.advanceTimersByTimeAsync(FAILED_FETCH_RETRY_MS - 1000)
      expect(mocks.fetchModelsForProvider).toHaveBeenCalledTimes(1)

      // Window expired: the scheduled timer fires and the hook retries.
      await vi.advanceTimersByTimeAsync(1000)
      expect(mocks.fetchModelsForProvider).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry while the negative-cache window is active', async () => {
    vi.useFakeTimers()
    try {
      // Seed the module-level failedFetchAt map via a first failing fetch
      // that resolves late, so the SWR effect is already inside its window
      // when it re-runs.
      let rejectFetch: ((e: Error) => void) | null = null
      mocks.fetchModelsForProvider.mockImplementationOnce(
        () => new Promise((_resolve, reject) => { rejectFetch = reject }),
      )

      const { unmount } = renderHook(() => useDynamicModels('deepseek', 'deepseek'))
      await vi.advanceTimersByTimeAsync(0)
      rejectFetch!(new Error('network down'))
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.fetchModelsForProvider).toHaveBeenCalledTimes(1)

      // Unmount and remount well inside the window: the remount must NOT
      // fire a doomed request (negative cache still holds), and the
      // remaining-window retry timer must be armed for later.
      unmount()
      await vi.advanceTimersByTimeAsync(FAILED_FETCH_RETRY_MS - 2000)
      renderHook(() => useDynamicModels('deepseek', 'deepseek'))
      await vi.advanceTimersByTimeAsync(1000)
      expect(mocks.fetchModelsForProvider).toHaveBeenCalledTimes(1)

      // Window expires: exactly one scheduled retry.
      await vi.advanceTimersByTimeAsync(1000)
      expect(mocks.fetchModelsForProvider).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
