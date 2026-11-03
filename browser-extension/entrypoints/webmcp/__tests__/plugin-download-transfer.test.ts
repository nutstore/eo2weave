/**
 * Plugin download mirror fallback (issue #143).
 *
 * The plugin download plan carries a `downloadUrl` that frequently points at
 * `raw.githubusercontent.com` — unreachable from mainland-China networks. The
 * transfer must fall back to the jsDelivr mirror instead of failing the
 * whole download.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertPublicHttpsDownloadUrl, streamPluginDownload } from '../plugin-download-transfer'
import type { WebMCPPluginDownloadFrame, WebMCPPluginDownloadPlan } from '../types'

const RAW = 'https://raw.githubusercontent.com/owner/repo/main/asset.zip'
const MIRROR = 'https://cdn.jsdelivr.net/gh/owner/repo@main/asset.zip'

function plan(url = RAW): WebMCPPluginDownloadPlan {
  return {
    transferId: 'transfer-1',
    downloadUrl: url,
    savePath: '/',
    fileName: 'asset.zip',
    originalResult: { ok: true },
  }
}

function response(body: string, contentType = 'application/zip'): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => contentType },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('streamPluginDownload', () => {
  it('rejects a host with attacker-controlled DNS before fetching', async () => {
    expect(() => assertPublicHttpsDownloadUrl('https://downloads.example.com/file.zip')).toThrow(/host is not allowed/)
  })

  it('does not try the mirror after the caller cancels a download', async () => {
    const controller = new AbortController()
    const tried: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      tried.push(String(input))
      controller.abort()
      init?.signal?.throwIfAborted()
      throw new Error('aborted')
    }))
    const frames: WebMCPPluginDownloadFrame[] = []
    await streamPluginDownload(plan(), frame => frames.push(frame), controller.signal)
    expect(tried).toEqual([RAW])
    expect(frames).toEqual([])
  })

  it('does not fetch when cancellation preceded the download', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await streamPluginDownload(plan(), () => {}, controller.signal)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('stops emitting chunks when the consumer cancels after the start frame', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('payload')))
    const controller = new AbortController()
    const frames: WebMCPPluginDownloadFrame[] = []
    await streamPluginDownload(plan(), frame => {
      frames.push(frame)
      if (frame.type === 'start') controller.abort()
    }, controller.signal)
    expect(frames.map(frame => frame.type)).toEqual(['start'])
  })
  it('downloads from the canonical URL when it answers', async () => {
    const tried: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      tried.push(String(input))
      return response('payload')
    }))

    const frames: WebMCPPluginDownloadFrame[] = []
    await streamPluginDownload(plan(), frame => frames.push(frame))

    expect(tried).toEqual([RAW])
    expect(frames[0]?.type).toBe('start')
    expect(frames.at(-1)?.type).toBe('end')
  })

  it('falls back to the jsDelivr mirror when the canonical host fails', async () => {
    const tried: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      tried.push(url)
      if (url.startsWith('https://raw.githubusercontent.com')) throw new Error('network unreachable')
      return response('payload')
    }))

    const frames: WebMCPPluginDownloadFrame[] = []
    await streamPluginDownload(plan(), frame => frames.push(frame))

    expect(tried).toEqual([RAW, MIRROR])
    expect(frames.at(-1)?.type).toBe('end')
  })

  it('reports an error frame when every candidate fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network unreachable') }))

    const frames: WebMCPPluginDownloadFrame[] = []
    await streamPluginDownload(plan(), frame => frames.push(frame))

    const error = frames.find(frame => frame.type === 'error')
    expect(error).toBeDefined()
    expect((error as { errorCode?: string }).errorCode).toBe('WEBMCP_PLUGIN_DOWNLOAD_STREAM_FAILED')
  })
})
