import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadKey = vi.hoisted(() => vi.fn<(key: string) => Promise<string | null>>())
vi.mock('@/security/api-key-store', () => ({ loadApiKey: loadKey }))

async function setup() {
  const { credentialRegistry } = await import('@/agent/providers/credential-state')
  const { useSettingsStore } = await import('@/store/settings.store')
  return { credentialRegistry, useSettingsStore }
}

describe('credential registry projection', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
    loadKey.mockReset().mockResolvedValue(null)
  })

  it('projects the selected provider state and ignores other providers', async () => {
    const { credentialRegistry, useSettingsStore } = await setup()
    useSettingsStore.setState({ providerType: 'openai', hasApiKey: false, hasApiKeyLoaded: false })
    credentialRegistry.commit('openai', { kind: 'valid' })
    expect(useSettingsStore.getState()).toMatchObject({ hasApiKey: true, hasApiKeyLoaded: true })
    credentialRegistry.commit('llm-gateway', { kind: 'expired' })
    expect(useSettingsStore.getState()).toMatchObject({ hasApiKey: true, hasApiKeyLoaded: true })
  })

  it('projects gateway credentials by provider identity rather than the legacy storage key', async () => {
    const { credentialRegistry, useSettingsStore } = await setup()
    useSettingsStore.setState({ providerType: 'llm-gateway' })
    credentialRegistry.commit('llm-gateway', { kind: 'valid' })
    expect(useSettingsStore.getState()).toMatchObject({
      hasApiKey: true, hasApiKeyLoaded: true, modelCredentialStatus: 'valid',
    })
  })

  it('projects gateway expiry after switching from another provider', async () => {
    const { credentialRegistry, useSettingsStore } = await setup()
    credentialRegistry.commit('openai', { kind: 'valid' })
    credentialRegistry.commit('llm-gateway', { kind: 'expired' })
    useSettingsStore.setState({ providerType: 'openai' })
    useSettingsStore.setState({ providerType: 'llm-gateway' })
    expect(useSettingsStore.getState()).toMatchObject({
      hasApiKey: false, hasApiKeyLoaded: true, modelCredentialStatus: 'expired',
    })
  })

  it('drops legacy persisted credential fields instead of hydrating their stale values', async () => {
    localStorage.setItem('bfosa-settings', JSON.stringify({
      version: 5,
      state: { providerType: 'openai', modelName: 'gpt-test', hasApiKey: true,
        hasApiKeyLoaded: true, modelCredentialStatus: 'expired' },
    }))
    const { useSettingsStore } = await setup()
    expect(useSettingsStore.getState()).toMatchObject({
      providerType: 'openai', hasApiKey: false, hasApiKeyLoaded: false,
      modelCredentialStatus: 'unknown',
    })
  })
  it('checks an API-key provider through the shared registry', async () => {
    const { credentialRegistry, useSettingsStore } = await setup()
    useSettingsStore.setState({ providerType: 'openai', modelName: 'gpt-test' })
    loadKey.mockResolvedValue('sk-test')
    expect(await useSettingsStore.getState().checkHasApiKey()).toBe(true)
    expect(credentialRegistry.getState('openai').kind).toBe('valid')
    expect(useSettingsStore.getState().hasApiKey).toBe(true)
  })

  it('keeps storage failures distinct from missing credentials', async () => {
    const { credentialRegistry, useSettingsStore } = await setup()
    useSettingsStore.setState({ providerType: 'openai', modelName: 'gpt-test' })
    loadKey.mockRejectedValue(new Error('temporary storage failure'))
    await useSettingsStore.getState().checkHasApiKey()
    expect(credentialRegistry.getState('openai').kind).toBe('temporary')
  })

  it('routes compatibility writes through the registry', async () => {
    const { credentialRegistry, useSettingsStore } = await setup()
    useSettingsStore.setState({ providerType: 'openai' })
    useSettingsStore.getState().setHasApiKey(true)
    expect(credentialRegistry.getState('openai').kind).toBe('valid')
    useSettingsStore.getState().setModelCredentialStatus('expired')
    expect(credentialRegistry.getState('llm-gateway').kind).toBe('expired')
    expect(useSettingsStore.getState().hasApiKey).toBe(true)
  })

})
