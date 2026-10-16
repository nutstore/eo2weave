import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readNoteVideo } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-media'
import { xiaohongshuToolImplementations as tools } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-tools'

const origin = 'https://www.xiaohongshu.com'
const id = '6aafaaaa0000000012024630'
const otherId = '69e78d620000000021012b9b'
const masterUrl = 'https://sns-video.example/video.mp4?sign=keep%2Bvalue&t=123'
const subtitleUrl = 'https://sns-video.example/zh.srt?sign=keep%2Bvalue&t=123'
const stateWindow = window as Window & { __INITIAL_STATE__?: unknown }
function video() {
  return {
    image: { firstFrameFileid: 'frame-file-id', thumbnailFileid: 'thumbnail-file-id' },
    capa: { duration: 12 },
    media: {
      videoId: 1234,
      video: { duration: 12, hdrType: 0, drmType: 0, streamTypes: [1, 2], bizName: 110, bizId: 'biz-id', md5: 'original-md5' },
      stream: {
        h264: [{ masterUrl, backupUrls: ['https://backup.example/video.mp4'], width: 1080, height: 1920, duration: 12345, size: 10000, fps: 30, rotate: 0, format: 'mp4', qualityType: 'HD', streamType: 1, streamDesc: '1080p', hdrType: 0, videoCodec: 'h264', videoBitrate: 800, videoDuration: 12345, avgBitrate: 900, audioCodec: 'aac', audioBitrate: 100, audioDuration: 12345, audioChannels: 2, volume: 0.5, vmaf: 88.1, psnr: 42.2, ssim: 0.99, weight: 1, defaultStream: 0 }, { masterUrl: `${masterUrl}&quality=720`, width: 720 }],
        h265: [],
        next_codec: [{ masterUrl: `${masterUrl}&codec=new` }],
      },
    },
  }
}
beforeEach(() => {
  document.body.innerHTML = '<div id="detail-title">Current video</div>'
  delete stateWindow.__INITIAL_STATE__
  vi.stubGlobal('location', { href: `${origin}/explore/${id}`, origin, hostname: 'www.xiaohongshu.com', pathname: `/explore/${id}`, search: '' })
})
afterEach(() => {
  document.body.innerHTML = ''
  delete stateWindow.__INITIAL_STATE__
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('Xiaohongshu upstream video detail', () => {
  it('preserves every encoding bucket, quality order and signed URL', () => {
    const result = readNoteVideo(video())
    expect(result).toMatchObject({ video_scope: 'current_note_page_state', video_partial: false, subtitles_scope: 'unavailable' })
    expect(Object.keys(result.video!.media!.stream!)).toEqual(['h264', 'h265', 'next_codec'])
    expect(result.video!.media!.stream!.h264).toHaveLength(2)
    expect(result.video!.media!.stream!.h264[0]).toEqual(video().media.stream.h264[0])
    expect(result.video!.media!.stream!.h265).toEqual([])
    expect(result.video!.media!.stream!.next_codec[0].masterUrl).toBe(`${masterUrl}&codec=new`)
  })
  it('keeps duration units, zero flags, decimals and file IDs unchanged', () => {
    const result = readNoteVideo(video()).video!
    expect(result.image).toEqual(video().image)
    expect(result.capa!.duration).toBe(12)
    expect(result.media!.video!.duration).toBe(12)
    expect(result.media!.video!.drmType).toBe(0)
    expect(result.media!.stream!.h264[0]).toMatchObject({ duration: 12345, size: 10000, rotate: 0, defaultStream: 0, volume: 0.5, vmaf: 88.1 })
  })
  it('extracts only existing subtitle URLs from mediaV2, preserving language buckets', () => {
    const result = readNoteVideo({ ...video(), mediaV2: JSON.stringify({ video: { subtitles: { zh: [{ url: subtitleUrl, language: 'zh', format: 1, type: 0 }], source: [], en: [{ url: subtitleUrl + '&lang=en', language: 'en' }] }, duration: 999 }, stream: { h264: [{ masterUrl: 'https://wrong.example/video' }] } }) })
    expect(result.subtitles_scope).toBe('video.mediaV2')
    expect(result.video!.subtitles).toEqual({ zh: [{ url: subtitleUrl, language: 'zh', format: 1, type: 0 }], source: [], en: [{ url: subtitleUrl + '&lang=en', language: 'en', format: null, type: null }] })
    expect(result.video!.media!.stream!.h264[0].masterUrl).toBe(masterUrl)
    expect(result.video!.media!.video!.duration).toBe(12)
    expect(result.video).not.toHaveProperty('mediaV2')
  })
  it('supports direct subtitle fields when mediaV2 is absent', () => {
    const result = readNoteVideo({ ...video(), subtitles: { zh: [{ url: subtitleUrl }] } })
    expect(result.subtitles_scope).toBe('video.subtitles')
    expect(result.video!.subtitles!.zh[0].url).toBe(subtitleUrl)
  })
  it.each(['{broken', '[]', '{"video":[]}', '{"video":{"subtitles":[]}}'])('retains primary video and direct subtitles on malformed mediaV2: %s', (mediaV2) => {
    const result = readNoteVideo({ ...video(), subtitles: { zh: [{ url: subtitleUrl }] }, mediaV2 })
    expect(result.video!.media!.stream!.h264[0].masterUrl).toBe(masterUrl)
    expect(result.video!.subtitles!.zh[0].url).toBe(subtitleUrl)
    expect(result.video_partial).toBe(true)
  })
  it('lets valid mediaV2 override direct subtitles as upstream does', () => {
    expect(readNoteVideo({ ...video(), subtitles: { zh: [{ url: subtitleUrl }] }, mediaV2: '{}' }).video!.subtitles).toBeNull()
    expect(readNoteVideo({ ...video(), mediaV2: '{"video":{"subtitles":{}}}' }).video!.subtitles).toEqual({})
    expect(readNoteVideo(video()).video!.subtitles).toBeNull()
  })
  it('preserves unknowns instead of fabricating dimensions, streams or booleans', () => {
    const result = readNoteVideo({ media: { videoId: Number.MAX_SAFE_INTEGER + 1, video: { duration: NaN }, stream: { h264: [{ masterUrl, width: Infinity, fps: 29.5 }] } } })
    expect(result.video!.media!.videoId).toBeNull()
    expect(result.video!.media!.video!.duration).toBeNull()
    expect(result.video!.media!.stream!.h264[0]).toMatchObject({ width: null, fps: null, height: null, backupUrls: null })
    expect(result.video!.image).toBeNull()
    expect(result.video!.capa).toBeNull()
  })
  it('rejects unsafe URLs and malformed entries with partial evidence', () => {
    const result = readNoteVideo({ media: { stream: { h264: [null, { masterUrl: 'blob:local', backupUrls: ['javascript:alert(1)', 'https://backup.example/video'] }], broken: 'not-array' } }, subtitles: { zh: [{ url: 'data:text/plain,x' }, { url: 'https://user:pass@cdn.example/file' }, { url: subtitleUrl }], broken: null } })
    expect(result.video_partial).toBe(true)
    expect(result.video!.media!.stream!.h264).toHaveLength(1)
    expect(result.video!.media!.stream!.h264[0]).toMatchObject({ masterUrl: null, backupUrls: ['https://backup.example/video'] })
    expect(result.video!.media!.stream).not.toHaveProperty('broken')
    expect(result.video!.subtitles!.zh).toHaveLength(1)
  })
  it('supports wrapped state while ignoring unrelated source fields', () => {
    const result = readNoteVideo({ value: { media: { stream: { av1: { _value: [{ masterUrl, internalSecret: 'discard' }] } } }, extra: 'discard' } })
    expect(result.video!.media!.stream!.av1[0].masterUrl).toBe(masterUrl)
    expect(JSON.stringify(result)).not.toContain('discard')
  })
  it('returns unavailable for missing video without inventing a playable DOM URL', () => {
    document.body.innerHTML += '<video src="blob:local"></video>'
    expect(readNoteVideo(undefined)).toEqual({ video: null, video_scope: 'unavailable', video_partial: true, subtitles_scope: 'unavailable' })
    expect(readNoteVideo(null).video).toBeNull()
  })
  it('reads only the exact current note and returns null for a normal note', async () => {
    stateWindow.__INITIAL_STATE__ = { note: { noteDetailMap: { [id]: { note: { noteId: id, type: 'video', video: video() } }, [otherId]: { note: { noteId: otherId, video: { ...video(), capa: { duration: 999 } } } } } } }
    const result = await tools.xhs_read_current_note({}) as { data: ReturnType<typeof readNoteVideo> }
    expect(result.data.video!.capa!.duration).toBe(12)
    stateWindow.__INITIAL_STATE__ = { note: { noteDetailMap: { [id]: { note: { noteId: id, type: 'normal' } }, [otherId]: { note: { video: video() } } } } }
    expect((await tools.xhs_read_current_note({}) as { data: ReturnType<typeof readNoteVideo> }).data.video).toBeNull()
  })
  it('rejects a mismatching payload note ID', async () => {
    stateWindow.__INITIAL_STATE__ = { note: { noteDetailMap: { [id]: { note: { noteId: otherId, type: 'video', video: video() } } } } }
    expect((await tools.xhs_read_current_note({}) as { data: ReturnType<typeof readNoteVideo> }).data.video).toBeNull()
  })
})
