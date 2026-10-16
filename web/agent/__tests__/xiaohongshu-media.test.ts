import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { xiaohongshuToolImplementations as tools } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-tools'
import { readCardCover, readNoteImages } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-media'

const origin = 'https://www.xiaohongshu.com'
const noteId = '69e78d620000000021012b9b'
const otherId = '6abcd0b5000000001b01d831'
const signedImage = 'https://sns-webpic-qc.xhscdn.com/image-one?sign=keep%2Bvalue&t=123&imageView2=2'
const preview = 'https://sns-webpic-qc.xhscdn.com/image-preview?sign=preview'
const stateWindow = window as Window & { __INITIAL_STATE__?: unknown }

function setPage(path: string) {
  const url = new URL(path, origin)
  vi.stubGlobal('location', { href: url.href, origin, hostname: url.hostname, pathname: url.pathname, search: url.search })
}

function card(id = noteId, image = '') {
  return `<section class="note-item"><a class="cover" href="${origin}/explore/${id}?xsec_token=note-token">${image}</a><span class="title">Visible title</span></section>`
}

beforeEach(() => {
  document.body.innerHTML = ''
  delete stateWindow.__INITIAL_STATE__
  setPage(`/explore/${noteId}`)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList)
})

afterEach(() => {
  document.body.innerHTML = ''
  delete stateWindow.__INITIAL_STATE__
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Xiaohongshu upstream image fields', () => {
  it('preserves state image order, signed URLs and explicit Live Photo values', () => {
    const result = readNoteImages([
      { width: 1080, height: 1440, urlDefault: signedImage, urlPre: preview, livePhoto: true },
      { width: 900, height: 1200, urlDefault: preview, livePhoto: false },
    ], document)
    expect(result).toMatchObject({ image_list_scope: 'current_note_page_state', image_list_partial: false })
    expect(result.imageList).toEqual([
      { width: 1080, height: 1440, urlDefault: signedImage, urlPre: preview, livePhoto: true },
      { width: 900, height: 1200, urlDefault: preview, urlPre: null, livePhoto: false },
    ])
  })

  it('supports wrapped state arrays and leaves unknown fields null', () => {
    expect(readNoteImages({ value: [{ urlPre: preview, width: 0, height: -1 }] }, document).imageList).toEqual([
      { width: null, height: null, urlDefault: null, urlPre: preview, livePhoto: null },
    ])
  })

  it('rejects unsafe URLs and reports omitted malformed entries as partial', () => {
    const result = readNoteImages([
      { urlDefault: signedImage },
      { urlDefault: 'javascript:alert(1)' },
      { urlPre: 'https://user:pass@cdn.example/image' },
      { urlDefault: 'blob:https://www.xiaohongshu.com/local-image' },
      null,
    ], document)
    expect(result.imageList).toHaveLength(1)
    expect(result.image_list_partial).toBe(true)
  })

  it('distinguishes an explicit empty state array from unavailable media', () => {
    expect(readNoteImages([], document)).toEqual({ imageList: [], image_list_scope: 'current_note_page_state', image_list_partial: false })
    expect(readNoteImages(undefined, document)).toEqual({ imageList: [], image_list_scope: 'unavailable', image_list_partial: true })
  })

  it('deduplicates rendered slide copies and excludes avatars and hidden slides', () => {
    document.body.innerHTML = `<div id="noteContainer"><img class="avatar" src="https://cdn.example/avatar"><div class="swiper-slide"><img src="${signedImage}"></div><div class="swiper-slide"><img src="${signedImage}"></div><div style="display:none"><img class="note-slider-img" src="${preview}"></div></div>`
    const result = readNoteImages(undefined, document.querySelector('#noteContainer')!)
    expect(result).toMatchObject({ image_list_scope: 'currently_rendered_dom', image_list_partial: true })
    expect(result.imageList).toEqual([{ width: null, height: null, urlDefault: signedImage, urlPre: null, livePhoto: null }])
  })

  it('uses currentSrc for rendered pictures without rewriting access parameters', () => {
    document.body.innerHTML = '<img class="note-slider-img" src="https://cdn.example/placeholder">'
    const image = document.querySelector('img')!
    Object.defineProperty(image, 'currentSrc', { value: signedImage })
    Object.defineProperty(image, 'naturalWidth', { value: 1080 })
    Object.defineProperty(image, 'naturalHeight', { value: 1440 })
    expect(readNoteImages(undefined, document).imageList[0]).toMatchObject({ urlDefault: signedImage, width: 1080, height: 1440 })
  })

  it('falls back to rendered media when state images have no usable URL', () => {
    document.body.innerHTML = `<img class="note-slider-img" src="${signedImage}">`
    expect(readNoteImages([{ urlDefault: 'data:image/png;base64,invalid' }], document)).toMatchObject({ image_list_scope: 'currently_rendered_dom', image_list_partial: true })
  })

  it('reads the exact current note image list without exposing a cached note', async () => {
    document.body.innerHTML = '<div id="detail-title">Visible title</div>'
    stateWindow.__INITIAL_STATE__ = { note: { noteDetailMap: {
      [noteId]: { note: { noteId, imageList: [{ urlDefault: signedImage, width: 1080, height: 1440 }] } },
      [otherId]: { note: { noteId: otherId, imageList: [{ urlDefault: preview }] } },
    } } }
    const result = await tools.xhs_read_current_note({}) as { data: Record<string, any> }
    expect(result.data.imageList).toHaveLength(1)
    expect(result.data.imageList[0].urlDefault).toBe(signedImage)
    expect(result.data.image_list_scope).toBe('current_note_page_state')
  })

  it('rejects a mismatching state note ID under the current map key', async () => {
    document.body.innerHTML = '<div id="detail-title">Visible title</div>'
    stateWindow.__INITIAL_STATE__ = { note: { noteDetailMap: {
      [noteId]: { note: { noteId: otherId, imageList: [{ urlDefault: preview }] } },
    } } }
    const result = await tools.xhs_read_current_note({}) as { data: Record<string, any> }
    expect(result.data.imageList).toEqual([])
    expect(result.data.image_list_scope).toBe('unavailable')
  })

  it('reads upstream cover variants and dimensions without inferring absent values', () => {
    document.body.innerHTML = card()
    const result = readCardCover(document.querySelector('.note-item')!, {
      width: 1080, height: 1440, url: signedImage, urlPre: preview, fileId: 'image-one',
      infoList: [{ imageScene: 'WB_DFT', url: signedImage }, { imageScene: 'invalid', url: 'javascript:alert(1)' }],
    })
    expect(result).toEqual({ width: 1080, height: 1440, url: signedImage, urlPre: preview, urlDefault: null, fileId: 'image-one', infoList: [{ imageScene: 'WB_DFT', url: signedImage }] })
  })

  it('uses a rendered card cover but excludes the author avatar', () => {
    document.body.innerHTML = card(noteId, `<img src="${signedImage}">`) + '<section class="note-item"><div class="author"><img src="https://cdn.example/avatar"></div></section>'
    const cards = document.querySelectorAll<HTMLElement>('.note-item')
    expect(readCardCover(cards[0])?.urlDefault).toBe(signedImage)
    expect(readCardCover(cards[1])).toBeNull()
  })

  it('adds only exact-ID cover fields to search cards', async () => {
    setPage('/search_result?keyword=test')
    document.body.innerHTML = card()
    stateWindow.__INITIAL_STATE__ = { search: { feeds: { value: [
      { id: otherId, modelType: 'note', noteCard: { displayTitle: 'Visible title', cover: { urlDefault: preview } } },
      { id: noteId, modelType: 'note', noteCard: { cover: { urlDefault: signedImage, width: 1080 } } },
    ] } } }
    const result = await tools.xhs_list_search_results({}) as { data: Record<string, any> }
    expect(result.data.items[0].cover).toMatchObject({ urlDefault: signedImage, width: 1080 })
  })

  it('does not expose a state-only cover based on a matching title', async () => {
    setPage('/search_result?keyword=test')
    document.body.innerHTML = '<div>Visible title</div>'
    stateWindow.__INITIAL_STATE__ = { search: { feeds: { value: [{ id: noteId, modelType: 'note', xsecToken: 'token', noteCard: { displayTitle: 'Visible title', cover: { urlDefault: preview } } }] } } }
    const result = await tools.xhs_list_search_results({}) as { data: Record<string, any> }
    expect(result.data.items[0].cover).toBeNull()
  })

  it('adds exact-ID cover fields to home cards', async () => {
    setPage('/explore')
    document.body.innerHTML = card()
    stateWindow.__INITIAL_STATE__ = { feed: { feeds: { value: [
      { id: otherId, noteCard: { cover: { urlDefault: preview } } },
      { id: noteId, noteCard: { cover: { urlDefault: signedImage } } },
    ] } } }
    const result = await tools.xhs_list_feeds({}) as { data: Record<string, any> }
    expect(result.data.items[0].cover.urlDefault).toBe(signedImage)
  })

  it('reads only the selected profile tab cover state', async () => {
    setPage(`/user/profile/${otherId}`)
    document.body.innerHTML = `<div class="user-page"><span class="user-nickname">Author</span><div class="reds-tab-item sub-tab-list active">收藏</div>${card()}</div>`
    stateWindow.__INITIAL_STATE__ = { user: {
      activeTab: { value: { index: 1, query: 'fav' } },
      notes: { value: [
        [{ id: noteId, noteCard: { cover: { urlDefault: preview } } }],
        [{ id: noteId, noteCard: { cover: { urlDefault: signedImage } } }],
      ] },
    } }
    const result = await tools.xhs_read_profile({}) as { data: Record<string, any> }
    expect(result.data.items[0].cover.urlDefault).toBe(signedImage)
  })
})
