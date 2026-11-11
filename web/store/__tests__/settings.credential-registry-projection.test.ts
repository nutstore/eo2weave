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

  it('rechecks a previously missing key when switching back to a provider', async () => {
    const { useSettingsStore } = await setup()
    useSettingsStore.setState({ providerType: 'openai', modelName: 'gpt-test' })
    expect(await useSettingsStore.getState().checkHasApiKey()).toBe(false)
    loadKey.mockResolvedValue('saved-in-another-tab')
    useSettingsStore.getState().switchProviderAndModel('anthropic', 'claude-test')
    await vi.waitFor(() => expect(loadKey).toHaveBeenCalledWith('anthropic'))
    useSettingsStore.getState().switchProviderAndModel('openai', 'gpt-test')
    await vi.waitFor(() => expect(useSettingsStore.getState().hasApiKey).toBe(true))
  })

  it('rechecks the selected provider when another tab changes its key', async () => {
    const { useSettingsStore } = await setup()
    useSettingsStore.setState({ providerType: 'openai', modelName: 'gpt-test' })
    expect(await useSettingsStore.getState().checkHasApiKey()).toBe(false)
    loadKey.mockResolvedValue('saved-in-another-tab')
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'eo2weave:api-key-change', newValue: JSON.stringify({ provider: 'openai', nonce: 'event-1' }),
    }))
    await vi.waitFor(() => expect(useSettingsStore.getState().hasApiKey).toBe(true))
    loadKey.mockResolvedValue(null)
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'eo2weave:api-key-change', newValue: JSON.stringify({ provider: 'openai', nonce: 'event-2' }),
    }))
    await vi.waitFor(() => expect(useSettingsStore.getState().hasApiKey).toBe(false))
  })

  it('rechecks after a peer change while an older read is still in flight', async () => {
    const { useSettingsStore } = await setup()
    useSettingsStore.setState({ providerType: 'openai', modelName: 'gpt-test' })
    let release!: (key: string | null) => void
    loadKey.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const older = useSettingsStore.getState().checkHasApiKey()
    await vi.waitFor(() => expect(loadKey).toHaveBeenCalledTimes(1))
    loadKey.mockResolvedValue('saved-in-another-tab')
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'eo2weave:api-key-change', newValue: JSON.stringify({ provider: 'openai', nonce: 'event-3' }),
    }))
    await vi.waitFor(() => expect(useSettingsStore.getState().hasApiKey).toBe(true))
    release(null)
    await older
    expect(useSettingsStore.getState().hasApiKey).toBe(true)
  })

})
