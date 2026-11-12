import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadApiKeyMock = vi.fn(async (_key: string): Promise<string | null> => null)
vi.mock('@/security/api-key-store', () => ({
  loadApiKey: (key: string) => loadApiKeyMock(key),
  saveApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
}))

const ALIAS = 'llm-gateway' // the registry key is the provider type; the api-key alias is dispatch-only
const TOKENS = 'llm-gateway-tokens'
const MARKER = '__llm_gateway_expired_session__'

async function seed() {
  const auth = await import('@/agent/providers/llm-gateway-auth')
  const { credentialRegistry } = await import('@/agent/providers/credential-state')
  await auth.seedGatewayCredentialState()
  return credentialRegistry.getState(ALIAS).kind
}

describe('seedGatewayCredentialState (#281)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
    loadApiKeyMock.mockResolvedValue(null)
  })

  it('reports valid for a fresh access token', async () => {
    localStorage.setItem(TOKENS, JSON.stringify({
      access_token: 'a', refresh_token: 'r',
      access_expires_at: Date.now() + 3_600_000, refresh_expires_at: Date.now() + 7_200_000,
    }))
    await expect(seed()).resolves.toBe('valid')
  })

  it('reports expired for a dead refresh token', async () => {
    localStorage.setItem(TOKENS, JSON.stringify({
      access_token: 'a', refresh_token: 'r',
      access_expires_at: Date.now() - 1000, refresh_expires_at: Date.now() - 1000,
    }))
    await expect(seed()).resolves.toBe('expired')
  })

  // The common returning-user case: access token expired, refresh token live.
  // `unknown` would keep hasApiKeyLoaded false and the UI loading until a send.
  it('reports temporary (never unknown) when only the refresh token is live', async () => {
    localStorage.setItem(TOKENS, JSON.stringify({
      access_token: 'a', refresh_token: 'r',
      access_expires_at: Date.now() - 60_000, refresh_expires_at: Date.now() + 3_600_000,
    }))
    await expect(seed()).resolves.toBe('temporary')
  })

  it('reports expired from the marker left by a dead session', async () => {
    localStorage.setItem(MARKER, String(Date.now()))
    await expect(seed()).resolves.toBe('expired')
  })

  it('reports temporary when only the durable refresh record survives', async () => {
    loadApiKeyMock.mockResolvedValue(JSON.stringify({
      refresh_token: 'r', refresh_expires_at: Date.now() + 3_600_000,
    }))
    await expect(seed()).resolves.toBe('temporary')
  })

  it('reports missing when nothing was ever stored', async () => {
    await expect(seed()).resolves.toBe('missing')
  })

  it('reports temporary when the durable record cannot be read', async () => {
    loadApiKeyMock.mockRejectedValue(new Error('store unavailable'))
    await expect(seed()).resolves.toBe('temporary')
  })
})
