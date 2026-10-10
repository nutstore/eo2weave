import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectAdapterHost } from '../adapter-host'
import { ADAPTER_HOST_MARKER } from '@creatorweave/shared/webmcp-adapter-protocol'
let connection: ReturnType<typeof connectAdapterHost>
const post = vi.fn()
beforeEach(() => { vi.resetAllMocks(); vi.spyOn(window, 'postMessage').mockImplementation(post) })
afterEach(() => { connection?.stop(); vi.restoreAllMocks() })
function setup(invoke = vi.fn(async () => 42)) {
  const disconnected = vi.fn()
  connection = connectAdapterHost({ workspaceId: 'workspace', binding: null, names: () => ['read'], invoke }, disconnected)
  const publication = connection.attach()
  const envelope = post.mock.calls[0][0]
  const receive = (message: unknown, sessionId = envelope.sessionId) => window.dispatchEvent(new MessageEvent('message', {
    source: window, data: { [ADAPTER_HOST_MARKER]: true, direction: 'to-web', sessionId, message },
  }))
  const request = { kind: 'invoke', executionId: 'execution', callId: 'call', workspaceId: 'workspace', toolName: 'read', args: { path: 'x' } }
  const acknowledge = () => receive({ kind: 'attached', requestId: envelope.message.requestId })
  return { invoke, publication, receive, request, acknowledge, disconnected }
}
it('serves tool calls while publication is waiting, preserving values and call identity', async () => {
  const { invoke, publication, receive, request, acknowledge } = setup()
  receive(request)
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ message: {
    kind: 'reply', callId: 'call', result: { ok: true, value: 42 },
  } }), expect.any(String)))
  expect(invoke).toHaveBeenCalledWith('read', { path: 'x' }, 'call', expect.any(AbortSignal), 'execution')
  acknowledge()
  await publication
})
it('rejects mismatched workspace and ignores messages for another session', async () => {
  const { invoke, publication, receive, request, acknowledge } = setup()
  receive(request, 'wrong-session')
  expect(invoke).not.toHaveBeenCalled()
  receive({ ...request, workspaceId: 'other' })
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ message: expect.objectContaining({ kind: 'reply', result: expect.objectContaining({ ok: false }) }) }), expect.any(String)))
  expect(invoke).not.toHaveBeenCalled()
  acknowledge()
  await publication
})
it('cancels pending calls on disconnect and ignores late completions', async () => {
  let complete!: (value: number) => void
  const invoke = vi.fn(() => new Promise<number>(resolve => { complete = resolve }))
  const { publication, receive, request, acknowledge, disconnected } = setup(invoke)
  acknowledge()
  await publication
  receive(request)
  const signal = (invoke.mock.calls[0] as unknown as [string, unknown, string, AbortSignal])[3]
  receive({ kind: 'disconnected' })
  expect(signal.aborted).toBe(true)
  expect(disconnected).toHaveBeenCalledOnce()
  complete(9)
  await Promise.resolve()
  expect(post.mock.calls.some(([envelope]) => envelope.message.kind === 'reply')).toBe(false)
})
