import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  saveApiKey: vi.fn(async () => undefined),
  registerDynamicProvider: vi.fn(),
  unregisterDynamicProvider: vi.fn(),
  checkHasApiKey: vi.fn(async () => true),
  invalidateApiKeyCache: vi.fn(),
  triggerProviderRefresh: vi.fn(),
  isWebBridgeAvailable: vi.fn(() => true),
}))

vi.mock('@/security/api-key-store', () => ({ saveApiKey: mocks.saveApiKey }))

vi.mock('@/agent/providers/types', () => ({
  registerDynamicProvider: mocks.registerDynamicProvider,
  unregisterDynamicProvider: mocks.unregisterDynamicProvider,
}))

vi.mock('@/agent/tools/web-bridge.tool', () => ({ isWebBridgeAvailable: mocks.isWebBridgeAvailable }))

// Pin the "latest known version" so version-comparison tests are deterministic
vi.mock('@/app-build', () => ({
  APP_BUILD_ID: 'test-build',
  APP_VERSION: '1.0.0',
  EXTENSION_LATEST_VERSION: '1.0.0',
  IS_DEVELOPMENT: true,
}))

vi.mock('@/store/settings.store', () => ({
  useSettingsStore: {
    getState: () => ({
      pinnedModelsByProvider: {},
      setPinnedModels: vi.fn(),
      markPinnedModelsSeen: vi.fn(),
      triggerProviderRefresh: mocks.triggerProviderRefresh,
      invalidateApiKeyCache: mocks.invalidateApiKeyCache,
      checkHasApiKey: mocks.checkHasApiKey,
    }),
  },
}))

import { CODEX_OAUTH_API_KEY, useExtensionStore as useExtensionStoreModule } from '../extension.store'
import {
  CHROME_WEB_STORE_EXTENSION_ID,
  EDGE_ADDONS_EXTENSION_ID,
  SELF_HOSTED_EXTENSION_ID,
  classifyExtensionDistribution,
} from '../../../browser-extension/extension-distribution'

describe('extension store', () => {
  // This describe does not touch the module-level backoff/mutex state, so the
  // static module instance is fine here (the round-4 describe re-imports a
  // fresh instance per test).
  const useExtensionStore = useExtensionStoreModule
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, '__agentWeb', {
      configurable: true,
      value: {
        codexGetStatus: vi.fn(async () => ({
          ok: true,
          data: { authorized: true, models: [{ id: 'gpt-5.4', name: 'GPT-5.4' }] },
        })),
      },
    })
    useExtensionStore.setState({ codexOAuthRegistered: false })
  })

  it('registers the live catalog models without rewriting their IDs', async () => {
    Object.defineProperty(window, '__agentWeb', {
      configurable: true,
      value: { codexGetStatus: vi.fn(async () => ({
        ok: true,
        data: { authorized: true, models: [
          { id: 'gpt-6-luna', name: 'GPT-6-Luna', contextWindow: 272000, capabilities: ['code', 'reasoning', 'vision'] },
          { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 272000, capabilities: ['code', 'reasoning', 'vision'] },
        ] },
      })) },
    })
    await useExtensionStore.getState().ensureCodexRegistered()
    const registered = mocks.registerDynamicProvider.mock.calls[0]
    expect(registered[2].models.map((model: { id: string }) => model.id)).toEqual(['gpt-6-luna', 'gpt-5.6-luna'])
    expect(registered[2].models[0].contextWindow).toBe(272000)
    expect(mocks.saveApiKey).toHaveBeenCalledWith('codex-oauth', CODEX_OAUTH_API_KEY)
  })

  it('does not register fabricated models when the catalog is unavailable', async () => {
    Object.defineProperty(window, '__agentWeb', {
      configurable: true,
      value: { codexGetStatus: vi.fn(async () => ({ ok: true, data: { authorized: true, models: [] } })) },
    })
    await useExtensionStore.getState().ensureCodexRegistered()
    expect(mocks.registerDynamicProvider).not.toHaveBeenCalled()
    expect(useExtensionStore.getState().codexOAuthRegistered).toBe(false)
  })

})

describe('extension distribution classification', () => {
  it('uses extension IDs for official and self-hosted channels', () => {
    expect(classifyExtensionDistribution(CHROME_WEB_STORE_EXTENSION_ID, 'normal')).toBe('chrome_web_store')
    expect(classifyExtensionDistribution(EDGE_ADDONS_EXTENSION_ID, 'normal')).toBe('edge_addons')
    expect(classifyExtensionDistribution(SELF_HOSTED_EXTENSION_ID, 'development')).toBe('development')
    expect(classifyExtensionDistribution(CHROME_WEB_STORE_EXTENSION_ID, 'admin')).toBe('enterprise')
  })

  it('falls back to installType without guessing an unknown store', () => {
    expect(classifyExtensionDistribution('unrecognized', 'sideload')).toBe('manual')
    expect(classifyExtensionDistribution('unrecognized', 'admin')).toBe('enterprise')
    expect(classifyExtensionDistribution('unrecognized', 'development')).toBe('development')
    expect(classifyExtensionDistribution('unrecognized', 'normal')).toBe('unknown')
  })
})

describe('extension version comparison', () => {
  // Like the round-4 describe below, use a fresh module instance so version
  // tests are independent of any backoff/mutex state left by other describes.
  let useExtensionStore: (typeof import('../extension.store'))['useExtensionStore']
  beforeEach(async () => {
    ;({ useExtensionStore } = await import('../extension.store'))
  })

  /** Stub the bridge with fixed metadata and run checkStatus. */
  async function checkWithVersion(
    version: string,
    metadata: Record<string, string> = { installType: 'sideload', distribution: 'manual' },
  ) {
    Object.defineProperty(window, '__agentWeb', {
      configurable: true,
      value: {
        codexGetStatus: vi.fn(async () => ({ ok: true, data: { authorized: false } })),
        getVersion: vi.fn(async () => ({ ok: true, version, ...metadata })),
      },
    })
    useExtensionStore.setState({
      codexOAuthRegistered: false,
      extensionVersion: null,
      extensionId: null,
      extensionInstallType: 'unknown',
      extensionDistribution: 'unknown',
      outdated: false,
      newerThanWeb: false,
    })

    useExtensionStore.getState().checkStatus()
    // fetchInstalledVersion is fire-and-forget async
    await vi.waitFor(() => {
      expect(useExtensionStore.getState().extensionVersion).toBe(version)
    })
  }

  it('flags a manual install outdated when it is older than the bundled ZIP', async () => {
    await checkWithVersion('0.9.0')
    const s = useExtensionStore.getState()
    expect(s.outdated).toBe(true)
    expect(s.newerThanWeb).toBe(false)
  })

  it('does not treat legacy version-only responses as a proven update channel', async () => {
    await checkWithVersion('0.9.0', {})
    const s = useExtensionStore.getState()
    expect(s.extensionVersion).toBe('0.9.0')
    expect(s.extensionDistribution).toBe('unknown')
    expect(s.outdated).toBe(false)
  })

  it.each(['chrome_web_store', 'edge_addons'])('does not compare %s with the bundled ZIP version', async (distribution) => {
    await checkWithVersion('0.9.0', { installType: 'normal', distribution })
    expect(useExtensionStore.getState().outdated).toBe(false)
  })

  it('flags neither when the installed version equals latest', async () => {
    await checkWithVersion('1.0.0')
    const s = useExtensionStore.getState()
    expect(s.outdated).toBe(false)
    expect(s.newerThanWeb).toBe(false)
  })

  it('flags newerThanWeb when the installed version is newer than latest', async () => {
    await checkWithVersion('1.2.0')
    const s = useExtensionStore.getState()
    expect(s.outdated).toBe(false)
    expect(s.newerThanWeb).toBe(true)
  })

  it('never flags newerThanWeb while latest is the 0.0.0 dev sentinel', async () => {
    // The web app reports 0.0.0 when NEXT_PUBLIC_EXTENSION_LATEST_VERSION is
    // unset. Even comparable manual installs must not be compared with it.
    vi.resetModules()
    vi.doMock('@/app-build', () => ({
      APP_BUILD_ID: 'test-build',
      APP_VERSION: '1.0.0',
      EXTENSION_LATEST_VERSION: '0.0.0',
      IS_DEVELOPMENT: true,
    }))
    try {
      const { useExtensionStore: freshStore } = await import('../extension.store')
      Object.defineProperty(window, '__agentWeb', {
        configurable: true,
        value: {
          codexGetStatus: vi.fn(async () => ({ ok: true, data: { authorized: false } })),
          getVersion: vi.fn(async () => ({
            ok: true,
            version: '9.9.9',
            installType: 'sideload',
            distribution: 'manual',
          })),
        },
      })

      freshStore.getState().checkStatus()
      await vi.waitFor(() => {
        expect(freshStore.getState().extensionVersion).toBe('9.9.9')
      })
      expect(freshStore.getState().newerThanWeb).toBe(false)
      expect(freshStore.getState().outdated).toBe(false)
    } finally {
      vi.doUnmock('@/app-build')
      vi.resetModules()
    }
  })

  it('deduplicates overlapping metadata queries', async () => {
    let resolveVersion!: (value: { ok: true; version: string; installType: string; distribution: string }) => void
    const getVersion = vi.fn(() => new Promise((resolve) => { resolveVersion = resolve }))
    Object.defineProperty(window, '__agentWeb', {
      configurable: true,
      value: {
        codexGetStatus: vi.fn(async () => ({ ok: true, data: { authorized: false } })),
        getVersion,
      },
    })
    useExtensionStore.setState({ extensionVersion: null })

    useExtensionStore.getState().checkStatus()
    useExtensionStore.getState().checkStatus()
    expect(getVersion).toHaveBeenCalledTimes(1)

    resolveVersion({ ok: true, version: '1.0.0', installType: 'sideload', distribution: 'manual' })
    await vi.waitFor(() => {
      expect(useExtensionStore.getState().extensionVersion).toBe('1.0.0')
    })
    expect(getVersion).toHaveBeenCalledTimes(1)
  })
})

describe('extension store: stale registration invalidation (round 4)', () => {
  // The codex module holds module-level mutex/backoff state. `vi.resetModules`
  // alone is NOT enough (the file's top-level static import keeps the original
  // instance alive), so re-import a FRESH module instance per test — a
  // backoff armed by one test must not silence the next one.
  let useExtensionStore: (typeof import('../extension.store'))['useExtensionStore']
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.isWebBridgeAvailable.mockReturnValue(true)
    ;({ useExtensionStore } = await import('../extension.store'))
  })
  // ── Sourcery round 4: a wedged bridge must not stall registration forever ──
  // ── Sourcery round 5: the retry after a timeout must actually be exercised ──
  it('settles registration when the codexGetStatus bridge request hangs, then retries and registers on a fresh status request', async () => {
    vi.useFakeTimers()
    try {
      const statusFn = vi.fn(() => new Promise(() => {})) // never resolves
      Object.defineProperty(window, '__agentWeb', {
        configurable: true,
        value: { codexGetStatus: statusFn },
      })
      useExtensionStore.setState({ codexOAuthRegistered: false })
      const pending = useExtensionStore.getState().ensureCodexRegistered()
      // Advance past the 12s status timeout — the wedged bridge request is
      // abandoned and registration settles (registry untouched), so the
      // shared in-flight promise cannot be reused as a stuck promise.
      await vi.advanceTimersByTimeAsync(13_000)
      await pending
      expect(mocks.registerDynamicProvider).not.toHaveBeenCalled()
      expect(useExtensionStore.getState().codexOAuthRegistered).toBe(false)

      // (Sourcery round 5) The bridge recovers: calling ensureCodexRegistered
      // again must issue a FRESH status request (not reuse a stale resolved
      // promise) and successfully register the provider.
      statusFn.mockImplementation(async () => ({
        ok: true,
        data: { authorized: true, models: [{ id: 'gpt-5.4', name: 'GPT-5.4' }] },
      }))
      // The first timeout armed the 5s backoff — advance past it.
      await vi.advanceTimersByTimeAsync(5_000)
      await useExtensionStore.getState().ensureCodexRegistered()
      expect(statusFn.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(mocks.registerDynamicProvider).toHaveBeenCalledTimes(1)
      expect(useExtensionStore.getState().codexOAuthRegistered).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // ── Sourcery round 5, finding 3: consecutive timeouts back off ──
  it('backs off status queries after consecutive timeouts and recovers on success', async () => {
    vi.useFakeTimers()
    try {
      const statusFn = vi.fn(() => new Promise(() => {})) // never resolves
      Object.defineProperty(window, '__agentWeb', {
        configurable: true,
        value: { codexGetStatus: statusFn },
      })
      useExtensionStore.setState({ codexOAuthRegistered: false })

      // Timeout #1 (at ~12s) arms a 5s backoff. Never `await` the ensure while
      // its status request can only settle via fake timers — advance first.
      const first = useExtensionStore.getState().ensureCodexRegistered()
      await vi.advanceTimersByTimeAsync(13_000)
      await first
      expect(statusFn.mock.calls.length).toBe(1)

      // Within the backoff window the next tick must NOT issue a request.
      await useExtensionStore.getState().ensureCodexRegistered()
      expect(statusFn.mock.calls.length).toBe(1)

      // Past the 5s backoff the query runs again → timeout #2 arms 10s.
      await vi.advanceTimersByTimeAsync(5_000)
      const second = useExtensionStore.getState().ensureCodexRegistered()
      await vi.advanceTimersByTimeAsync(13_000)
      await second
      expect(statusFn.mock.calls.length).toBe(2)
      await useExtensionStore.getState().ensureCodexRegistered()
      expect(statusFn.mock.calls.length).toBe(2) // still backed off (10s)

      // Bridge recovers: after the backoff elapses the request succeeds and
      // the provider registers (backoff fully reset by the success).
      statusFn.mockImplementation(async () => ({
        ok: true,
        data: { authorized: true, models: [{ id: 'gpt-5.4', name: 'GPT-5.4' }] },
      }))
      await vi.advanceTimersByTimeAsync(10_000)
      await useExtensionStore.getState().ensureCodexRegistered()
      expect(statusFn.mock.calls.length).toBe(3)
      expect(mocks.registerDynamicProvider).toHaveBeenCalledTimes(1)
      expect(useExtensionStore.getState().codexOAuthRegistered).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // ── Sourcery round 5, finding 1: a registered provider is re-checked and ──
  // ── unregistered as soon as the OAuth grant is revoked ──
  it('unregisters a registered codex provider when its OAuth authorization is revoked', async () => {
    mocks.unregisterDynamicProvider.mockClear()
    // First: register normally.
    Object.defineProperty(window, '__agentWeb', {
      configurable: true,
      value: { codexGetStatus: vi.fn(async () => ({
        ok: true,
        data: { authorized: true, models: [{ id: 'gpt-5.4', name: 'GPT-5.4' }] },
      })) },
    })
    useExtensionStore.setState({ codexOAuthRegistered: false })
    await useExtensionStore.getState().ensureCodexRegistered()
    expect(useExtensionStore.getState().codexOAuthRegistered).toBe(true)
    expect(mocks.registerDynamicProvider).toHaveBeenCalledTimes(1)

    // Then: the user revokes the OAuth grant — the next tick must unregister.
    Object.defineProperty(window, '__agentWeb', {
      configurable: true,
      value: { codexGetStatus: vi.fn(async () => ({
        ok: true,
        data: { authorized: false },
      })) },
    })
    await useExtensionStore.getState().ensureCodexRegistered()
    expect(mocks.unregisterDynamicProvider).toHaveBeenCalledWith('codex-oauth')
    expect(useExtensionStore.getState().codexOAuthRegistered).toBe(false)

    // checkHasApiKey was flushed so the UI does not sit in loading state.
    expect(mocks.checkHasApiKey).toHaveBeenCalledWith({ flush: true })
  })

  it('keeps the registration when the periodic re-check times out (extension may just be wedged)', async () => {
    vi.useFakeTimers()
    try {
      // Register with an immediate authorized response.
      const statusFn = vi.fn(async () => ({
        ok: true,
        data: { authorized: true, models: [{ id: 'gpt-5.4', name: 'GPT-5.4' }] },
      }))
      Object.defineProperty(window, '__agentWeb', {
        configurable: true,
        value: { codexGetStatus: statusFn },
      })
      useExtensionStore.setState({ codexOAuthRegistered: false })
      await useExtensionStore.getState().ensureCodexRegistered()
      expect(useExtensionStore.getState().codexOAuthRegistered).toBe(true)

      // Wedged bridge on the next tick: the periodic re-check MUST actually
      // issue a second status request (an implementation that skips the
      // query for registered providers would otherwise pass silently).
      statusFn.mockImplementation(() => new Promise(() => {}))
      const pending = useExtensionStore.getState().ensureCodexRegistered()
      await vi.waitFor(() => expect(statusFn).toHaveBeenCalledTimes(2))
      await vi.advanceTimersByTimeAsync(12_000)
      await pending
      expect(useExtensionStore.getState().codexOAuthRegistered).toBe(true)
      expect(mocks.unregisterDynamicProvider).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not register a stale provider when the extension disappears before the status round-trip completes', async () => {
    // Flip availability only AFTER the status request is in flight, so an
    // implementation that moved the availability check ahead of the await
    // (and dropped the post-await check) still fails this test.
    let flipAvailability: () => void = () => {}
    const availabilityGate = new Promise<void>((resolve) => { flipAvailability = resolve })
    const statusFn = vi.fn(async () => {
      await availabilityGate
      return {
        ok: true,
        data: { authorized: true, models: [{ id: 'gpt-5.4', name: 'GPT-5.4' }] },
      }
    })
    Object.defineProperty(window, '__agentWeb', {
      configurable: true,
      value: { codexGetStatus: statusFn },
    })
    useExtensionStore.setState({ codexOAuthRegistered: false })

    const pending = useExtensionStore.getState().ensureCodexRegistered()
    // The status request has been issued (and is parked in its gate) — NOW
    // the extension bridge disappears.
    await vi.waitFor(() => expect(statusFn).toHaveBeenCalledTimes(1))
    expect(mocks.registerDynamicProvider).not.toHaveBeenCalled()
    mocks.isWebBridgeAvailable.mockReturnValue(false)
    flipAvailability()

    await pending
    expect(mocks.registerDynamicProvider).not.toHaveBeenCalled()
    expect(useExtensionStore.getState().codexOAuthRegistered).toBe(false)
  })
})
