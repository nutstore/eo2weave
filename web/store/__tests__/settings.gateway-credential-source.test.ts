/**
 * Gateway availability must come from the authoritative session (#277).
 *
 * `checkHasApiKey()` used to read the api-key-store shadow
 * (`__llm_gateway_token__`) for llm-gateway. That shadow is a best-effort
 * durability copy written by login / refresh / boot restore — a failed write
 * leaves it missing while the session is perfectly valid, and the send gate
 * then rejected with "configure your API Key" for a logged-in user.
 *
 * The verdict now comes from `getGatewayCredentialStatus()`, the synchronous
 * state the dispatch resolver maintains. These cases pin the mapping and the
 * "never consult the shadow" contract.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

type CredentialStatus = 'unknown' | 'valid' | 'expired' | 'missing'

const loadApiKeyMock = vi.fn<(providerKey?: string) => Promise<string | null>>()

vi.mock('@/security/api-key-store', () => ({
  loadApiKey: (providerKey?: string) => loadApiKeyMock(providerKey),
  saveApiKey: () => undefined,
  deleteApiKey: () => undefined,
}))

async function setup(status: CredentialStatus) {
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
  const { useSettingsStore } = await import('@/store/settings.store')
  useSettingsStore.setState({
    providerType: 'llm-gateway',
    modelName: 'gw-model',
    hasApiKey: false,
    hasApiKeyLoaded: false,
  })
  const { credentialRegistry } = await import('@/agent/providers/credential-state')
  credentialRegistry.commit('__llm_gateway_token__', { kind: status })
  return useSettingsStore
}

describe('gateway availability source (#277)', () => {
  beforeEach(() => {
    localStorage.clear()
    loadApiKeyMock.mockReset()
    loadApiKeyMock.mockResolvedValue(null) // no shadow at all
    vi.resetModules()
  })

  it('treats a valid session as available even without the api-key shadow', async () => {
    const store = await setup('valid')

    expect(await store.getState().checkHasApiKey()).toBe(true)
    const state = store.getState()
    expect(state.hasApiKey).toBe(true)
    expect(state.hasApiKeyLoaded).toBe(true)
    // The shadow must not be consulted at all.
    expect(loadApiKeyMock).not.toHaveBeenCalled()
  })

  it('reports a definitively absent session as "no key"', async () => {
    const store = await setup('missing')

    expect(await store.getState().checkHasApiKey()).toBe(false)
    expect(store.getState().hasApiKey).toBe(false)
    expect(store.getState().hasApiKeyLoaded).toBe(true)
    expect(loadApiKeyMock).not.toHaveBeenCalled()
  })

  it('reports an expired session as unavailable without claiming "no key"', async () => {
    const store = await setup('expired')

    expect(await store.getState().checkHasApiKey()).toBe(false)
    expect(store.getState().hasApiKey).toBe(false)
    expect(store.getState().hasApiKeyLoaded).toBe(true)
  })

  it('finishes checking after switching to an unknown gateway without claiming a credential', async () => {
    const store = await setup('unknown')
    store.setState({ providerType: 'openai', hasApiKey: true, hasApiKeyLoaded: true })
    store.getState().switchProviderAndModel('llm-gateway', 'gw-model')
    expect(await store.getState().checkHasApiKey()).toBe(false)
    expect(store.getState().hasApiKey).toBe(false)
    expect(store.getState().hasApiKeyLoaded).toBe(true)
  })

  it('finishes a flush without reporting an unknown session as configured', async () => {
    const store = await setup('unknown')
    expect(await store.getState().checkHasApiKey({ flush: true })).toBe(false)
    expect(store.getState().hasApiKey).toBe(false)
    expect(store.getState().hasApiKeyLoaded).toBe(true)
  })

  it('updates the selected gateway availability after the session resolves', async () => {
    const store = await setup('unknown')
    store.setState({ hasApiKey: false, hasApiKeyLoaded: true })
    store.getState().setModelCredentialStatus('valid')
    expect(store.getState().hasApiKey).toBe(true)
    expect(store.getState().hasApiKeyLoaded).toBe(true)
    store.getState().setModelCredentialStatus('missing')
    expect(store.getState().hasApiKey).toBe(false)
  })

  it('does not change another provider key when the gateway session changes', async () => {
    const store = await setup('unknown')
    store.setState({ providerType: 'openai' })
    store.getState().setHasApiKey(true)
    store.getState().setModelCredentialStatus('missing')
    expect(store.getState().hasApiKey).toBe(true)
  })

  it('does not re-enter loading when an unknown verdict follows a flush', async () => {
    const store = await setup('unknown')
    await store.getState().checkHasApiKey({ flush: true })
    await store.getState().checkHasApiKey()
    expect(store.getState().hasApiKeyLoaded).toBe(true)
    expect(store.getState().hasApiKey).toBe(false)
  })

})
