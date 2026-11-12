/**
 * Tests for the gateway re-login flow (issue #75): the credential-expired
 * error card's Re-login entry — the store phase machine, the success
 * callback (regenerate), and the error-state handling.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const performDeviceCodeFlowMock = vi.hoisted(() => vi.fn())
const persistDeviceLoginTokensMock = vi.hoisted(() => vi.fn())
const applyGatewayLoginTokensMock = vi.hoisted(() => vi.fn())

vi.mock('@/agent/providers/llm-gateway-auth', () => ({
  performDeviceCodeFlow: performDeviceCodeFlowMock,
  persistDeviceLoginTokens: persistDeviceLoginTokensMock,
}))

vi.mock('@/lib/gateway-login', () => ({
  applyGatewayLoginTokens: applyGatewayLoginTokensMock,
  getLLMGatewayBaseURL: () => 'https://ai.jianguoyun.com',
  getLLMGatewayClientId: () => 'test-client-id',
}))

import { useGatewayReloginStore } from '@/store/gateway-relogin.store'

describe('gateway-relogin.store', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    performDeviceCodeFlowMock.mockReset()
    applyGatewayLoginTokensMock.mockReset()
    applyGatewayLoginTokensMock.mockImplementation(async (_token, options) => {
      options.onCommit()
      return { ok: true, accessToken: 'tok', models: [] }
    })
    useGatewayReloginStore.setState({ phase: 'idle', authState: null, error: null })
  })

  it('runs the flow and invokes the success callback, then resets to idle', async () => {
    performDeviceCodeFlowMock.mockImplementation(
      async (
        _base: string,
        _client: string,
        onState?: (s: { status: string; userCode?: string; verificationUri?: string }) => void
      ) => {
        onState?.({ status: 'waiting', userCode: 'ABC-123', verificationUri: 'https://auth' })
        return { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }
      }
    )

    const onSuccess = vi.fn()
    const promise = useGatewayReloginStore.getState().start(onSuccess)

    // Running phase visible while the flow is in flight
    expect(useGatewayReloginStore.getState().phase).toBe('running')

    const ok = await promise
    expect(ok).toBe(true)
    expect(applyGatewayLoginTokensMock).toHaveBeenCalledWith('tok', expect.objectContaining({ onCommit: expect.any(Function) }))
    expect(persistDeviceLoginTokensMock).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: 'tok' }), 'test-client-id', 'https://ai.jianguoyun.com',
    )
    expect(onSuccess).toHaveBeenCalledTimes(1)
    // Store settles back to idle so the dialog closes and a later failure
    // can start a fresh flow.
    expect(useGatewayReloginStore.getState().phase).toBe('idle')
    expect(useGatewayReloginStore.getState().authState).toBeNull()
  })

  it('mirrors the device-flow auth state for the dialog', async () => {
    performDeviceCodeFlowMock.mockImplementation(
      async (
        _base: string,
        _client: string,
        onState?: (s: { status: string; userCode?: string }) => void
      ) => {
        onState?.({ status: 'polling', userCode: 'XYZ' })
        return { access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }
      }
    )

    const promise = useGatewayReloginStore.getState().start()
    expect(useGatewayReloginStore.getState().authState).toEqual({ status: 'polling', userCode: 'XYZ' })
    await promise
  })

  it('reports a terminal device authorization error', async () => {
    const err = Object.assign(new Error('Device authorization rejected'), { code: 'invalid_grant' })
    performDeviceCodeFlowMock.mockRejectedValue(err)

    const ok = await useGatewayReloginStore.getState().start()

    expect(ok).toBe(false)
    expect(useGatewayReloginStore.getState().phase).toBe('error')
    expect(useGatewayReloginStore.getState().error).toBe('Device authorization rejected')
    expect(useGatewayReloginStore.getState().authState?.status).toBe('error')
  })

  it('reports a local device-flow timeout', async () => {
    performDeviceCodeFlowMock.mockRejectedValue(
      Object.assign(new Error('Device authorization session expired'), { code: 'device_flow_timeout' })
    )

    await useGatewayReloginStore.getState().start()

    expect(useGatewayReloginStore.getState().phase).toBe('error')
    expect(useGatewayReloginStore.getState().error).toBe('Device authorization session expired')
  })

  it('ignores concurrent start() calls while a flow is running', async () => {
    let resolveFlow!: (v: unknown) => void
    performDeviceCodeFlowMock.mockImplementation(() => new Promise((resolve) => { resolveFlow = resolve }))

    const first = useGatewayReloginStore.getState().start()
    const second = await useGatewayReloginStore.getState().start()
    expect(second).toBe(false)

    resolveFlow({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 })
    expect(await first).toBe(true)
  })

  it('reset() clears the error state', async () => {
    performDeviceCodeFlowMock.mockRejectedValue(new Error('boom'))
    await useGatewayReloginStore.getState().start()
    expect(useGatewayReloginStore.getState().phase).toBe('error')

    useGatewayReloginStore.getState().reset()
    expect(useGatewayReloginStore.getState().phase).toBe('idle')
    expect(useGatewayReloginStore.getState().error).toBeNull()
  })
})
