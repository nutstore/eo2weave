import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const performDeviceCodeFlow = vi.hoisted(() => vi.fn())

vi.mock('@/agent/providers/llm-gateway-auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/agent/providers/llm-gateway-auth')>(),
  performDeviceCodeFlow,
}))

vi.mock('@/security/api-key-store', () => ({
  loadApiKey: vi.fn(async () => null),
  saveApiKey: vi.fn(async () => undefined),
  deleteApiKey: vi.fn(async () => undefined),
}))

vi.mock('@/lib/gateway-login', () => ({
  getLLMGatewayBaseURL: () => 'https://gateway.example',
  getLLMGatewayClientId: () => 'test-client',
  applyGatewayLoginTokens: vi.fn(),
}))

vi.mock('@/i18n', () => ({ useT: () => (key: string) => key }))

beforeEach(async () => {
  localStorage.clear()
  const { credentialRegistry } = await import('@/agent/providers/credential-state')
  credentialRegistry.reset()
  performDeviceCodeFlow.mockReset()
})

describe.each(['login', 'relogin'] as const)('%s credential isolation', (entry) => {
  it.each(['invalid_grant', 'expired_token'])(
    'preserves a newer session when the older device flow returns %s',
    async (code) => {
      const auth = await import('@/agent/providers/llm-gateway-auth')
      const { registerDynamicProvider } = await import('@/agent/providers/types')
      registerDynamicProvider('llm-gateway', {
        baseURL: 'https://gateway.example/v1', modelName: 'gw-model', headers: {},
      }, {
        category: 'custom', displayName: 'Nutstore AI', catalogStatus: 'ready',
        models: [{ id: 'gw-model', name: 'gw-model', capabilities: ['code'] }],
      })
      const { useSettingsStore } = await import('@/store/settings.store')
      const { useGatewayLogin } = await import('@/hooks/useGatewayLogin')
      const { useGatewayReloginStore } = await import('@/store/gateway-relogin.store')
      useSettingsStore.setState({ providerType: 'llm-gateway', modelName: 'gw-model' })
      const hook = renderHook(useGatewayLogin)
      let rejectOlder!: (error: Error) => void
      performDeviceCodeFlow.mockImplementation(() => new Promise((_resolve, reject) => {
        rejectOlder = reject
      }))

      let pending!: Promise<boolean>
      act(() => {
        pending = entry === 'login'
          ? hook.result.current.login()
          : useGatewayReloginStore.getState().start()
      })

      // Another login completes while this device authorization is pending.
      auth.persistDeviceLoginTokens({
        access_token: 'new-access', refresh_token: 'new-refresh',
        expires_in: 3600, refresh_expires_in: 7200, token_type: 'Bearer',
      }, 'test-client', 'https://gateway.example')
      expect(auth.getGatewayCredentialStatus()).toBe('valid')

      await act(async () => {
        rejectOlder(Object.assign(new Error('Old device authorization failed'), { code }))
        expect(await pending).toBe(false)
      })

      const flowState = entry === 'login'
        ? hook.result.current.authState
        : useGatewayReloginStore.getState().authState
      expect(flowState).toMatchObject({ status: 'error', error: 'Old device authorization failed' })
      expect(JSON.parse(localStorage.getItem('llm-gateway-tokens')!).access_token).toBe('new-access')
      expect(auth.getGatewayCredentialStatus()).toBe('valid')
      expect(await useSettingsStore.getState().checkHasApiKey()).toBe(true)
      expect(useSettingsStore.getState()).toMatchObject({ hasApiKey: true, modelCredentialStatus: 'valid' })
      hook.unmount()
    },
  )
})
