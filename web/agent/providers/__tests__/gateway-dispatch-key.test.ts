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
const { getGatewayDispatchCredentialKey } = await import('@/agent/providers/gateway-credential-alias')

describe('resolveDispatchApiKey (#277)', () => {
  beforeEach(() => {
    resolveMock.mockReset()
  })

  it('uses the stored key for a provider that really has one', async () => {
    await expect(resolveDispatchApiKey('openai', async () => 'sk-stored')).resolves.toEqual({
      ok: true,
      apiKey: 'sk-stored',
    })
    expect(resolveMock).not.toHaveBeenCalled()
  })

  it('reports a missing key for a key-based provider without one', async () => {
    await expect(resolveDispatchApiKey('openai', async () => null)).resolves.toEqual({
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
      resolveDispatchApiKey(getGatewayDispatchCredentialKey(), async () => 'stale-store-token'),
    ).resolves.toEqual({ ok: true, apiKey: 'session-token' })
    expect(resolveMock).toHaveBeenCalledWith('https://gateway.test', 'client')
  })

  it('resolves a gateway session without loading the obsolete key', async () => {
    resolveMock.mockResolvedValue({ ok: true, accessToken: 'session-token' })
    const loadKey = vi.fn(async () => { throw new Error('key store unavailable') })
    await expect(resolveDispatchApiKey(getGatewayDispatchCredentialKey(), loadKey))
      .resolves.toEqual({ ok: true, apiKey: 'session-token' })
    expect(loadKey).not.toHaveBeenCalled()
  })

  it('does not treat a provider literally named "llm-gateway" as the gateway', async () => {
    // Only the effective-config marker routes to the session. The bare type is
    // also a legal custom-provider id, and sending that provider down the
    // gateway path would hand it a credential it never configured.
    await expect(resolveDispatchApiKey('llm-gateway', async () => 'sk-custom')).resolves.toEqual({
      ok: true,
      apiKey: 'sk-custom',
    })
    expect(resolveMock).not.toHaveBeenCalled()
  })

  it('propagates an expired session instead of sending without auth', async () => {
    resolveMock.mockResolvedValue({ ok: false, kind: 'expired' })

    await expect(resolveDispatchApiKey(getGatewayDispatchCredentialKey(), async () => null)).resolves.toEqual({
      ok: false,
      kind: 'expired',
      error: undefined,
    })
  })

  it('propagates a temporary failure with its error', async () => {
    const err = new Error('storage unavailable')
    resolveMock.mockResolvedValue({ ok: false, kind: 'temporary', error: err })

    await expect(resolveDispatchApiKey(getGatewayDispatchCredentialKey(), async () => null)).resolves.toEqual({
      ok: false,
      kind: 'temporary',
      error: err,
    })
  })
})
