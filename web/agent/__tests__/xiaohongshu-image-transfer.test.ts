import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), read: vi.fn() }))
vi.mock('../tools/vfs-resolver', () => ({ resolveVfsTarget: mocks.resolve }))
import { prepareXiaohongshuImage } from '../tools/xiaohongshu-image-transfer'
import { prepareRemoteXiaohongshuImage } from '../../../browser-extension/entrypoints/webmcp/xiaohongshu-image-transfer'
import { stageXiaohongshuImage, takeXiaohongshuImage } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-transfer'
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])
const args = { action: 'upload', operation_id: 'operation_test', image_index: 0, image: 'vfs://assets/photo.png' }
beforeEach(() => { vi.resetAllMocks(); mocks.resolve.mockResolvedValue({ kind: 'assets', path: 'photo.png', backend: { readFile: mocks.read } }); mocks.read.mockResolvedValue({ content: png }); vi.unstubAllGlobals() })
describe('EO2 authorized image transfer', () => {
  it('reads authorized binary bytes without exposing them in public tool arguments', async () => {
    const transported = await prepareXiaohongshuImage(args, { directoryHandle: null })
    expect(mocks.resolve).toHaveBeenCalledWith(args.image, { directoryHandle: null }, 'read')
    expect(mocks.read).toHaveBeenCalledWith('photo.png', { encoding: 'binary' })
    const publicArgs = stageXiaohongshuImage(transported)
    expect(publicArgs).toEqual(args); expect(takeXiaohongshuImage(args)?.mime).toBe('image/png')
    expect(takeXiaohongshuImage(args)).toBeUndefined()
  })
  it('does not read local files for unrelated actions or remote images', async () => {
    expect(await prepareXiaohongshuImage({ action: 'status' }, { directoryHandle: null })).toEqual({ action: 'status' })
    await prepareXiaohongshuImage({ ...args, image: 'https://example.com/image.png' }, { directoryHandle: null })
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('rejects injected binary payloads and unavailable arbitrary absolute paths', async () => {
    await expect(prepareXiaohongshuImage({ ...args, _eo2_image: {} }, { directoryHandle: null })).rejects.toThrow('EO2')
    await expect(prepareXiaohongshuImage({ ...args, image: 'D:\\outside\\image.png' }, { directoryHandle: null })).rejects.toThrow('workspace')
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('does not silently skip a missing file or substitute an agent/skills file', async () => {
    mocks.read.mockRejectedValue(new Error('File missing'))
    await expect(prepareXiaohongshuImage(args, { directoryHandle: null })).rejects.toThrow('File missing')
    mocks.resolve.mockResolvedValue({ kind: 'agent', backend: { readFile: mocks.read } })
    await expect(prepareXiaohongshuImage(args, { directoryHandle: null })).rejects.toThrow('workspace or assets')
  })
  it('downloads HTTP images without account cookies, validating content bytes', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(png))
    vi.stubGlobal('fetch', fetch)
    const result = await prepareRemoteXiaohongshuImage({ ...args, image: 'http://example.com/image?signature=secret' })
    expect((result._eo2_image as { mime: string }).mime).toBe('image/png')
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' })
  })
  it('reports HTTP failure without signed URLs and rejects nonimage downloads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('missing', { status: 403 })))
    await expect(prepareRemoteXiaohongshuImage({ ...args, image: 'https://example.com/image?token=secret' })).rejects.toThrow('HTTP 403')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>error</html>')))
    await expect(prepareRemoteXiaohongshuImage({ ...args, image: 'https://example.com/image.png' })).rejects.toThrow('recognized')
  })
  it('transfers local file bytes without adding remote-download format restrictions', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    mocks.read.mockResolvedValue({ content: bytes })
    const result = await prepareXiaohongshuImage(args, { directoryHandle: null })
    const payload = result._eo2_image as { mime: string; name: string; base64: string }
    expect(payload.mime).toBe(''); expect(payload.name).toBe('photo.png')
    expect(Uint8Array.from(atob(payload.base64), (ch) => ch.charCodeAt(0))).toEqual(bytes)
  })
  it('delegates credential-bearing URL support to fetch instead of adding an upfront rejection', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(png))
    vi.stubGlobal('fetch', fetch)
    await prepareRemoteXiaohongshuImage({ ...args, image: 'https://user:password@example.com/image.png' })
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('retains upstream HTTP 200 requirement', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(png, { status: 206 })))
    await expect(prepareRemoteXiaohongshuImage({ ...args, image: 'https://example.com/image.png' })).rejects.toThrow('HTTP 206')
  })
  it('redacts source URLs from platform request errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Request cannot use https://user:password@example.com/image.png?token=secret')))
    const pending = prepareRemoteXiaohongshuImage({ ...args, image: 'https://user:password@example.com/image.png?token=secret' })
    await expect(pending).rejects.toThrow('source URL omitted')
    await expect(pending).rejects.not.toThrow('password')
  })
})
