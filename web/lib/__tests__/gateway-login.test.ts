import { beforeEach, describe, expect, it, vi } from 'vitest'

const { provider, keyStore, settings } = vi.hoisted(() => ({
  provider: {
    update: vi.fn<() => Promise<Array<{ id: string; name: string }>>>(),
    prepare: vi.fn<(accessToken: string, signal?: AbortSignal) => Promise<{ models: Array<{ id: string; name: string }>; status: 'ready' | 'empty' | 'failed' }>>(),
    register: vi.fn(),
    unregister: vi.fn(),
  },
  keyStore: {
    save: vi.fn<(id: string, key: string) => Promise<void>>(),
    load: vi.fn<(id: string) => Promise<string | null>>(),
    delete: vi.fn<(id: string) => Promise<void>>(),
  },
  settings: {
    modelName: 'old-model',
    pinnedModelsByProvider: { 'llm-gateway': ['old-model'] },
    invalidateApiKeyCache: vi.fn(),
    switchProviderAndModel: vi.fn(),
    setHasApiKey: vi.fn(),
    setModelCredentialStatus: vi.fn(),
    setModelCredentialStatusError: vi.fn(),
    triggerProviderRefresh: vi.fn(),
  },
}))

vi.mock('@/agent/providers/llm-gateway-provider', () => ({
  getLLMGatewayBaseURL: () => 'https://gateway.example',
  getLLMGatewayClientId: () => 'client',
  getLLMGatewayApiKeyProviderKey: () => 'gateway-key',
  LLM_GATEWAY_PROVIDER_TYPE: 'llm-gateway',
  updateGatewayModels: provider.update,
  prepareGatewayModels: provider.prepare,
  registerGatewayModels: provider.register,
  unregisterLLMGatewayProvider: provider.unregister,
}))
vi.mock('@/security/api-key-store', () => ({
  saveApiKey: keyStore.save,
  loadApiKey: keyStore.load,
  deleteApiKey: keyStore.delete,
}))
vi.mock('@/store/settings.store', () => ({
  useSettingsStore: { getState: () => settings },
}))

import { applyGatewayLoginTokens } from '@/lib/gateway-login'

import {
  __resetGatewayCredentialFencingForTests,
} from '@/agent/providers/gateway-credential-lock'

describe('applyGatewayLoginTokens cancellation', () => {
  let savedKey: string | null

  beforeEach(() => {
    vi.clearAllMocks()
    __resetGatewayCredentialFencingForTests()
    // Reset the shared settings mock: mutations from an earlier test
    // (cleared pins, ad-hoc vi.fn()s) must not leak into later ones.
    ;(settings as any).pinnedModelsByProvider = { 'llm-gateway': ['old-model'] }
    ;(settings as any).setPinnedModels = vi.fn()
    ;(settings as any).markPinnedModelsSeen = vi.fn()
    savedKey = 'previous-key'
    keyStore.load.mockImplementation(async () => savedKey)
    keyStore.save.mockImplementation(async (_id, key) => { savedKey = key })
    keyStore.delete.mockImplementation(async () => { savedKey = null })
    provider.update.mockResolvedValue([{ id: 'new-model', name: 'New' }])
    provider.prepare.mockResolvedValue({ models: [{ id: 'new-model', name: 'New' }], status: 'ready' })
  })

  it('does not persist a credential when cancelled during model preparation', async () => {
    // The abort must land while preparation is IN FLIGHT: wait until
    // provider.prepare has been invoked and its promise is still pending,
    // then cancel. Aborting before the awaited import reaches prepare would
    // pass trivially even if cancellation mid-preparation were mishandled.
    let finish!: (result: { models: Array<{ id: string; name: string }>; status: 'ready' | 'empty' | 'failed' }) => void
    const models = new Promise<{ models: Array<{ id: string; name: string }>; status: 'ready' | 'empty' | 'failed' }>((resolve) => { finish = resolve })
    provider.update.mockReturnValue(Promise.resolve([{ id: 'new-model', name: 'New' }]))
    provider.prepare.mockReturnValue(models)
    const controller = new AbortController()
    const commit = vi.fn()
    const pending = applyGatewayLoginTokens('new-key', { signal: controller.signal, onCommit: commit })
    // Preparation started and is pending → NOW the cancellation is mid-flight.
    await vi.waitFor(() => expect(provider.prepare).toHaveBeenCalledTimes(1))
    controller.abort()
    finish({ models: [{ id: 'new-model', name: 'New' }], status: 'ready' })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(settings.switchProviderAndModel).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it('selects the curated value default over catalog order', async () => {
    // The gateway lists deepseek-v4-pro FIRST; the curated default is
    // deepseek-v4.1-flash. The selected model must be the curated one, not
    // whichever model happens to be served first. (Fresh login: no existing
    // pins, so the curated default is seeded AND selected.)
    ;(settings as any).pinnedModelsByProvider = {}
    ;(settings as any).setPinnedModels = vi.fn()
    ;(settings as any).markPinnedModelsSeen = vi.fn()
    provider.update.mockResolvedValue([
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    ])
    provider.prepare.mockResolvedValue({
      models: [
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      ],
      status: 'ready',
    })
    await applyGatewayLoginTokens('new-key')
    expect(settings.switchProviderAndModel).toHaveBeenCalledWith(
      'llm-gateway',
      'deepseek-v4.1-flash',
    )
    // Fresh login: the curated default is seeded as favorites.
    expect((settings as any).setPinnedModels).toHaveBeenCalledWith('llm-gateway', [
      'deepseek-v4.1-flash',
    ])
  })

  it('selects the curated value default for a returning user without clobbering their pins', async () => {
    // Returning user: pins already exist ('old-model'). The SELECTION must
    // still use the curated default (deepseek-v4.1-flash) when it is served,
    // NOT discovery.models[0] (deepseek-v4-pro) — catalog order must not
    // decide again. The pin-SEEDING writes must be skipped so the user's own
    // favorites are preserved.
    provider.update.mockResolvedValue([
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    ])
    provider.prepare.mockResolvedValue({
      models: [
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      ],
      status: 'ready',
    })
    await applyGatewayLoginTokens('new-key')
    expect(settings.switchProviderAndModel).toHaveBeenCalledWith(
      'llm-gateway',
      'deepseek-v4.1-flash',
    )
    // Favorites preserved: seeding never fires for a returning user.
    expect((settings as any).setPinnedModels).not.toHaveBeenCalled()
    expect((settings as any).markPinnedModelsSeen).not.toHaveBeenCalled()
  })

  it('rejects before writing when cross-tab credential locking is unavailable', async () => {
    const realLocks = navigator.locks
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    try {
      await expect(applyGatewayLoginTokens('new-key')).rejects.toThrow(/Web Locks are required/)
    } finally {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: realLocks })
    }
  })

  it('commits with an empty model list when model discovery exceeds its deadline', async () => {
    // Sourcery: an approved login must not hang when the gateway accepts the
    // device-code approval but `/v1/models` never responds. Model discovery
    // is best-effort — the deadline converts a stalled endpoint into the
    // same "commit with an empty list" path as a plain network failure.
    vi.useFakeTimers()
    try {
      provider.prepare.mockReturnValue(new Promise<never>(() => {}))
      const pending = applyGatewayLoginTokens('new-key')
      // runAllTimersAsync (not a single advance): the commit path's
      // cross-tab quiescence barrier schedules its own setTimeout(0) polls
      // AFTER the deadline fired, and those need timer processing too.
      await vi.runAllTimersAsync()
      await expect(pending).resolves.toMatchObject({ ok: true, models: [] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts the hung discovery fetch when the deadline expires without a caller signal (no leaked request)', async () => {
    // Sourcery round 8, "Timed-out discovery keeps running": the deadline
    // used to reject only the RACE — with no caller-supplied signal (direct
    // login path) prepareGatewayModels kept awaiting the hung fetch forever
    // after the login had committed. The deadline must abort the discovery
    // itself so the inner request settles.
    vi.useFakeTimers()
    try {
      let discoverySettled = false
      provider.prepare.mockImplementation(
        (_token: string, signal?: AbortSignal) =>
          new Promise<{ models: Array<{ id: string; name: string }>; status: 'ready' | 'empty' | 'failed' }>(
            (_resolve, reject) => {
              if (!signal) throw new Error('expected an internal signal')
              signal.addEventListener('abort', () => {
                discoverySettled = true
                reject(signal.reason)
              })
            },
          ),
      )
      const pending = applyGatewayLoginTokens('new-key')
      await vi.waitFor(() => expect(provider.prepare).toHaveBeenCalledTimes(1))
      expect(discoverySettled).toBe(false)

      await vi.runAllTimersAsync()
      await expect(pending).resolves.toMatchObject({ ok: true, models: [] })
      // The inner discovery did NOT stay pending past the deadline: the
      // deadline aborted its signal and the fetch settled.
      expect(discoverySettled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT abort the caller-supplied signal when only the deadline expires', async () => {
    // The internal deadline abort must stay INTERNAL: an expired discovery
    // deadline means the login proceeds best-effort — the caller's signal
    // (a device-code login UI cancellation channel) must remain live so a
    // later explicit cancellation during the commit path still propagates.
    vi.useFakeTimers()
    try {
      const callerController = new AbortController()
      provider.prepare.mockImplementation(
        (_token: string, signal?: AbortSignal) =>
          new Promise<{ models: Array<{ id: string; name: string }>; status: 'ready' | 'empty' | 'failed' }>(
            (_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(signal.reason))
            },
          ),
      )
      const pending = applyGatewayLoginTokens('new-key', { signal: callerController.signal })
      await vi.waitFor(() => expect(provider.prepare).toHaveBeenCalledTimes(1))

      await vi.runAllTimersAsync()
      await expect(pending).resolves.toMatchObject({ ok: true, models: [] })
      expect(callerController.signal.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
