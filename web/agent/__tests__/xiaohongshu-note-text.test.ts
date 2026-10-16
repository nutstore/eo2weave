import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readNoteText } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-note-text'
import { xiaohongshuToolImplementations as tools } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-tools'

const id = '6abbda160000000014001437'
const otherId = '69e78d620000000021012b9b'
const origin = 'https://www.xiaohongshu.com'
const stateWindow = window as Window & { __INITIAL_STATE__?: unknown }
beforeEach(() => {
  const url = new URL(`/explore/${id}`, origin)
  vi.stubGlobal('location', { href: url.href, origin, hostname: url.hostname, pathname: url.pathname, search: '' })
  document.body.innerHTML = '<div id="detail-title">Visible title</div><div id="detail-desc">Visible body</div>'
  delete stateWindow.__INITIAL_STATE__
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList)
})
afterEach(() => {
  delete stateWindow.__INITIAL_STATE__
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Xiaohongshu upstream full title and desc', () => {
  it('returns full state strings without the previous title/body caps', () => {
    const title = '标题'.repeat(350)
    const desc = '段落\n换行  保留🙂'.repeat(1000)
    expect(readNoteText({ noteId: id, title, desc }, id, 'DOM title', 'DOM body')).toEqual({
      title, title_scope: 'current_note_page_state', title_complete: true, title_truncated: false,
      title_length: title.length, title_returned_length: title.length,
      body: desc, body_scope: 'current_note_page_state', body_complete: true, body_truncated: false,
      body_length: desc.length, body_returned_length: desc.length, text_length_unit: 'utf16_code_units',
    })
  })
  it.each(['', ' \n ', '\n前段\n\n后段  \n'])('preserves explicit state string %j instead of replacing it with DOM text', (desc) => {
    expect(readNoteText({ title: '', desc }, id, 'DOM title', 'DOM body')).toMatchObject({ title: '', title_length: 0, title_complete: true, body: desc, body_length: desc.length, body_complete: true, body_truncated: false })
  })
  it.each([undefined, null, [], {}, { noteId: otherId, title: 'Wrong', desc: 'Wrong' }])('marks the DOM-only branch unknown for state %#', (state) => {
    expect(readNoteText(state, id, 'Visible title', 'Visible body')).toMatchObject({ title: 'Visible title', title_scope: 'currently_rendered_dom', title_complete: null, body: 'Visible body', body_scope: 'currently_rendered_dom', body_complete: null, body_truncated: false })
  })
  it('never reads state text without a current note ID', () => {
    expect(readNoteText({ title: 'Wrong', desc: 'Wrong' }, null, 'DOM', null)).toMatchObject({ title: 'DOM', title_complete: null, body: null, body_scope: 'unavailable', body_complete: null })
  })
  it.each([0, false, {}, []])('does not stringify a malformed desc %#', (desc) => {
    expect(readNoteText({ title: 'State title', desc }, id, 'DOM title', 'DOM body')).toMatchObject({ title: 'State title', title_complete: true, body: 'DOM body', body_complete: null })
  })
  it.each([499, 500, 501])('reports title clipping at the exact DOM limit for %s units', (length) => {
    const title = '字'.repeat(length)
    expect(readNoteText(null, id, title, null)).toMatchObject({ title: title.slice(0, 500), title_length: length, title_returned_length: Math.min(length, 500), title_truncated: length > 500, title_complete: length > 500 ? false : null })
  })
  it.each([7999, 8000, 8001])('reports body clipping at the exact DOM limit for %s units', (length) => {
    const body = '字'.repeat(length)
    expect(readNoteText(null, id, null, body)).toMatchObject({ body: body.slice(0, 8000), body_length: length, body_returned_length: Math.min(length, 8000), body_truncated: length > 8000, body_complete: length > 8000 ? false : null })
  })
  it('retains legacy DOM whitespace normalization and counts the normalized source', () => {
    expect(readNoteText(null, id, '  DOM\n title  ', ' A\n\n B ')).toMatchObject({ title: 'DOM title', title_length: 9, body: 'A B', body_length: 3, body_returned_length: 3, body_complete: null })
  })
  it('distinguishes an unavailable body from a known empty state desc', () => {
    expect(readNoteText(null, id, null, null)).toMatchObject({ body: null, body_length: null, body_returned_length: null, body_complete: null, body_truncated: false, body_scope: 'unavailable' })
    expect(readNoteText({ desc: '' }, id, null, null)).toMatchObject({ body: '', body_length: 0, body_complete: true, body_scope: 'current_note_page_state' })
  })
  it('returns the full current ID desc rather than another cached note or visible preview', async () => {
    const desc = 'Full\n'.repeat(2000)
    stateWindow.__INITIAL_STATE__ = { note: { noteDetailMap: {
      [id]: { note: { noteId: id, title: 'Current', desc } },
      [otherId]: { note: { noteId: otherId, title: 'Wrong', desc: 'Wrong cached content' } },
    } } }
    const result = await tools.xhs_read_current_note({}) as { data: Record<string, unknown> }
    expect(result.data).toMatchObject({ title: 'Current', body: desc, body_scope: 'current_note_page_state', body_length: 10000, body_returned_length: 10000, body_complete: true, body_truncated: false })
  })
  it('leaves exact-ID text unknown when a wrong note is stored under the current key', async () => {
    stateWindow.__INITIAL_STATE__ = { note: { noteDetailMap: { [id]: { note: { noteId: otherId, title: 'Wrong', desc: 'Wrong' } } } } }
    const result = await tools.xhs_read_current_note({}) as { data: Record<string, unknown> }
    expect(result.data).toMatchObject({ title: 'Visible title', body: 'Visible body', body_complete: null, body_scope: 'currently_rendered_dom', fields_scope: 'unavailable' })
  })
  it('marks a long DOM-only body truncated without claiming page-state completeness', async () => {
    document.querySelector('#detail-desc')!.textContent = '字'.repeat(9000)
    const result = await tools.xhs_read_current_note({}) as { data: Record<string, unknown> }
    expect(result.data).toMatchObject({ body_length: 9000, body_returned_length: 8000, body_complete: false, body_truncated: true, body_scope: 'currently_rendered_dom' })
  })
  it.each(['normal', 'video'])('reads a rendered media-only %s note with known empty title and desc', async (type) => {
    document.body.innerHTML = `<div id="noteContainer">${type === 'video' ? '<video></video>' : '<img class="note-slider-img" src="https://cdn.example/image">'}</div>`
    const note = { noteId: id, title: '', desc: '', type,
      imageList: type === 'normal' ? [{ width: 1080, height: 1440, urlDefault: 'https://cdn.example/image' }] : [],
      video: type === 'video' ? { capa: { duration: 0 } } : null }
    stateWindow.__INITIAL_STATE__ = { note: { noteDetailMap: { [id]: { note } } } }
    const result = await tools.xhs_read_current_note({}) as { status: string; data: Record<string, unknown> }
    expect(result.status).toBe('ok')
    expect(result.data).toMatchObject({ title: '', body: '', body_length: 0, body_complete: true, body_truncated: false })
  })
})
