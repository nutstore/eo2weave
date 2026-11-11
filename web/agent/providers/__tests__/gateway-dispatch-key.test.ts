import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveMock = vi.fn()

vi.mock('@/agent/providers/llm-gateway-auth', () => ({
  resolveGatewayDispatchCredential: (...args: unknown[]) => resolveMock(...args),
}))
vi.mock('@/agent/providers/llm-gateway-provider', () => ({
  getLLMGatewayBaseURL: () => 'https://gateway.test',
  getLLMGatewayClientId: () => 'client',
}))

const { resolveDispatchApiKey } = await import('@/agent/providers/gateway-dispatch-key')
const { GATEWAY_CREDENTIAL_KEY_ALIAS } = await import('@/agent/providers/gateway-credential-alias')

describe('resolveDispatchApiKey (#277)', () => {
  beforeEach(() => {
    resolveMock.mockReset()
  })

  it('uses the stored key for a provider that really has one', async () => {
    await expect(resolveDispatchApiKey('openai', 'sk-stored')).resolves.toEqual({
      ok: true,
      apiKey: 'sk-stored',
    })
    expect(resolveMock).not.toHaveBeenCalled()
  })

  it('reports a missing key for a key-based provider without one', async () => {
    await expect(resolveDispatchApiKey('openai', null)).resolves.toEqual({
      ok: false,
      kind: 'missing',
    })
    expect(resolveMock).not.toHaveBeenCalled()
  })

  it('takes the gateway credential from the session, not from the store', async () => {
    // A stale store value must never win: the shadow is gone and the session is
    // the only authority (#277).
    resolveMock.mockResolvedValue({ ok: true, accessToken: 'session-token' })

    await expect(
      resolveDispatchApiKey(GATEWAY_CREDENTIAL_KEY_ALIAS, 'stale-store-token'),
    ).resolves.toEqual({ ok: true, apiKey: 'session-token' })
    expect(resolveMock).toHaveBeenCalledWith('https://gateway.test', 'client')
  })

  it('treats the bare provider type as the gateway too', async () => {
    resolveMock.mockResolvedValue({ ok: true, accessToken: 'session-token' })

    await expect(resolveDispatchApiKey('llm-gateway', null)).resolves.toEqual({
      ok: true,
      apiKey: 'session-token',
    })
  })

  it('propagates an expired session instead of sending without auth', async () => {
    resolveMock.mockResolvedValue({ ok: false, kind: 'expired' })

    await expect(resolveDispatchApiKey(GATEWAY_CREDENTIAL_KEY_ALIAS, null)).resolves.toEqual({
      ok: false,
      kind: 'expired',
      error: undefined,
    })
  })

  it('propagates a temporary failure with its error', async () => {
    const err = new Error('storage unavailable')
    resolveMock.mockResolvedValue({ ok: false, kind: 'temporary', error: err })

    await expect(resolveDispatchApiKey(GATEWAY_CREDENTIAL_KEY_ALIAS, null)).resolves.toEqual({
      ok: false,
      kind: 'temporary',
      error: err,
    })
  })
})
