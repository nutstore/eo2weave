/**
 * Gateway verdict refresh on a provider switch / workspace restore (#277).
 *
 * The gateway's availability now comes from `getGatewayCredentialStatus()`
 * (#277), so a provider switch or a workspace restore must RE-EVALUATE that
 * verdict instead of replaying one taken before the session changed. The old
 * failure mode was the same shape: a verdict captured while the credential was
 * unreadable survived the switch and the send gate kept refusing with
 * "configure your API Key".
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

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

describe('gateway verdict refresh (#277)', () => {
  beforeEach(() => {
    localStorage.clear()
    loadApiKeyMock.mockReset()
    loadApiKeyMock.mockResolvedValue('sk-openai')
    vi.resetModules()
  })

  it('re-evaluates the gateway verdict after switching away and back', async () => {
    await registerGateway()
    const { useSettingsStore } = await importStore()

    const { credentialRegistry } = await import('@/agent/providers/credential-state')
    credentialRegistry.commit('llm-gateway', { kind: 'missing' })
    useSettingsStore.setState({
      providerType: 'llm-gateway',
      modelName: 'gw-model',
      hasApiKey: false,
      hasApiKeyLoaded: false,
    })
    expect(await useSettingsStore.getState().checkHasApiKey()).toBe(false)
    expect(useSettingsStore.getState().hasApiKey).toBe(false)

    // The session becomes valid while another provider is active.
    credentialRegistry.commit('llm-gateway', { kind: 'valid' })
    useSettingsStore.getState().switchProviderAndModel('openai', 'gpt-test')
    await vi.waitFor(() => expect(useSettingsStore.getState().hasApiKey).toBe(true))

    useSettingsStore.getState().switchProviderAndModel('llm-gateway', 'gw-model')

    // The stale "no key" verdict must not be replayed: the switch re-reads the
    // authoritative status and lands on "available".
    await vi.waitFor(() => expect(useSettingsStore.getState().hasApiKey).toBe(true))
  })

  it('re-evaluates the gateway verdict when a workspace restore changes the provider', async () => {
    await registerGateway()
    const { useSettingsStore } = await importStore()

    const { credentialRegistry } = await import('@/agent/providers/credential-state')
    credentialRegistry.commit('llm-gateway', { kind: 'missing' })
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

    credentialRegistry.commit('llm-gateway', { kind: 'valid' })
    useSettingsStore.getState().switchProviderAndModel('openai', 'gpt-test')
    await vi.waitFor(() => expect(useSettingsStore.getState().hasApiKey).toBe(true))

    // Restoring a conversation pinned to the gateway changes the active
    // provider outside switchProviderAndModel — it must re-read as well.
    useSettingsStore.getState().syncModelForWorkspace('conv-gateway')

    await vi.waitFor(() => expect(useSettingsStore.getState().providerType).toBe('llm-gateway'))
    await vi.waitFor(() => expect(useSettingsStore.getState().hasApiKey).toBe(true))
  })

  it('does not consult the gateway status on a same-provider switch', async () => {
    await registerGateway()
    const { useSettingsStore } = await importStore()

    useSettingsStore.setState({
      providerType: 'openai',
      modelName: 'gpt-test',
      hasApiKey: false,
      hasApiKeyLoaded: false,
    })
    expect(await useSettingsStore.getState().checkHasApiKey()).toBe(true)
    const { credentialRegistry } = await import('@/agent/providers/credential-state')
    const revisionBefore = credentialRegistry.getRevision('llm-gateway')

    useSettingsStore.getState().switchProviderAndModel('openai', 'gpt-mini')

    await vi.waitFor(() => expect(loadApiKeyMock).toHaveBeenCalledWith('openai'))
    expect(credentialRegistry.getRevision('llm-gateway')).toBe(revisionBefore)
  })
})
