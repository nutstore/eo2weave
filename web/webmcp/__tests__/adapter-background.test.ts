import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installAdapterBackground } from '../../../browser-extension/entrypoints/webmcp/adapter-background'
import { createAdapterService } from '../../../browser-extension/entrypoints/webmcp/adapter-service'

vi.mock('../../../browser-extension/entrypoints/webmcp/adapter-service', () => ({ createAdapterService: vi.fn() }))

const onUpdated = vi.fn()
const onRemoved = vi.fn()
const onConnect = vi.fn()
const onMessage = vi.fn()
afterEach(() => vi.unstubAllGlobals())
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('chrome', {
    tabs: { onUpdated: { addListener: onUpdated }, onRemoved: { addListener: onRemoved } },
    storage: { onChanged: { addListener: vi.fn() } },
    runtime: { getURL: (path: string) => 'chrome-extension://test' + path, onConnect: { addListener: onConnect }, onMessage: { addListener: onMessage } },
  })
  installAdapterBackground(() => true, async () => 8)
})

it('does not cancel SW workflows on page navigation, refresh or target tab closure', () => {
  expect(onUpdated).not.toHaveBeenCalled()
  expect(onRemoved).not.toHaveBeenCalled()
  expect(onConnect).toHaveBeenCalledOnce()
  expect(onMessage).toHaveBeenCalledOnce()
})

it('does not inject page authorization gates into workflow execution', () => {
  const dependencies = vi.mocked(createAdapterService).mock.calls[0][0]
  expect(dependencies).not.toHaveProperty('authorize')
})

it('blocks Web callers from the internal package configuration API', () => {
  const listener = onMessage.mock.calls[0][0]
  const respond = vi.fn()
  const accepted = listener({ type: 'webmcp_packages_set_config', mount: 'builtin-webmcp', directory: 'world.jmail.archive', config: { activation: 'enabled' } }, { id: 'test', url: 'https://trusted-workspace.test' }, respond)
  expect(accepted).toBe(false)
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 'EACCES' }))
})

it('routes the extension skill mount through the background transport', async () => {
  const listener = onMessage.mock.calls[0][0]
  const result = await new Promise<Record<string, unknown>>(resolve => {
    expect(listener({ type: 'webmcp_provider_call', mount: 'extension-skills', method: 'readFile', path: 'cw-webmcp-creator/SKILL.md' }, {}, resolve)).toBe(true)
  })
  expect(result.ok).toBe(true)
  expect(atob(result.value as string)).toContain('name: cw-webmcp-creator')
})
