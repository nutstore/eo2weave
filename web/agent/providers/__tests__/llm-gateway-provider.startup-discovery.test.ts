/**
 * Startup gateway discovery must be bounded (Sourcery: "Startup discovery
 * can hang"): AppBootstrap awaits updateGatewayModels() before
 * isStorageReady, so a gateway that accepts the saved token but never
 * answers /v1/models must not hang startup. The refresh is bound with the
 * same model-discovery deadline as the login and gateway-card paths and
 * degrades by REJECTING (the caller's catch already handles it) — never
 * registering a stale or empty catalog.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchGatewayModels: vi.fn(),
}))

vi.mock('../llm-gateway-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llm-gateway-auth')>()
  return { ...actual, fetchGatewayModels: mocks.fetchGatewayModels }
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

import { updateGatewayModels } from '../llm-gateway-provider'

const MODEL_DISCOVERY_TIMEOUT_MS = 15_000

describe('updateGatewayModels startup discovery deadline', () => {
  beforeEach(() => {
    mocks.fetchGatewayModels.mockReset()
  })

  it('rejects with the deadline instead of hanging when /v1/models never answers, and registers nothing', async () => {
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
})
