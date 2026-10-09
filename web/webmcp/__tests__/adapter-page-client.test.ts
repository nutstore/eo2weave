import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invokeAdapterFromPage } from '../../../browser-extension/entrypoints/webmcp/adapter-page-client'
import { ADAPTER_PAGE_MARKER } from '@creatorweave/shared/webmcp-adapter-protocol'

const tool = { routeId: 'route', name: 'com.example.read', description: 'Read', inputSchema: { type: 'object' }, urlRegex: '^http://localhost:3000/start$' }
const post = vi.fn()
beforeEach(() => {
  vi.resetAllMocks()
  window.history.replaceState(null, '', '/start')
  vi.spyOn(window, 'postMessage').mockImplementation(post)
})
afterEach(() => vi.restoreAllMocks())

function reply() {
  const requestId = post.mock.calls[0][0].requestId
  window.dispatchEvent(new MessageEvent('message', {
    source: window,
    data: { [ADAPTER_PAGE_MARKER]: true, kind: 'result', requestId, response: { ok: true, value: 42 } },
  }))
}

it('detaches on document unload without canceling the background workflow', async () => {
  const result = invokeAdapterFromPage(tool, {}, new AbortController().signal)
  const rejected = expect(result).rejects.toThrow('workflow continues')
  window.dispatchEvent(new Event('pagehide'))
  await rejected
  expect(post.mock.calls.map(([data]) => data.kind)).toEqual(['invoke'])
})

it('receives the workflow result after SPA navigation', async () => {
  const controller = new AbortController()
  const result = invokeAdapterFromPage(tool, {}, controller.signal)
  window.history.replaceState(null, '', '/destination')
  expect(post.mock.calls.map(([data]) => data.kind)).toEqual(['invoke'])
  reply()
  await expect(result).resolves.toBe(42)
})

it('still supports explicit execution cancellation', async () => {
  const controller = new AbortController()
  const result = invokeAdapterFromPage(tool, {}, controller.signal)
  const rejected = expect(result).rejects.toThrow('execution canceled')
  controller.abort()
  await rejected
  expect(post.mock.calls.map(([data]) => data.kind)).toEqual(['invoke', 'cancel'])
})
