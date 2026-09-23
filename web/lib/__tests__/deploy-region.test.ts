import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Deployment-region gates (lib/deploy-region.ts) are read from
 * process.env at import time, so region behavior is tested by
 * re-importing with stubbed env — same pattern as lib/currency.test.ts.
 *
 * The critical regression being guarded: the international (global) build
 * must NEVER expose the Nutstore AI (Jianguoyun AI) gateway — it's a
 * domestic-only service. If the gateway env vars leak into a global build
 * pipeline, getGatewayClientId() must still return ''.
 */
describe('lib/deploy-region gates', () => {
  const freshImport = async () =>
    (await import('../deploy-region')) as typeof import('../deploy-region')

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('global build (default): gateway disabled even when gateway env vars are set', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEPLOY_REGION', 'global')
    // Simulate the env vars leaking into an international build pipeline —
    // the region gate must win over the client id.
    vi.stubEnv('NEXT_PUBLIC_JIANGUOYUN_AI_CLIENT_ID', 'dc_should_be_ignored')
    const mod = await freshImport()
    expect(mod.IS_CN_BUILD).toBe(false)
    expect(mod.ENABLE_LLM_GATEWAY).toBe(false)
  })

  it('cn build: gateway enabled', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEPLOY_REGION', 'cn')
    const mod = await freshImport()
    expect(mod.IS_CN_BUILD).toBe(true)
    expect(mod.ENABLE_LLM_GATEWAY).toBe(true)
  })

  it('unset region falls back to global (gateway off)', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEPLOY_REGION', '')
    const mod = await freshImport()
    expect(mod.IS_CN_BUILD).toBe(false)
    expect(mod.ENABLE_LLM_GATEWAY).toBe(false)
  })
})
