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

let credentialStatus: CredentialStatus = 'unknown'

vi.mock('@/agent/providers/llm-gateway-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/providers/llm-gateway-auth')>()
  return {
    ...actual,
    getGatewayCredentialStatus: () => credentialStatus,
  }
})

const loadApiKeyMock = vi.fn<(providerKey?: string) => Promise<string | null>>()

vi.mock('@/security/api-key-store', () => ({
  loadApiKey: (providerKey?: string) => loadApiKeyMock(providerKey),
  saveApiKey: () => undefined,
  deleteApiKey: () => undefined,
}))

async function setup(status: CredentialStatus) {
  credentialStatus = status
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
  return useSettingsStore
}

describe('gateway availability source (#277)', () => {
  beforeEach(() => {
    localStorage.clear()
    credentialStatus = 'unknown'
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

  it('allows the session resolver to retry an unknown verdict after switching providers', async () => {
    const store = await setup('unknown')
    store.setState({ hasApiKey: false, hasApiKeyLoaded: true })
    expect(await store.getState().checkHasApiKey()).toBe(true)
    expect(store.getState().hasApiKey).toBe(true)
    expect(store.getState().hasApiKeyLoaded).toBe(true)
  })

  it('allows a configured gateway with an unknown verdict to retry after a flush', async () => {
    const store = await setup('unknown')
    expect(await store.getState().checkHasApiKey({ flush: true })).toBe(true)
    expect(store.getState().hasApiKeyLoaded).toBe(true)
  })

})
