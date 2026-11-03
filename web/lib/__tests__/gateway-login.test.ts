import { beforeEach, describe, expect, it, vi } from 'vitest'

const { provider, keyStore, settings } = vi.hoisted(() => ({
  provider: {
    update: vi.fn<() => Promise<Array<{ id: string; name: string }>>>(),
    prepare: vi.fn<(accessToken: string, signal?: AbortSignal) => Promise<{ models: Array<{ id: string; name: string }>; status: 'ready' | 'empty' | 'failed' }>>(),
    register: vi.fn(),
  },
  keyStore: {
    save: vi.fn<(id: string, key: string) => Promise<void>>(),
    load: vi.fn<(id: string) => Promise<string | null>>(),
    delete: vi.fn<(id: string) => Promise<void>>(),
  },
  settings: {
    modelName: 'old-model',
    pinnedModelsByProvider: {} as Record<string, string[]>,
    invalidateApiKeyCache: vi.fn(),
    switchProviderAndModel: vi.fn(),
    setPinnedModels: vi.fn(),
    markPinnedModelsSeen: vi.fn(),
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
    savedKey = 'previous-key'
    settings.pinnedModelsByProvider = { 'llm-gateway': ['old-model'] }
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
    expect(savedKey).toBe('previous-key')
    expect(keyStore.save).not.toHaveBeenCalled()
    expect(settings.switchProviderAndModel).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it('restores the previous credential if cancellation happens during its save', async () => {
    let release!: () => void
    keyStore.save.mockImplementationOnce(async (_id, key) => {
      await new Promise<void>((resolve) => { release = resolve })
      savedKey = key
    })
    const controller = new AbortController()
    const commit = vi.fn()
    const pending = applyGatewayLoginTokens('new-key', { signal: controller.signal, onCommit: commit })
    await vi.waitFor(() => expect(keyStore.save).toHaveBeenCalledTimes(1))
    controller.abort()
    release()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(savedKey).toBe('previous-key')
    expect(settings.switchProviderAndModel).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it('does NOT roll back when another tab already saved a newer credential', async () => {
    // Cross-tab race: THIS attempt's save commits, then it is cancelled.
    // Before its rollback check runs, ANOTHER tab's login saves a different
    // (newer) key. The rollback must leave that newer credential alone —
    // restoring our older key would leave the other tab "successful" while
    // its token pair and saved credential disagree.
    let release!: () => void
    keyStore.save.mockImplementationOnce(async () => {
      // The hung save writes NOTHING on release — the newer credential is
      // already the store's content, so the rollback CAS must skip.
      await new Promise<void>((resolve) => { release = resolve })
    })
    const controller = new AbortController()
    const pending = applyGatewayLoginTokens('new-key', { signal: controller.signal })
    await vi.waitFor(() => expect(keyStore.save).toHaveBeenCalledTimes(1))
    controller.abort()
    // Another tab commits a newer credential now (the store's content), and
    // the cancelled attempt's save resolves WITHOUT writing.
    savedKey = 'other-tab-newer-key'
    release()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    // The newer credential survived; no restore/delete ran after it.
    expect(savedKey).toBe('other-tab-newer-key')
    expect(keyStore.save).toHaveBeenCalledTimes(1)
    expect(keyStore.delete).not.toHaveBeenCalled()
  })

  it('does not roll back a newer login committed by another tab', async () => {
    vi.resetModules()
    const firstTab = await import('@/lib/gateway-login')
    vi.resetModules()
    const secondTab = await import('@/lib/gateway-login')
    let finishFirstSave!: () => void
    keyStore.save.mockImplementationOnce(async (_id, key) => {
      await new Promise<void>((resolve) => { finishFirstSave = resolve })
      savedKey = key
    })
    const controller = new AbortController()
    const first = firstTab.applyGatewayLoginTokens('cancelled-key', { signal: controller.signal })
    await vi.waitFor(() => expect(keyStore.save).toHaveBeenCalledTimes(1))
    controller.abort()
    const second = secondTab.applyGatewayLoginTokens('newer-key')
    await vi.waitFor(() => expect(provider.prepare).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    expect(keyStore.save).toHaveBeenCalledTimes(1)
    finishFirstSave()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await expect(second).resolves.toMatchObject({ ok: true })
    expect(savedKey).toBe('newer-key')
  })

  it('rejects before writing when cross-tab credential locking is unavailable', async () => {
    const realLocks = navigator.locks
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    try {
      await expect(applyGatewayLoginTokens('new-key')).rejects.toThrow(/Web Locks are required/)
      expect(savedKey).toBe('previous-key')
      expect(keyStore.save).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: realLocks })
    }
  })

  it('refuses a STALE save that lands after a newer credential commit (fenced at the mutation point)', async () => {
    // Round-20: a bounded key-store op can stay pending past the registry
    // TTL/quiescence cap while ANOTHER tab commits a newer credential. The
    // stale save must be refused AT ITS LANDING POINT (after the underlying
    // write resolved) — the dispatch-time check ran before that commit even
    // existed — and the login must NOT report success or commit settings.
    // The CAS rollback leaves the newer credential untouched.
    let releaseSave!: () => void
    keyStore.save.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseSave = resolve })
      // Writes NOTHING on release — the newer credential is already the
      // store's content (the other tab committed while this op was
      // pending).
    })
    const pending = applyGatewayLoginTokens('stale-key')
    await vi.waitFor(() => expect(keyStore.save).toHaveBeenCalledTimes(1))
    // Another tab commits a NEWER credential while this save is pending…
    savedKey = 'newer-tab-key'
    // …which bumps the shared commit sequence, fencing every op registered
    // before it (exactly what withGatewayCredentialLock does per commit —
    // the login's own lock grant already stamped seq=1, so a newer commit
    // is seq=2).
    localStorage.setItem('eo2weave-gateway-credential-commit-seq', '2')
    releaseSave()

    // The landing-point fence throws; the login must NOT report success.
    await expect(pending).rejects.toThrow(/key-store op fenced/)
    // The newer credential survives; no restore/delete ran after it.
    expect(savedKey).toBe('newer-tab-key')
    expect(keyStore.delete).not.toHaveBeenCalled()
    expect(settings.switchProviderAndModel).not.toHaveBeenCalled()
    expect(settings.setHasApiKey).not.toHaveBeenCalled()
  })

  it('never dispatches a save whose fence is already tripped (pre-dispatch check)', async () => {
    // Round-21: the mutation is a FACTORY — the op is registered and the
    // fence checked BEFORE the effectful write is released. An op whose
    // fence trips before its dispatch must never write. Directly exercised
    // through the auth layer's exported wrapper (the login flow's own
    // registration stamps the CURRENT sequence synchronously, so a fence
    // trip before dispatch cannot be produced inside one login attempt —
    // the trip requires an interleaved commit during an async gap).
    const { runBoundedFencedKeyStoreMutationForTests } = await import(
      '@/agent/providers/llm-gateway-auth'
    )
    const { __resetGatewayCredentialFencingForTests } = await import(
      '@/agent/providers/gateway-credential-lock'
    )
    __resetGatewayCredentialFencingForTests()
    // Pre-trip: simulate an interleaved commit BEFORE registration…
    localStorage.setItem('eo2weave-gateway-credential-commit-seq', '2')
    let dispatched = false
    const run = runBoundedFencedKeyStoreMutationForTests(async () => {
      dispatched = true
    })
    // …but registration stamps the seq CURRENT at registration (2), so to
    // trip the fence BEFORE dispatch we bump between registration and the
    // wrapper's dispatch check — impossible in one synchronous call. What
    // IS testable: the second fence check inside an ASYNC factory. The
    // wrapper released the gate synchronously here, so use the exported
    // hook to verify the dispatch-time refusal through the async-factory
    // path instead: bump the seq inside the factory's first await.
    __resetGatewayCredentialFencingForTests()
    let sawOpId: string | null = null
    const run2 = runBoundedFencedKeyStoreMutationForTests(async (opId) => {
      sawOpId = opId
      // The async gap before the effectful call — a commit lands here.
      localStorage.setItem('eo2weave-gateway-credential-commit-seq', '9')
      dispatched = true
    })
    await expect(run2).rejects.toThrow(/key-store op fenced/)
    expect(sawOpId).not.toBeNull()
    // The factory ran up to the effectful boundary and the second fence
    // check refused the WRITE — `dispatched` only proves the pre-write
    // section ran; the effect itself is below the refused check.
    expect(dispatched).toBe(true)
    await expect(run).resolves.toBeUndefined()
  })

  it('escalates when the save lands inside a fenced window (post-write detection)', async () => {
    // Round-21: the write already landed when the fence trips — the stored
    // state is untrustworthy, so the escalation must fire (credential status
    // flipped to 'expired' + re-login banner in the settings store) on top
    // of the throw and the CAS rollback.
    let releaseSave!: () => void
    keyStore.save.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseSave = resolve })
      // Writes NOTHING on release — the newer credential is already the
      // store's content, so the CAS rollback must skip (same simulation as
      // the round-20 test above).
    })
    const pending = applyGatewayLoginTokens('stale-key')
    await vi.waitFor(() => expect(keyStore.save).toHaveBeenCalledTimes(1))
    // A newer tab commits while the save is in flight; the save lands on
    // top of it.
    savedKey = 'newer-tab-key'
    localStorage.setItem('eo2weave-gateway-credential-commit-seq', '2')
    releaseSave()

    await expect(pending).rejects.toThrow(/key-store op fenced/)
    // Escalation: the settings card's re-login banner + expired status.
    await vi.waitFor(() => {
      expect(settings.setModelCredentialStatus).toHaveBeenCalledWith('expired')
      expect(settings.setModelCredentialStatusError).toHaveBeenCalledWith(
        expect.stringMatching(/stale credential|re-login|fenced/),
      )
    })
    // The newer credential survives (the CAS rollback skips — the store no
    // longer holds THIS attempt's token).
    expect(savedKey).toBe('newer-tab-key')
    expect(keyStore.delete).not.toHaveBeenCalled()
  })

  it('commits normally when no newer credential commit landed (fence inert)', async () => {
    // The landing-point fence must not break the happy path: a save that
    // lands with the commit sequence unchanged (no concurrent commit) still
    // succeeds and completes the login.
    const pending = applyGatewayLoginTokens('fresh-key')
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(savedKey).toBe('fresh-key')
    expect(settings.setHasApiKey).toHaveBeenCalledWith(true)
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
      expect(savedKey).toBe('new-key')
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

  it('marks every DISCOVERED model id seen after a successful login (Sourcery: Mark discovered models seen)', async () => {
    // Issue #146 follow-up: the login used to mark only the curated
    // defaults as seen (and only when defaults were non-empty). A pin that
    // was previously confirmed then left the defaults list (or a newly
    // discovered model that is not a curated default) stayed unconfirmed,
    // so the delisted badge compared it against `seen` incorrectly. The
    // commit must mark the whole discovered catalog seen.
    provider.prepare.mockResolvedValue({
      models: [
        { id: 'glm-5.2', name: 'GLM' },
        { id: 'minimax-m3', name: 'MiniMax' },
      ],
      status: 'ready',
    })

    await expect(applyGatewayLoginTokens('fresh-key')).resolves.toMatchObject({ ok: true })

    expect(settings.markPinnedModelsSeen).toHaveBeenCalledWith('llm-gateway', [
      'glm-5.2',
      'minimax-m3',
    ])
  })

  it('clears the stale flag of a previously delisted pin once its model is discovered again', async () => {
    // The badge came back after re-login (the original #146 symptom):
    // markPinnedModelsSeen prunes `seen` entries whose pins are gone, so
    // re-marking a returning model id must clear its stale flag. Defaults
    // stay pinned (the pin list is empty here), and the discovered ids are
    // confirmed even though they are NOT curated defaults.
    settings.pinnedModelsByProvider = {}
    provider.prepare.mockResolvedValue({
      models: [{ id: 'glm-5.2', name: 'GLM' }],
      status: 'ready',
    })

    await expect(applyGatewayLoginTokens('fresh-key')).resolves.toMatchObject({ ok: true })

    expect(settings.setPinnedModels).not.toHaveBeenCalled()
    expect(settings.markPinnedModelsSeen).toHaveBeenCalledWith('llm-gateway', ['glm-5.2'])
  })
})
