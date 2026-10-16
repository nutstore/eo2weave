import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebMCPInvokeRequest } from '@/webmcp/types'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), read: vi.fn(), resolve: vi.fn(), state: vi.fn(), record: vi.fn() }))
vi.mock('../policy-engine', () => ({ authorize: vi.fn().mockResolvedValue({ decision: 'allow' }) }))
vi.mock('@/mcp/mcp-manager', () => ({ getMCPManager: () => ({ getAllTools: () => new Map() }) }))
vi.mock('@/webmcp/bridge-client', () => ({ getWebMCPBridge: () => ({ webMCPInvoke: mocks.invoke }) }))
vi.mock('@/webmcp/store', () => ({ useWebMCPStore: { getState: mocks.state } }))
vi.mock('../workspace-assistant-context', () => ({ isSidePanelMode: () => true, getSidePanelHostname: () => 'creator.xiaohongshu.com', getSidePanelBindingId: () => 'bound-tab' }))
vi.mock('../tools/vfs-resolver', () => ({ resolveVfsTarget: mocks.resolve }))

import { callToolExecutor, setSidePanelBoundTabId } from '../external-tool-bridge'
const tool = {
  name: 'xhs_publish_video', fullName: 'xhs_publish_video', groupKey: 'creator', hostname: 'creator.xiaohongshu.com',
  description: 'Prepare video', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false },
}
const args = { action: 'upload', operation_id: 'video-test', video: 'vfs://assets/clip.mp4' }
const context = { directoryHandle: null }
let outcome: (request: WebMCPInvokeRequest) => Promise<object>
beforeEach(() => {
  vi.clearAllMocks()
  mocks.invoke.mockReset(); mocks.record.mockReset()
  setSidePanelBoundTabId(7)
  mocks.state.mockReturnValue({ getEnabledTools: () => [tool], getPreferredTabIdForTool: () => 7, recordToolInvocation: mocks.record })
  mocks.resolve.mockResolvedValue({ kind: 'assets', path: 'clip.mp4', backend: { readFile: mocks.read } })
  mocks.read.mockResolvedValue({ content: new Uint8Array([1, 2, 3]), mimeType: 'video/mp4' })
  outcome = async () => ({ ok: true, tabId: 7, result: { phase: 'uploaded' } })
  // Run the real transfer helper: frames are acknowledged, then the final
  // invocation can fail after the page may already have supplied the file.
  mocks.invoke.mockImplementation(async (request: WebMCPInvokeRequest) => {
    const frame = request.args?._eo2_video_frame as { transfer_id: string; kind: string; index?: number } | undefined
    if (frame) return { ok: true, result: { _eo2_video_transfer_ack: { transfer_id: frame.transfer_id, kind: frame.kind, index: frame.index } } }
    return outcome(request)
  })
})

function assertSingleSupply() {
  expect(mocks.read).toHaveBeenCalledOnce()
  const finalCalls = mocks.invoke.mock.calls.filter(([request]) => !request.args._eo2_video_frame)
  expect(finalCalls).toHaveLength(1)
  expect(finalCalls[0][0]).toMatchObject({ binding: 'bound-tab', args: { ...args, _eo2_video_transfer: expect.any(String) } })
  expect(mocks.invoke.mock.calls.filter(([request]) => request.args._eo2_video_frame?.kind === 'abort')).toHaveLength(1)
}

describe('video invocation failures after complete file transport', () => {
  it.each(['RELAY_TIMEOUT', 'RELAY_UNREACHABLE', 'BRIDGE_TIMEOUT'])('never advertises a direct retry after %s on the final invoke', async (code) => {
    outcome = async () => ({ ok: false, errorCode: code, error: 'Upload outcome unknown' })
    const result = JSON.parse(await callToolExecutor({ full_tool_name: 'creator_xhs_publish_video', args }, context))
    expect(result.error).toMatchObject({ code, retryable: false })
    assertSingleSupply()
  })

  it('does not retry when cancellation is reported after the final invoke started', async () => {
    const controller = new AbortController()
    outcome = async () => { controller.abort(); return { ok: false, errorCode: 'ABORTED', error: 'Invocation interrupted' } }
    const result = JSON.parse(await callToolExecutor({ full_tool_name: 'creator_xhs_publish_video', args }, { ...context, abortSignal: controller.signal }))
    expect(result.error).toMatchObject({ code: 'ABORTED', retryable: false })
    assertSingleSupply()
  })

  it('keeps a rejected final invoke nonretryable and only cleans up the transport', async () => {
    outcome = async () => { throw new Error('Connection interrupted after invoking upload') }
    const result = JSON.parse(await callToolExecutor({ full_tool_name: 'creator_xhs_publish_video', args }, context))
    expect(result.error).toMatchObject({ code: 'VIDEO_TRANSFER_FAILED', retryable: false })
    assertSingleSupply()
  })

  it('keeps outer bookkeeping errors nonretryable after the page call completed', async () => {
    mocks.record.mockImplementation(() => { throw new Error('Invocation bookkeeping failed') })
    const result = JSON.parse(await callToolExecutor({ full_tool_name: 'creator_xhs_publish_video', args }, context))
    expect(result.error).toMatchObject({ code: 'WEBMCP_INVOKE_FAILED', retryable: false })
    assertSingleSupply()
  })
})
