import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebMCPInvokeRequest, WebMCPInvokeResponse } from '@/webmcp/types'
const mocks = vi.hoisted(() => ({ read: vi.fn(), resolve: vi.fn(), getFile: vi.fn(), getManager: vi.fn() }))
vi.mock('@/store/opfs.store', () => ({ useOPFSStore: { getState: () => ({ readFile: mocks.read }) } }))
vi.mock('@/opfs', () => ({ getWorkspaceManager: mocks.getManager }))
vi.mock('../tools/tool-utils', () => ({ resolveNativeDirectoryHandle: vi.fn() }))
vi.mock('../tools/vfs-resolver', () => ({ resolveVfsTarget: mocks.resolve }))
import { WorkspaceBackend } from '../tools/backends/workspace-backend'
import { AssetsBackend } from '../tools/backends/assets-backend'
import { invokeXiaohongshuVideo } from '../tools/xiaohongshu-video-transfer'
import { receiveXiaohongshuVideoFrame, stageXiaohongshuVideoInvocation, takeXiaohongshuVideo } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-video-transfer'
const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])
const context = { directoryHandle: null, workspaceId: 'workspace-test', projectId: 'project-test' }
const response = (result: unknown): WebMCPInvokeResponse => ({ ok: true, hostname: 'creator.xiaohongshu.com', toolName: 'xhs_publish_video', fullToolName: 'xhs_publish_video', result })
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers()
  mocks.read.mockResolvedValue({ content: bytes.buffer, metadata: { size: bytes.length, mtime: 1234, contentType: 'binary' }, source: 'native' })
  mocks.getManager.mockResolvedValue({ getWorkspace: async () => ({ getAssetsDir: async () => ({ getFileHandle: async () => ({ getFile: mocks.getFile }) }) }) })
})
afterEach(() => { delete (window as any)[Symbol.for('eo2.xhs.video-transfer')]; vi.clearAllTimers(); vi.useRealTimers() })
async function transport(kind: 'workspace' | 'assets', name: string) {
  const backend = kind === 'workspace' ? new WorkspaceBackend(context.workspaceId, null, context.projectId) : new AssetsBackend(context.workspaceId)
  mocks.resolve.mockResolvedValue({ kind, path: name, backend })
  const args = { action: 'upload', operation_id: 'video-test', video: `vfs://${kind}/${name}` }
  let captured: File | undefined
  await invokeXiaohongshuVideo({ groupKey: 'creator', fullToolName: 'xhs_publish_video', binding: 'current-tab', args }, context, async (request: WebMCPInvokeRequest) => {
    if (request.args?._eo2_video_frame) return response(receiveXiaohongshuVideoFrame(request.args))
    const publicArgs = stageXiaohongshuVideoInvocation(request.args!)
    expect(publicArgs).toEqual(args); captured = takeXiaohongshuVideo(publicArgs)
    return response({ phase: 'uploaded' })
  })
  return captured!
}
describe('video metadata from real VFS backends through file assembly', () => {
  it.each([['sample.MP4', 'video/mp4'], ['sample.mov', 'video/quicktime'], ['sample.webm', 'video/webm']])('retains %s type and bytes from WorkspaceBackend', async (name, mime) => {
    const file = await transport('workspace', name)
    expect(file).toMatchObject({ name, type: mime, size: bytes.length })
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes)
    expect(mocks.read).toHaveBeenCalledWith(name, null, context.workspaceId, undefined, context.projectId)
  })
  it.each([['sample.MP4', 'video/mp4'], ['sample.mov', 'video/quicktime'], ['sample.webm', 'video/webm']])('uses the existing MIME table for %s when the assets File has an empty type', async (name, mime) => {
    mocks.getFile.mockResolvedValue(new File([bytes], name))
    const file = await transport('assets', name)
    expect(file).toMatchObject({ name, type: mime, size: bytes.length })
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes)
  })
  it('preserves a browser Blob type before WorkspaceBackend converts it to bytes', async () => {
    mocks.read.mockResolvedValue({ content: new Blob([bytes], { type: 'video/example' }), metadata: { size: bytes.length, mtime: 1234, contentType: 'binary' }, source: 'opfs' })
    expect(await transport('workspace', 'clip.mp4')).toMatchObject({ type: 'video/example' })
  })
  it('preserves the assets browser File type even when the extension differs', async () => {
    mocks.getFile.mockResolvedValue(new File([bytes], 'clip.mp4', { type: 'video/example' }))
    expect(await transport('assets', 'clip.mp4')).toMatchObject({ type: 'video/example' })
  })
  it('leaves unknown formats to the website without adding a type whitelist', async () => {
    expect(await transport('workspace', 'clip.unknown')).toMatchObject({ type: 'application/octet-stream', size: bytes.length })
    mocks.getFile.mockResolvedValue(new File([bytes], 'clip.unknown'))
    expect(await transport('assets', 'clip.unknown')).toMatchObject({ type: 'application/octet-stream', size: bytes.length })
  })
  it('keeps existing text and image MIME behavior in both backends', async () => {
    const workspace = new WorkspaceBackend(context.workspaceId)
    expect((await workspace.readFile('photo.png', { encoding: 'binary' })).mimeType).toBe('image/png')
    mocks.read.mockResolvedValue({ content: 'source', metadata: { size: 6, mtime: 1, contentType: 'text' }, source: 'opfs' })
    expect(await workspace.readFile('source.ts')).toMatchObject({ content: 'source', mimeType: 'text' })
    mocks.getFile.mockResolvedValue(new File([bytes], 'photo.png'))
    expect((await new AssetsBackend(context.workspaceId).readFile('photo.png')).mimeType).toBe('image/png')
  })
})
