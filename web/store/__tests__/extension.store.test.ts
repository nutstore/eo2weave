import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  saveApiKey: vi.fn(async () => undefined),
  registerDynamicProvider: vi.fn(),
  unregisterDynamicProvider: vi.fn(),
  checkHasApiKey: vi.fn(async () => true),
  invalidateApiKeyCache: vi.fn(),
  triggerProviderRefresh: vi.fn(),
}))

vi.mock('@/security/api-key-store', () => ({ saveApiKey: mocks.saveApiKey }))

vi.mock('@/agent/providers/types', () => ({
  registerDynamicProvider: mocks.registerDynamicProvider,
  unregisterDynamicProvider: mocks.unregisterDynamicProvider,
}))

vi.mock('@/agent/tools/web-bridge.tool', () => ({ isWebBridgeAvailable: () => true }))

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
      triggerProviderRefresh: mocks.triggerProviderRefresh,
      invalidateApiKeyCache: mocks.invalidateApiKeyCache,
      checkHasApiKey: mocks.checkHasApiKey,
    }),
  },
}))

import { CODEX_OAUTH_API_KEY, useExtensionStore } from '../extension.store'

describe('extension store', () => {
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

  it('saves the Codex OAuth virtual key through the initialized key store', async () => {
    await useExtensionStore.getState().ensureCodexRegistered()

    expect(mocks.saveApiKey).toHaveBeenCalledWith('codex-oauth', CODEX_OAUTH_API_KEY)
  })
})

describe('extension version comparison', () => {
  /** Stub the bridge with a fixed reported version and run checkStatus. */
  async function checkWithVersion(version: string) {
    Object.defineProperty(window, '__agentWeb', {
      configurable: true,
      value: {
        codexGetStatus: vi.fn(async () => ({ ok: true, data: { authorized: false } })),
        getVersion: vi.fn(async () => ({ ok: true, version })),
      },
    })
    useExtensionStore.setState({
      codexOAuthRegistered: false,
      extensionVersion: null,
      outdated: false,
      newerThanWeb: false,
    })

    useExtensionStore.getState().checkStatus()
    // fetchInstalledVersion is fire-and-forget async
    await vi.waitFor(() => {
      expect(useExtensionStore.getState().extensionVersion).toBe(version)
    })
  }

  it('flags outdated when the installed version is older than latest', async () => {
    await checkWithVersion('0.9.0')
    const s = useExtensionStore.getState()
    expect(s.outdated).toBe(true)
    expect(s.newerThanWeb).toBe(false)
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
    // unset (dev builds). A store-installed extension is always newer than
    // that — treating it as "newer than web" would show the banner forever.
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
          getVersion: vi.fn(async () => ({ ok: true, version: '9.9.9' })),
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
})
