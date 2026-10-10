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
      markPinnedModelsSeen: vi.fn(),
      triggerProviderRefresh: mocks.triggerProviderRefresh,
      invalidateApiKeyCache: mocks.invalidateApiKeyCache,
      checkHasApiKey: mocks.checkHasApiKey,
    }),
  },
}))

import { CODEX_OAUTH_API_KEY, useExtensionStore } from '../extension.store'
import {
  CHROME_WEB_STORE_EXTENSION_ID,
  EDGE_ADDONS_EXTENSION_ID,
  SELF_HOSTED_EXTENSION_ID,
  classifyExtensionDistribution,
} from '../../../browser-extension/extension-distribution'

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
