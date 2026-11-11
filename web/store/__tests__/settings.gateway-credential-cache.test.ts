/**
 * Gateway credential cache invalidation on a provider switch (#277).
 *
 * `checkHasApiKey()` caches its verdict under the provider's CREDENTIAL key,
 * which is `__llm_gateway_token__` for llm-gateway — not the provider id.
 * `switchProviderAndModel()` used to invalidate only `newProviderType`, so a
 * cached "no key" from before the credential was restored survived switching
 * away and back: the send gate then kept rejecting with the API-key toast even
 * though the credential was readable again.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const GATEWAY_CREDENTIAL_KEY = '__llm_gateway_token__'

const loadApiKeyMock = vi.fn<(providerKey?: string) => Promise<string | null>>()

vi.mock('@/security/api-key-store', () => ({
  loadApiKey: (providerKey?: string) => loadApiKeyMock(providerKey),
  saveApiKey: () => undefined,
  deleteApiKey: () => undefined,
}))

async function importStore() {
  return import('@/store/settings.store')
}

async function registerGateway() {
  const { registerDynamicProvider } = await import('@/agent/providers/types')
  registerDynamicProvider(
    'llm-gateway',
    { baseURL: 'https://gateway.example/v1', modelName: 'gw-model', headers: {} },
    {
      category: 'custom',
      displayName: 'Nutstore AI',
      models: [{ id: 'gw-model', name: 'gw-model', capabilities: ['code'] }],
      catalogStatus: 'ready',
    },
  )
}

describe('gateway credential cache (#277)', () => {
  beforeEach(() => {
    localStorage.clear()
    loadApiKeyMock.mockReset()
    vi.resetModules()
  })

  it('re-reads the credential after switching away and back', async () => {
    await registerGateway()
    const { useSettingsStore } = await importStore()

    // The SQLite access shadow is missing: the verdict is "no key" and it is
    // cached under the gateway's credential key.
    loadApiKeyMock.mockResolvedValue(null)
    useSettingsStore.setState({
      providerType: 'llm-gateway',
      modelName: 'gw-model',
      hasApiKey: false,
      hasApiKeyLoaded: false,
    })
    expect(await useSettingsStore.getState().checkHasApiKey()).toBe(false)
    expect(useSettingsStore.getState().hasApiKey).toBe(false)
    expect(loadApiKeyMock).toHaveBeenCalledWith(GATEWAY_CREDENTIAL_KEY)

    // The shadow is readable again (login refreshed / the earlier write landed).
    loadApiKeyMock.mockImplementation(async (providerKey?: string) =>
      providerKey === GATEWAY_CREDENTIAL_KEY ? 'access-token-1' : 'sk-other',
    )
    loadApiKeyMock.mockClear()

    useSettingsStore.getState().switchProviderAndModel('openai', 'gpt-test')
    await vi.waitFor(() => expect(loadApiKeyMock).toHaveBeenCalledWith('openai'))
    await vi.waitFor(() => expect(useSettingsStore.getState().hasApiKey).toBe(true))

    useSettingsStore.getState().switchProviderAndModel('llm-gateway', 'gw-model')

    // The gateway must be re-read, not replayed from the pre-switch cache.
    await vi.waitFor(() => expect(loadApiKeyMock).toHaveBeenCalledWith(GATEWAY_CREDENTIAL_KEY))
    await vi.waitFor(() => expect(useSettingsStore.getState().hasApiKey).toBe(true))
  })

  it('re-reads the gateway credential when a workspace restore changes the provider', async () => {
    await registerGateway()
    const { useSettingsStore } = await importStore()

    // Gateway active with an unreadable shadow: the "no key" verdict is cached
    // under the gateway's credential key.
    loadApiKeyMock.mockResolvedValue(null)
    useSettingsStore.setState({
      providerType: 'llm-gateway',
      modelName: 'gw-model',
      hasApiKey: false,
      hasApiKeyLoaded: false,
      modelOverridesByWorkspace: {
        'conv-gateway': { providerType: 'llm-gateway', modelName: 'gw-model' },
      },
    })
    expect(await useSettingsStore.getState().checkHasApiKey()).toBe(false)

    // The shadow becomes readable while another provider is active.
    loadApiKeyMock.mockImplementation(async (providerKey?: string) =>
      providerKey === GATEWAY_CREDENTIAL_KEY ? 'access-token-1' : 'sk-openai',
    )
    useSettingsStore.getState().switchProviderAndModel('openai', 'gpt-test')
    await vi.waitFor(() => expect(useSettingsStore.getState().hasApiKey).toBe(true))
    loadApiKeyMock.mockClear()

    // Switching to a conversation pinned to the gateway changes the active
    // provider outside switchProviderAndModel — it must re-read too.
    useSettingsStore.getState().syncModelForWorkspace('conv-gateway')

    await vi.waitFor(() => expect(loadApiKeyMock).toHaveBeenCalledWith(GATEWAY_CREDENTIAL_KEY))
    await vi.waitFor(() => expect(useSettingsStore.getState().providerType).toBe('llm-gateway'))
  })

  it('does not re-read the gateway credential on a same-provider switch', async () => {
    await registerGateway()
    const { useSettingsStore } = await importStore()

    loadApiKeyMock.mockResolvedValue('sk-openai')
    useSettingsStore.setState({
      providerType: 'openai',
      modelName: 'gpt-test',
      hasApiKey: false,
      hasApiKeyLoaded: false,
    })
    expect(await useSettingsStore.getState().checkHasApiKey()).toBe(true)
    loadApiKeyMock.mockClear()

    // A same-provider switch re-reads once (it must reflect a key saved in
    // another tab), but it must not look up the gateway's credential.
    useSettingsStore.getState().switchProviderAndModel('openai', 'gpt-mini')
    await vi.waitFor(() => expect(loadApiKeyMock).toHaveBeenCalledTimes(1))
    expect(loadApiKeyMock.mock.calls.map(([providerKey]) => providerKey)).toEqual(['openai'])
  })
})
