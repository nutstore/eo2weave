import { describe, expect, it, vi } from 'vitest'

// Shared, hoisted so the vi.mock factory below can close over it: the file
// map simulates the assets VFS and the write delay lets tests land an abort
// INSIDE the save (post-save window).
const backendState = vi.hoisted(() => ({
  files: new Map<string, Blob>(),
  writeDelayMs: 0,
}))

// The REAL module under test — no module mocks here. AssetsBackend is
// stubbed at the class boundary (OPFS needs a live directory handle the
// test env cannot provide).
vi.mock('@/agent/tools/backends/assets-backend', () => ({
  AssetsBackend: class {
    exists = vi.fn(async (path: string) => backendState.files.has(path))
    writeFile = vi.fn(async (path: string, content: Blob) => {
      if (backendState.writeDelayMs > 0) {
        await new Promise((r) => setTimeout(r, backendState.writeDelayMs))
      }
      backendState.files.set(path, content)
    })
    deleteFile = vi.fn(async (path: string) => {
      backendState.files.delete(path)
    })
  },
}))

import {
  consumeAndSavePluginDownload,
  SavedAssetAbortedError,
  WEBMCP_DOWNLOAD_ABORTED,
} from '@/webmcp/plugin-download'
import type { ToolContext } from '@/agent/tools/tool-types'
import type { WebMCPBridge, WebMCPPluginDownloadFrame } from '@/webmcp/types'

const PLAN = {
  transferId: 't1',
  downloadUrl: 'https://example.com/x.bin',
  savePath: '/',
  fileName: 'x.bin',
  originalResult: { download_url: 'https://example.com/x.bin' },
}

const baseContext = (overrides?: Partial<ToolContext>): ToolContext =>
  ({
    directoryHandle: null,
    workspaceId: 'ws-1',
    ...overrides,
  }) as ToolContext

const startFrame = (totalChunks: number, totalChars: number): WebMCPPluginDownloadFrame => ({
  type: 'start',
  transferId: 't1',
  fileName: 'x.bin',
  mimeType: 'application/octet-stream',
  totalChunks,
  totalChars,
  savePath: '/',
})

/** Data URL helper: 'hello' → valid base64 data URL. */
const dataUrl = (text: string) =>
  `data:application/octet-stream;base64,${btoa(text)}`

/** Controlled async queue usable as a plugin-download stream. */
function frameQueue(frames: WebMCPPluginDownloadFrame[]) {
  let i = 0
  const waits: Array<() => void> = []
  const cancel = vi.fn()
  const queue = {
    next: async () => {
      if (i < frames.length) return { done: false, value: frames[i++] }
      await new Promise<void>((r) => waits.push(r))
      return { done: true, value: undefined }
    },
    return: async () => {
      for (const w of waits) w()
      return { done: true, value: undefined }
    },
    cancel,
    [Symbol.asyncIterator]: () => queue,
  }
  return { queue, cancel }
}

const baseBridge = (stream: AsyncIterable<WebMCPPluginDownloadFrame> & { cancel?: () => void }): WebMCPBridge =>
  ({ ready: true, webMCPInvoke: vi.fn(), webMCPPluginDownloadStream: () => stream }) as unknown as WebMCPBridge

describe('plugin download cancellation (#139 review round 4)', () => {
  it('rejects with the cancellation marker when the run aborts BEFORE the transfer starts (#139 review: pre-start abort becomes failure)', async () => {
    const controller = new AbortController()
    const streamStart = vi.fn(() => {
      throw new Error('stream must not start for an already-aborted run')
    })
    const bridge = {
      ready: true,
      webMCPInvoke: vi.fn(),
      webMCPPluginDownloadStream: streamStart,
    } as unknown as WebMCPBridge
    controller.abort()
    await expect(
      consumeAndSavePluginDownload(bridge, PLAN, baseContext({ abortSignal: controller.signal })),
    ).rejects.toThrow(WEBMCP_DOWNLOAD_ABORTED)
    expect(streamStart).not.toHaveBeenCalled()
  })

  it('cancels the stream and rejects while waiting for a STALLED next frame (#139 review: stopped downloads remain pending)', async () => {
    const controller = new AbortController()
    const { queue, cancel } = frameQueue([startFrame(1, dataUrl('hello').length)])
    const bridge = baseBridge(queue as never)
    const pending = consumeAndSavePluginDownload(
      bridge,
      PLAN,
      baseContext({ abortSignal: controller.signal }),
    )
    // Let the loop consume the start frame, then stall on next() BEFORE any
    // chunk arrives — the previous per-frame check could not fire here.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(cancel).not.toHaveBeenCalled()
    controller.abort()
    await expect(pending).rejects.toThrow(WEBMCP_DOWNLOAD_ABORTED)
    expect(cancel).toHaveBeenCalled()
  })

  it('claims a unique path when the target name is already taken by a concurrent download (#139 review: concurrent downloads lose files)', async () => {
    // The name x.bin is already on disk (a concurrent download wrote it and
    // may still roll ITS file back): this download must claim x-1.bin, not
    // overwrite the existing file.
    backendState.files.set('x.bin', new Blob(['other download']))
    try {
      const controller = new AbortController()
      const payload = dataUrl('hello')
      const { queue } = frameQueue([
        startFrame(1, payload.length),
        { type: 'chunk', transferId: 't1', index: 0, data: payload },
        { type: 'end', transferId: 't1' },
      ])
      const result = await consumeAndSavePluginDownload(
        baseBridge(queue as never),
        PLAN,
        baseContext({ abortSignal: controller.signal }),
      )
      // The concurrent download's file must be untouched.
      expect(backendState.files.get('x.bin')).toBeDefined()
      expect(result.savedPath).toBe('x-1.bin')
    } finally {
      backendState.files.clear()
    }
  })

  it('does not report a plain download failure for an already-aborted signal — maps to the cancellation marker (#139 review: pre-start abort becomes failure)', async () => {
    // Regression shape: the OLD code called throwIfAborted(), whose native
    // AbortError reached the bridge's generic catch and came back as
    // WEBMCP_PLUGIN_DOWNLOAD_FAILED. The new marker must be what surfaces.
    const controller = new AbortController()
    controller.abort()
    const bridge = baseBridge(frameQueue([]).queue as never)
    const error: Error = await consumeAndSavePluginDownload(
      bridge,
      PLAN,
      baseContext({ abortSignal: controller.signal }),
    ).then(
      () => { throw new Error('expected rejection') },
      (e: Error) => e,
    )
    expect(error.message).toBe(WEBMCP_DOWNLOAD_ABORTED)
    expect(error.message).not.toContain('AbortError')
  })

  it('throws SavedAssetAbortedError carrying the saved path when the abort lands after the save (#139 review: failed finalize hides a saved file)', async () => {
    // The write is delayed, so the abort fires while writeFile is in
    // flight: the file lands, then the post-save abort check must throw
    // SavedAssetAbortedError (not the pre-save marker) with the path.
    backendState.writeDelayMs = 50
    try {
      const controller = new AbortController()
      const payload = dataUrl('hello')
      const { queue } = frameQueue([
        startFrame(1, payload.length),
        { type: 'chunk', transferId: 't1', index: 0, data: payload },
        { type: 'end', transferId: 't1' },
      ])
      const pending = consumeAndSavePluginDownload(
        baseBridge(queue as never),
        PLAN,
        baseContext({ abortSignal: controller.signal }),
      )
      // Abort once the write is in flight but before it completes.
      await new Promise((r) => setTimeout(r, 20))
      controller.abort()
      const error = await pending.then(
        () => { throw new Error('expected SavedAssetAbortedError') },
        (e: unknown) => e as SavedAssetAbortedError,
      )
      expect(error).toBeInstanceOf(SavedAssetAbortedError)
      expect(error.savedPath).toBe('x.bin')
    } finally {
      backendState.writeDelayMs = 0
    }
  })
})
