// Follow upstream feed_detail.go: use noteDetailMap[feedID].note title/desc unchanged.
// The caller supplies state from the current note ID; DOM fallback cannot prove completeness.
import { fieldRecord } from './xiaohongshu-fields'

function textField(stateValue: unknown, domValue: unknown, limit: number) {
  if (typeof stateValue === 'string') {
    return { value: stateValue, scope: 'current_note_page_state', complete: true, truncated: false,
      length: stateValue.length, returnedLength: stateValue.length }
  }
  const rendered = typeof domValue === 'string' ? domValue.replace(/\s+/g, ' ').trim() : ''
  if (!rendered) return { value: null, scope: 'unavailable', complete: null, truncated: false,
    length: null, returnedLength: null }
  const truncated = rendered.length > limit
  return { value: rendered.slice(0, limit), scope: 'currently_rendered_dom', complete: truncated ? false : null,
    truncated, length: rendered.length, returnedLength: Math.min(rendered.length, limit) }
}

export function readNoteText(stateValue: unknown, noteId: string | null, domTitle: unknown, domBody: unknown) {
  const candidate = fieldRecord(stateValue)
  const state = noteId && candidate && (candidate.noteId === undefined || candidate.noteId === noteId) ? candidate : null
  const title = textField(state?.title, domTitle, 500)
  const body = textField(state?.desc, domBody, 8000)
  return {
    title: title.value,
    title_scope: title.scope, title_complete: title.complete, title_truncated: title.truncated,
    title_length: title.length, title_returned_length: title.returnedLength,
    body: body.value,
    body_scope: body.scope, body_complete: body.complete, body_truncated: body.truncated,
    body_length: body.length, body_returned_length: body.returnedLength,
    text_length_unit: 'utf16_code_units',
  }
}
