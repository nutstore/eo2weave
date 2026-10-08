// Adapt Comment/CommentList from upstream types.go and exact-note extraction in feed_detail.go.
// Source: xpzouying/xiaohongshu-mcp at a5c8f7799980ba1fdd501999843eb2d17e4c9a9f.
import { fieldRecord, fieldText, readUser } from './xiaohongshu-fields'

interface Entry { raw: Record<string, unknown>; parentId: string | null }
export interface CommentState {
  entries: Map<string, Entry | null>
  noteId: string
  scope: 'current_note_page_state' | 'unavailable'
  partial: boolean
  cursor: string | null
  hasMore: boolean | null
}

function array(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  const ref = value && typeof value === 'object' ? value as Record<string, unknown> : null
  const list = ref?.value ?? ref?._value
  return Array.isArray(list) ? list : null
}

export function commentState(state: unknown, noteId: string): CommentState {
  const output: CommentState = { entries: new Map(), noteId, scope: 'unavailable', partial: true, cursor: null, hasMore: null }
  const detail = fieldRecord(fieldRecord(fieldRecord(fieldRecord(state)?.note)?.noteDetailMap)?.[noteId])
  const note = fieldRecord(detail?.note)
  if (note?.noteId != null && note.noteId !== noteId) return output
  const comments = fieldRecord(detail?.comments)
  if (!comments) return output
  output.scope = 'current_note_page_state'
  output.cursor = typeof comments.cursor === 'string' ? comments.cursor : null
  output.hasMore = typeof comments.hasMore === 'boolean' ? comments.hasMore : null
  const list = array(comments.list)
  if (!list) return output
  output.partial = false
  const pending = list.map((raw) => ({ raw, parentId: null as string | null }))
  const visited = new WeakSet<object>()
  let examined = 0
  while (pending.length && examined++ < 10000) {
    const item = pending.pop()!
    const raw = fieldRecord(item.raw)
    const id = fieldText(raw?.id)
    if (!raw || !id) { output.partial = true; continue }
    if (visited.has(raw)) { output.entries.set(id, null); output.partial = true; continue }
    visited.add(raw)
    if (output.entries.has(id)) { output.entries.set(id, null); output.partial = true }
    else output.entries.set(id, { raw, parentId: item.parentId })
    if (raw.noteId != null && raw.noteId !== noteId) { output.partial = true; continue }
    const replies = array(raw.subComments)
    if (replies) for (const reply of replies) pending.push({ raw: reply, parentId: id })
    else if (raw.subComments != null) output.partial = true
  }
  if (pending.length) output.partial = true
  return output
}

export function commentFields(state: CommentState, id: string, parentId: string | null, hasDomId: boolean) {
  const entry = hasDomId ? state.entries.get(id) : undefined
  const source = entry?.raw
  const mismatch = source?.noteId != null && source.noteId !== state.noteId
  const parent = parentId === null ? undefined : state.entries.get(parentId)
  const parentMismatch = !!entry && (entry.parentId !== parentId || (parentId !== null
    && (!parent || (parent.raw.noteId != null && parent.raw.noteId !== state.noteId))))
  const raw = mismatch || parentMismatch ? undefined : source
  const fieldsScope = raw ? 'current_note_page_state' : 'unavailable'
  const match = !hasDomId ? 'no_dom_id' : entry === null ? 'ambiguous_id'
    : mismatch ? 'note_mismatch' : parentMismatch ? 'parent_mismatch' : raw ? 'matched' : 'not_found'
  const time = raw?.createTime
  const tags = array(raw?.showTags)
  return {
    id: raw ? fieldText(raw.id) : null,
    noteId: fieldText(raw?.noteId),
    content: fieldText(raw?.content),
    likeCount: fieldText(raw?.likeCount),
    createTime: typeof time === 'number' && Number.isSafeInteger(time) && time >= 0 ? time : null,
    ipLocation: fieldText(raw?.ipLocation),
    liked: typeof raw?.liked === 'boolean' ? raw.liked : null,
    userInfo: readUser(raw?.userInfo),
    subCommentCount: fieldText(raw?.subCommentCount),
    showTags: tags && tags.every((tag) => typeof tag === 'string') ? tags as string[] : null,
    fields_scope: fieldsScope,
    state_match: match,
  }
}

export function stateReplyIds(state: CommentState, id: string): string[] | null {
  const list = array(state.entries.get(id)?.raw.subComments)
  if (!list) return null
  const ids = list.map((entry) => fieldText(fieldRecord(entry)?.id))
  return ids.every((entry): entry is string => entry !== null) ? ids : null
}
