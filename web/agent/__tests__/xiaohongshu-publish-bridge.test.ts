import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), invoke: vi.fn(), transfer: vi.fn(), video: vi.fn(), state: vi.fn(), capture: vi.fn(), discover: vi.fn() }))
vi.mock('../policy-engine', () => ({ authorize: mocks.authorize }))
vi.mock('@/mcp/mcp-manager', () => ({ getMCPManager: () => ({ getAllTools: () => new Map() }) }))
vi.mock('@/webmcp/bridge-client', () => ({ getWebMCPBridge: () => ({ webMCPInvoke: mocks.invoke }) }))
vi.mock('@/webmcp/store', () => ({ useWebMCPStore: { getState: mocks.state } }))
vi.mock('../workspace-assistant-context', () => ({ isSidePanelMode: () => true, getSidePanelHostname: () => 'www.xiaohongshu.com', getSidePanelBindingId: () => 'opaque-tab-binding', capturePageContext: mocks.capture }))
vi.mock('@/webmcp/manager', () => ({ discoverWebMCPCatalog: mocks.discover }))
vi.mock('../tools/xiaohongshu-image-transfer', () => ({ prepareXiaohongshuImage: mocks.transfer }))
vi.mock('../tools/xiaohongshu-video-transfer', () => ({ invokeXiaohongshuVideo: mocks.video }))
import { callToolExecutor, collectSidePanelPageTools, setSidePanelBoundTabId, getPageToolsExecutor } from '../external-tool-bridge'
const tool = { name: 'xhs_publish_content', fullName: 'xhs_publish_content', groupKey: 'creator_group', hostname: 'creator.xiaohongshu.com', description: 'Publish', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, untrustedContentHint: true } }
const context = { directoryHandle: null, workspaceId: 'workspace-test' }
beforeEach(() => {
  vi.resetAllMocks(); setSidePanelBoundTabId(7)
  mocks.authorize.mockResolvedValue({ decision: 'allow' })
  mocks.state.mockReturnValue({ getEnabledTools: () => [tool], getPreferredTabIdForTool: () => 99, recordToolInvocation: vi.fn(), getGroupByKey: () => ({ tabs: [{ tabId: 7 }] }) })
  mocks.invoke.mockResolvedValue({ ok: true, result: { phase: 'prepared' } })
  mocks.transfer.mockImplementation(async (args) => args)
  mocks.video.mockImplementation(async (request, _context, invoke) => invoke(request))
  mocks.capture.mockResolvedValue({ hostname: 'creator.xiaohongshu.com' })
  mocks.discover.mockResolvedValue([])
})
describe('publication routing and existing authorization', () => {
  it.each(['xhs_post_comment_to_feed', 'xhs_reply_comment_in_feed', 'xhs_like_feed'])('uses existing %s authorization and never advertises automatic retry', async (toolName) => {
    const commentTool = { ...tool, hostname: 'www.xiaohongshu.com', name: toolName, fullName: toolName, description: 'Post comment' }
    mocks.state.mockReturnValue({ getEnabledTools: () => [commentTool], getPreferredTabIdForTool: () => 99, recordToolInvocation: vi.fn(), getGroupByKey: () => ({ tabs: [{ tabId: 7 }] }) })
    const args = { feed_id: 'test-note', xsec_token: 'test-token', content: '评论' }
    mocks.authorize.mockResolvedValue({ decision: 'deny', reason: 'User denied' })
    expect(JSON.parse(await callToolExecutor({ full_tool_name: `creator_group_${toolName}`, args }, context)).error.code).toBe('AUTH_DENIED_BY_USER')
    expect(mocks.invoke).not.toHaveBeenCalled()
    mocks.authorize.mockResolvedValue({ decision: 'allow' })
    mocks.invoke.mockResolvedValue({ ok: false, errorCode: 'RELAY_TIMEOUT', error: 'Outcome unknown' })
    const response = JSON.parse(await callToolExecutor({ full_tool_name: `creator_group_${toolName}`, args }, context))
    expect(mocks.authorize.mock.calls.at(-1)![0]).toMatchObject({ toolArgs: args, toolDescription: 'Post comment', args: { untrusted: true } })
    expect(mocks.invoke.mock.calls[0][0]).toMatchObject({ binding: 'opaque-tab-binding', args })
    expect(response.error).toMatchObject({ code: 'RELAY_TIMEOUT', retryable: false })
    expect(mocks.transfer).not.toHaveBeenCalled(); expect(mocks.video).not.toHaveBeenCalled()
  })
  it('authorizes video writes before file reads and preserves the bound-tab request', async () => {
    const videoTool = { ...tool, name: 'xhs_publish_video', fullName: 'xhs_publish_video' }
    mocks.state.mockReturnValue({ getEnabledTools: () => [videoTool], getPreferredTabIdForTool: () => 99, recordToolInvocation: vi.fn(), getGroupByKey: () => ({ tabs: [{ tabId: 7 }] }) })
    const args = { action: 'upload', operation_id: 'video-test', video: 'vfs://assets/a.mp4' }
    mocks.authorize.mockResolvedValue({ decision: 'deny', reason: 'User denied' })
    expect(JSON.parse(await callToolExecutor({ full_tool_name: 'creator_group_xhs_publish_video', args }, context)).error.code).toBe('AUTH_DENIED_BY_USER')
    expect(mocks.video).not.toHaveBeenCalled(); expect(mocks.invoke).not.toHaveBeenCalled()
    mocks.authorize.mockResolvedValue({ decision: 'allow' })
    await callToolExecutor({ full_tool_name: 'creator_group_xhs_publish_video', args }, context)
    expect(mocks.video).toHaveBeenCalledOnce()
    expect(mocks.invoke.mock.calls[0][0]).toMatchObject({ binding: 'opaque-tab-binding', args })
    expect(mocks.transfer).not.toHaveBeenCalled()
  })
  it('refreshes explicit discovery after navigation and never returns old-host call names', async () => {
    const oldTool = { ...tool, hostname: 'www.xiaohongshu.com', groupKey: 'old_group' }
    mocks.state.mockReturnValue({ getEnabledTools: () => [oldTool, tool], getGroupByKey: () => ({ tabs: [{ tabId: 7 }] }) })
    const response = JSON.parse(await getPageToolsExecutor({}, context))
    expect(mocks.capture).toHaveBeenCalledOnce()
    expect(mocks.discover).toHaveBeenCalledWith(true)
    expect(response.data.hostname).toBe('creator.xiaohongshu.com')
    expect(response.data.tools.map((entry: { call_name: string }) => entry.call_name)).toEqual(['creator_group_xhs_publish_content'])
  })
  it('returns no old tools while the new creator page has not registered its catalog', async () => {
    const oldTool = { ...tool, hostname: 'www.xiaohongshu.com', groupKey: 'old_group' }
    mocks.state.mockReturnValue({ getEnabledTools: () => [oldTool], getGroupByKey: () => ({ tabs: [{ tabId: 7 }] }) })
    const response = JSON.parse(await getPageToolsExecutor({}, context))
    expect(response.data.hostname).toBe('creator.xiaohongshu.com')
    expect(response.data.tools).toEqual([])
  })
  it('does not leak the previous catalog when rediscovery fails', async () => {
    mocks.discover.mockRejectedValue(new Error('Discovery unavailable'))
    const response = JSON.parse(await getPageToolsExecutor({}, context))
    expect(response.data.tools).toEqual([])
    expect(response.data.message).toContain('do not reuse pre-navigation')
  })
  it('discovers creator tools only in the same bound tab after host navigation', () => {
    expect(collectSidePanelPageTools()).toHaveLength(1)
    mocks.state.mockReturnValue({ getEnabledTools: () => [tool], getGroupByKey: () => ({ tabs: [{ tabId: 99 }] }) })
    expect(collectSidePanelPageTools()).toHaveLength(0)
  })
  it('does not read or transfer image files before authorization', async () => {
    mocks.authorize.mockResolvedValue({ decision: 'deny', reason: 'User denied' })
    const response = JSON.parse(await callToolExecutor({ full_tool_name: 'creator_group_xhs_publish_content', args: { action: 'upload', image: 'vfs://assets/a.png' } }, context))
    expect(response.error.code).toBe('AUTH_DENIED_BY_USER')
    expect(mocks.transfer).not.toHaveBeenCalled(); expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('routes publishing with the opaque current-tab binding and reviewed args', async () => {
    const args = { action: 'prepare', operation_id: 'publish_test' }
    await callToolExecutor({ full_tool_name: 'creator_group_xhs_publish_content', args }, context)
    expect(mocks.authorize.mock.calls[0][0]).toMatchObject({ toolArgs: args, args: { untrusted: true } })
    expect(mocks.invoke.mock.calls[0][0]).toMatchObject({ binding: 'opaque-tab-binding', args })
  })
  it('marks relay timeout nonretryable for publishing', async () => {
    mocks.invoke.mockResolvedValue({ ok: false, errorCode: 'RELAY_TIMEOUT', error: 'Outcome unknown' })
    const response = JSON.parse(await callToolExecutor({ full_tool_name: 'creator_group_xhs_publish_content', args: { action: 'submit', confirm: true } }, context))
    expect(response.error.code).toBe('RELAY_TIMEOUT'); expect(response.error.retryable).toBe(false)
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })
})
