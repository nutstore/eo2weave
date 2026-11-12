import { beforeEach, describe, expect, it, vi } from 'vitest'

const keys = vi.hoisted(() => new Map<string, string>())
const deleteApiKey = vi.hoisted(() => vi.fn(async (provider: string) => {
  keys.delete(provider)
}))

vi.mock('@/security/api-key-store', () => ({
  loadApiKey: vi.fn(async (provider: string) => keys.get(provider) ?? null),
  saveApiKey: vi.fn(),
  deleteApiKey,
}))

const LEGACY_KEY = '__llm_gateway_token__'
const REFRESH_KEY = '__llm_gateway_refresh_token__'

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
  keys.clear()
  deleteApiKey.mockClear()
})

describe('legacy gateway credential cleanup (#283)', () => {
  it('removes only the old access-token shadow, preserving the live session and other keys', async () => {
    keys.set(LEGACY_KEY, 'old-access-token')
    keys.set(REFRESH_KEY, 'current-refresh-record')
    keys.set('openai', 'current-api-key')
    const tokens = JSON.stringify({ access_token: 'current-access', refresh_token: 'current-refresh' })
    localStorage.setItem('llm-gateway-tokens', tokens)
    const auth = await import('@/agent/providers/llm-gateway-auth')
    const { credentialRegistry } = await import('@/agent/providers/credential-state')
    credentialRegistry.commit('llm-gateway', { kind: 'valid' })
    const generation = auth.getGatewayAuthSessionGeneration()

    await auth.cleanupLegacyGatewayCredential()

    expect(keys.has(LEGACY_KEY)).toBe(false)
    expect(keys.get(REFRESH_KEY)).toBe('current-refresh-record')
    expect(keys.get('openai')).toBe('current-api-key')
    expect(localStorage.getItem('llm-gateway-tokens')).toBe(tokens)
    expect(auth.getGatewayAuthSessionGeneration()).toBe(generation)
    expect(auth.getGatewayCredentialStatus()).toBe('valid')
  })

  it('deletes idempotently on the next boot without a migration marker', async () => {
    keys.set(LEGACY_KEY, 'old-access-token')
    const firstBoot = await import('@/agent/providers/llm-gateway-auth')
    await firstBoot.cleanupLegacyGatewayCredential()
    expect(keys.has(LEGACY_KEY)).toBe(false)

    vi.resetModules()
    const nextBoot = await import('@/agent/providers/llm-gateway-auth')
    await nextBoot.cleanupLegacyGatewayCredential()

    expect(deleteApiKey).toHaveBeenCalledTimes(2)
    expect(deleteApiKey).toHaveBeenNthCalledWith(1, LEGACY_KEY)
    expect(deleteApiKey).toHaveBeenNthCalledWith(2, LEGACY_KEY)
    expect(localStorage.length).toBe(0)
  })
})
