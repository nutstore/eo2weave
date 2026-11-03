/**
 * Startup gateway discovery must be bounded (Sourcery: "Startup discovery
 * can hang"): AppBootstrap awaits updateGatewayModels() before
 * isStorageReady, so a gateway that accepts the saved token but never
 * answers /v1/models must not hang startup. The refresh is bound with the
 * same model-discovery deadline as the login and gateway-card paths and
 * degrades by REJECTING (the caller's catch already handles it) while
 * marking the retained model list as non-authoritative.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchGatewayModels: vi.fn(),
  refreshAccessTokenWithStatus: vi.fn(),
  generation: 0,
}))

vi.mock('@/agent/providers/llm-gateway-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/providers/llm-gateway-auth')>()
  return { ...actual, fetchGatewayModels: mocks.fetchGatewayModels, refreshAccessTokenWithStatus: mocks.refreshAccessTokenWithStatus, getGatewayAuthSessionGeneration: () => mocks.generation }
})

// AbortSignal.timeout is backed by a real (unfakeable) timer; substitute a
// setTimeout-based signal so vi fake timers can drive the deadline.
const timeoutSpy = vi
  .spyOn(AbortSignal, 'timeout')
  .mockImplementation((ms: number) => {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(new Error('model discovery timed out')), ms)
    return ctrl.signal
  })
void timeoutSpy

import { updateGatewayModels } from '@/agent/providers/llm-gateway-provider'
import { getModelsForProvider, getProviderCatalogStatus, unregisterDynamicProvider } from '@/agent/providers/types'

const MODEL_DISCOVERY_TIMEOUT_MS = 15_000

describe('updateGatewayModels startup discovery deadline', () => {
  beforeEach(() => {
    mocks.fetchGatewayModels.mockReset()
    mocks.refreshAccessTokenWithStatus.mockReset()
    mocks.generation = 0
    unregisterDynamicProvider('llm-gateway')
  })

  it('rejects with the deadline instead of hanging when /v1/models never answers', async () => {
    vi.useFakeTimers()
    try {
      // A gateway that accepts the token but never responds: the fetch
      // settles only when the passed signal aborts.
      let capturedSignal: AbortSignal | null = null
      mocks.fetchGatewayModels.mockImplementation(
        (_baseURL: string, _token: string, signal: AbortSignal) => {
          capturedSignal = signal
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason))
          })
        },
      )

      const pending = updateGatewayModels('token')
      const expectation = expect(pending).rejects.toThrow('model discovery timed out')

      await vi.advanceTimersByTimeAsync(MODEL_DISCOVERY_TIMEOUT_MS - 1)
      expect(capturedSignal).not.toBeNull()
      // Still inside the deadline: the discovery is pending, not settled.
      let settled = false
      pending.catch(() => {}).then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expectation
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes an abort signal to the discovery fetch and registers a successful catalog', async () => {
    mocks.fetchGatewayModels.mockResolvedValue({
      models: [{ id: 'glm-5.2', name: 'GLM' }],
      status: 'ready',
    })

    const models = await updateGatewayModels('token')

    expect(mocks.fetchGatewayModels).toHaveBeenCalledTimes(1)
    const args = mocks.fetchGatewayModels.mock.calls[0]
    expect(args[2]).toBeInstanceOf(AbortSignal)
    expect(models.map((m: { id: string }) => m.id)).toEqual(['glm-5.2'])
  })

  it('discards a catalog response after the gateway session changes', async () => {
    let finish!: (result: { models: Array<{ id: string; name: string }>; status: 'ready' }) => void
    mocks.fetchGatewayModels.mockImplementation(() => new Promise((resolve) => { finish = resolve }))

    const pending = updateGatewayModels('old-token')
    mocks.generation++
    finish({ models: [{ id: 'old-model', name: 'Old' }], status: 'ready' })
    await pending

    expect(getModelsForProvider('llm-gateway')).toEqual([])
  })

  it('does not let an older success replace a newer catalog in the same session', async () => {
    let finishOld!: (result: { models: Array<{ id: string; name: string }>; status: 'ready' }) => void
    mocks.fetchGatewayModels
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve }))
      .mockResolvedValueOnce({ models: [{ id: 'new-model', name: 'New' }], status: 'ready' })

    const oldRefresh = updateGatewayModels('token')
    await updateGatewayModels('token')
    finishOld({ models: [{ id: 'old-model', name: 'Old' }], status: 'ready' })
    await oldRefresh

    expect(getModelsForProvider('llm-gateway').map((m) => m.id)).toEqual(['new-model'])
  })

  it('does not let an older timeout downgrade a newer successful catalog', async () => {
    let failOld!: (error: Error) => void
    mocks.fetchGatewayModels
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failOld = reject }))
      .mockResolvedValueOnce({ models: [{ id: 'new-model', name: 'New' }], status: 'ready' })

    const oldRefresh = updateGatewayModels('token')
    const oldFailure = expect(oldRefresh).rejects.toThrow('timeout')
    await updateGatewayModels('token')
    failOld(new Error('timeout'))
    await oldFailure

    expect(getModelsForProvider('llm-gateway').map((m) => m.id)).toEqual(['new-model'])
    expect(getProviderCatalogStatus('llm-gateway')).toBe('ready')
  })

  it('refreshes an access token rejected by the model endpoint before retrying discovery', async () => {
    mocks.fetchGatewayModels
      .mockResolvedValueOnce({ models: [], status: 'failed', authRejected: true })
      .mockResolvedValueOnce({ models: [{ id: 'recovered-model', name: 'Recovered' }], status: 'ready' })
    mocks.refreshAccessTokenWithStatus.mockResolvedValue({ status: 'success', accessToken: 'new-token' })

    await updateGatewayModels('old-token')

    expect(mocks.refreshAccessTokenWithStatus).toHaveBeenCalledTimes(1)
    expect(mocks.fetchGatewayModels.mock.calls[1]?.[1]).toBe('new-token')
    expect(getModelsForProvider('llm-gateway').map((m) => m.id)).toEqual(['recovered-model'])
  })

  it('clears cached models when the rejected token cannot be refreshed', async () => {
    mocks.fetchGatewayModels.mockResolvedValue({ models: [], status: 'failed', authRejected: true })
    mocks.refreshAccessTokenWithStatus.mockImplementation(async () => {
      unregisterDynamicProvider('llm-gateway')
      return { status: 'expired' }
    })
    mocks.fetchGatewayModels.mockResolvedValueOnce({ models: [{ id: 'old-model', name: 'Old' }], status: 'ready' })
    await updateGatewayModels('old-token')

    await updateGatewayModels('old-token')

    expect(getModelsForProvider('llm-gateway')).toEqual([])
  })
})

describe('updateGatewayModels: 401 refresh is bounded by the discovery deadline', () => {
  beforeEach(() => {
    mocks.fetchGatewayModels.mockReset()
    mocks.refreshAccessTokenWithStatus.mockReset()
    mocks.generation = 0
    unregisterDynamicProvider('llm-gateway')
  })

  it('threads the discovery signal into the rejected-token refresh so a stalled refresh cannot outlive the deadline', async () => {
    vi.useFakeTimers()
    try {
      // First /v1/models answers 401 (authRejected); the refresh endpoint
      // then stalls forever and only settles when the discovery signal
      // aborts it.
      mocks.fetchGatewayModels.mockResolvedValueOnce({
        models: [], status: 'failed', authRejected: true,
      })
      let refreshSignal: AbortSignal | null = null
      mocks.refreshAccessTokenWithStatus.mockImplementation(
        (_baseURL: string, _clientId: string, signal?: AbortSignal) => {
          refreshSignal = signal
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason))
          })
        },
      )

      const pending = updateGatewayModels('stale-token')
      const expectation = expect(pending).rejects.toThrow('model discovery timed out')

      await vi.advanceTimersByTimeAsync(MODEL_DISCOVERY_TIMEOUT_MS - 1)
      // The refresh was invoked WITH the discovery signal...
      expect(refreshSignal).not.toBeNull()
      // ...and the deadline has not fired yet: both stages still pending.
      let settled = false
      pending.catch(() => {}).then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)

      // Deadline fires: the discovery settles (does NOT hang on the stalled
      // refresh), and the signal that aborted it is the one the refresh got.
      await vi.advanceTimersByTimeAsync(1)
      await expectation
      expect((refreshSignal as AbortSignal | null)?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
