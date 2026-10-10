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
    runtime: { onConnect: { addListener: onConnect }, onMessage: { addListener: onMessage } },
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
