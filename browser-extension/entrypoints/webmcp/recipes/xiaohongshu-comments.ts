import {
  HOST, clean, visible, result, error, currentNoteId, isUnavailablePage,
  unavailableNote, loginState, metricText, initialState,
} from './xiaohongshu-page'
import { commentState, commentFields, stateReplyIds } from './xiaohongshu-comment-fields'

const COMMENTS = '.comments-container, .comments-el, .comments-list, .comment-list'
const REPLIES = '.reply-container, .replies, .reply-list, .child-comments, .sub-comments'
const REPLY_ROWS = '.child-comment, .reply-item, .sub-comment, .reply-comment'
const EXPAND_TEXT = /^展开\s*(\d+\s*条|更多)回复$/
const POLL_MS = 250
const ROUND_TIMEOUT_MS = 2500

interface Comment {
  comment_id: string
  id_source: 'dom' | 'content_signature'
  parent_comment_id: string | null
  author: string | null
  text: string
  text_truncated: boolean
  published_at: string | null
  likes_text: string | null
}

function rendered(element: Element | null, boundary?: Element): element is HTMLElement {
  if (!visible(element)) return false
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor)
    if (ancestor.hidden || style.display === 'none' || style.visibility === 'hidden') return false
    if (ancestor === boundary) break
  }
  return true
}

function commentRoot(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>(COMMENTS)).find((element) => rendered(element)) ?? null
}

function guard(noteId?: string, pageUrl?: string) {
  if (noteId && (currentNoteId() !== noteId || location.href !== pageUrl)) {
    return error('PAGE_CHANGED', 'The tab navigated while loading comments. Read the new page before continuing.')
  }
  if (location.hostname !== HOST) return error('UNSUPPORTED_PAGE', 'Not on a supported Xiaohongshu page.')
  if (isUnavailablePage()) return unavailableNote()
  if (!currentNoteId()) return error('NOT_NOTE_PAGE', 'Open a Xiaohongshu note first.')
  if (loginState() === 'logged_out') return error('LOGIN_REQUIRED', 'Sign in on the current Xiaohongshu tab first.')
  return null
}

function signature(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(16)
}

function ownField(row: HTMLElement, selector: string, excluded: HTMLElement[], max: number) {
  const elements = Array.from(row.querySelectorAll<HTMLElement>(selector))
  for (const element of elements) {
    if (!rendered(element, row) || excluded.some((other) => other === element || other.contains(element))) continue
    // Walk the live DOM so nested replies and hidden text cannot leak into the parent body.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const pieces: string[] = []
    let node: Node | null
    while ((node = walker.nextNode())) {
      const parent = node.parentElement
      if (parent && rendered(parent, element) && !excluded.some((other) => other.contains(parent))) {
        pieces.push(node.textContent ?? '')
      }
    }
    const fullText = clean(pieces.join(' '))
    if (fullText) return { text: fullText.slice(0, max), truncated: fullText.length > max }
  }
  return { text: null, truncated: false }
}

function parseComment(row: HTMLElement, parentId: string | null, excluded: HTMLElement[], fallbackId?: string | null): Comment | null {
  const body = ownField(row, '.comment-content, .content', excluded, 4000)
  if (!body.text) return null
  const author = ownField(row, '.user-name, .author .name, .author-wrapper .name, .name', excluded, 120).text
  const published = ownField(row, '.date, .comment-time, .time', excluded, 120).text
  // Upstream comment_feed.go locates website rows using #comment-{commentID}.
  const rawId = clean(row.getAttribute('data-comment-id') || row.getAttribute('data-id') || domId(row) || fallbackId)
  const id = rawId || `signature:${signature([parentId, author, body.text, published].join('\u001f'))}`
  return {
    comment_id: id,
    id_source: rawId ? 'dom' : 'content_signature',
    parent_comment_id: parentId,
    author,
    text: body.text,
    text_truncated: body.truncated,
    published_at: published,
    likes_text: ownField(row, '.like-wrapper .count, .like-count, .like .count', excluded, 40).text,
  }
}

function domId(row: HTMLElement): string {
  return row.id.startsWith('comment-') ? row.id.slice('comment-'.length) : row.id
}

function readRows(root: HTMLElement): Comment[] {
  const comments: Comment[] = []
  const seen = new Set<string>()
  const add = (comment: Comment | null) => {
    if (!comment) return
    const key = `${comment.parent_comment_id ?? ''}/${comment.comment_id}`
    if (!seen.has(key)) { seen.add(key); comments.push(comment) }
  }
  for (const thread of root.querySelectorAll<HTMLElement>('.parent-comment')) {
    if (!rendered(thread, root) || thread.parentElement?.closest('.parent-comment')) continue
    const replyContainers = Array.from(thread.querySelectorAll<HTMLElement>(REPLIES))
    const explicitReplies = Array.from(thread.querySelectorAll<HTMLElement>(REPLY_ROWS))
    const row = Array.from(thread.querySelectorAll<HTMLElement>('.comment-item'))
      .find((candidate) => !replyContainers.some((container) => container.contains(candidate)) && !explicitReplies.includes(candidate)) ?? thread
    const replies = Array.from(thread.querySelectorAll<HTMLElement>(`${REPLY_ROWS}, .comment-item`))
      .filter((candidate) => candidate !== row && !candidate.contains(row))
      .filter((candidate, _, all) => !all.some((other) => other !== candidate && other.contains(candidate)))
    const excluded = [...replyContainers, ...replies]
    const parent = parseComment(row, null, excluded, thread.getAttribute('data-comment-id') || thread.getAttribute('data-id') || domId(thread))
    if (!parent) continue
    add(parent)
    for (const reply of replies) {
      if (rendered(reply, root)) add(parseComment(reply, parent.comment_id, []))
    }
  }
  return comments
}

function expansionButtons(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.parent-comment .show-more'))
    .filter((element) => rendered(element, root) && EXPAND_TEXT.test(clean(element.innerText)))
}

function endVisible(root: HTMLElement): boolean {
  return Array.from(root.querySelectorAll<HTMLElement>('.end-container'))
    .some((element) => rendered(element, root) && /THE\s*END/i.test(clean(element.innerText)))
}

function emptyVisible(root: HTMLElement): boolean {
  return Array.from(root.querySelectorAll<HTMLElement>('.no-comments-text, .no-comments, .comments-empty'))
    .some((element) => rendered(element, root) && /这是一片荒地|暂无评论|还没有评论/.test(clean(element.innerText)))
}

function loadingVisible(root: HTMLElement): boolean {
  return Array.from(root.querySelectorAll<HTMLElement>('.loading, .loading-container, [aria-busy="true"]'))
    .some((element) => rendered(element, root))
}

function snapshot(root: HTMLElement, limit: number, includeReplies: boolean) {
  const rows = readRows(root)
  const eligible = rows.filter((row) => includeReplies || row.parent_comment_id === null)
  const state = commentState(initialState(), currentNoteId()!)
  const selected = eligible.slice(0, limit).map((row) => ({
    ...row,
    ...commentFields(state, row.comment_id, row.parent_comment_id, row.id_source === 'dom'),
  }))
  type EnrichedComment = typeof selected[number] & {
    subComments: EnrichedComment[] | null
    sub_comments_scope: 'returned_visible_replies' | 'unavailable'
    sub_comments_partial: boolean
  }
  // Keep the upstream reply field limited to the same returned DOM rows.
  // Hidden, unloaded and limit-excluded state replies must not leak into the result.
  const withReplies = (row: typeof selected[number], ancestors = new Set<string>()): EnrichedComment => {
    const ids = row.fields_scope === 'current_note_page_state' ? stateReplyIds(state, row.comment_id) : null
    const next = new Set(ancestors).add(row.comment_id)
    const replies = selected.filter((reply) => reply.parent_comment_id === row.comment_id
      && reply.fields_scope === 'current_note_page_state' && !next.has(reply.comment_id))
    return {
      ...row,
      subComments: ids ? replies.map((reply) => withReplies(reply, next)) : null,
      sub_comments_scope: ids ? 'returned_visible_replies' : 'unavailable',
      sub_comments_partial: ids === null || ids.length !== replies.length || ids.some((id) => !replies.some((reply) => reply.id === id)),
    }
  }
  const comments = selected.map((row) => withReplies(row))
  const total = metricText(root, '.total, .comments-total, .comment-count, .comments-header')
    ?? metricText(document, '.interact-container .chat-wrapper .count, .interact-container .chat-wrapper .count-num')
  return {
    note_id: currentNoteId(),
    comments,
    total_comments_text: total,
    loaded_parent_count: rows.filter((row) => row.parent_comment_id === null).length,
    loaded_reply_count: rows.filter((row) => row.parent_comment_id !== null).length,
    loaded_count: rows.length,
    returned_count: comments.length,
    truncated: eligible.length > limit || comments.some((row) => row.text_truncated),
    include_replies: includeReplies,
    comments_scope: 'currently_loaded_dom',
    comment_state_scope: state.scope,
    comment_state_partial: state.partial,
    cursor: state.cursor,
    hasMore: state.hasMore,
    id_policy: 'DOM IDs (with the site comment- prefix removed) when available; otherwise content signatures. Only exact IDs and parent relationships receive state fields; signatures are not server comment IDs.',
    end_of_comments_visible: endVisible(root),
    empty_comments_visible: emptyVisible(root),
    has_unexpanded_replies: expansionButtons(root).length > 0,
    completeness: 'Only currently rendered comments are returned. A list end marker does not establish that all replies are loaded.',
  }
}

function validateLimit(args: Record<string, unknown>) {
  const limit = args.limit === undefined ? 20 : Number(args.limit)
  return Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : null
}

function scrollContainer(root: HTMLElement): HTMLElement | null {
  const candidates = [root.closest<HTMLElement>('.note-scroller'), root]
  return candidates.find((element): element is HTMLElement => !!element && rendered(element) && element.scrollHeight > element.clientHeight && element.clientHeight > 0) ?? null
}

function rowKeys(root: HTMLElement): Set<string> {
  return new Set(readRows(root).map((row) => `${row.parent_comment_id ?? ''}/${row.comment_id}`))
}

export const xiaohongshuCommentTools: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  async xhs_read_comments(args) {
    const invalidPage = guard()
    if (invalidPage) return invalidPage
    const limit = validateLimit(args)
    if (!limit) return error('INVALID_LIMIT', 'limit must be an integer from 1 to 100.')
    if (args.include_replies !== undefined && typeof args.include_replies !== 'boolean') return error('INVALID_ARGUMENT', 'include_replies must be a boolean.')
    const root = commentRoot()
    if (!root) return error('COMMENTS_UNSUPPORTED', 'No recognizable visible comments container is present. Open or scroll to the comments section first.')
    const data = snapshot(root, limit, args.include_replies !== false)
    if (!data.loaded_count && !data.empty_comments_visible && !data.end_of_comments_visible) {
      return error('COMMENTS_NOT_READY', 'The comments section has no readable rows or explicit empty state yet.')
    }
    return result('ok', data)
  },

  async xhs_load_more_comments(args) {
    const invalidPage = guard()
    if (invalidPage) return invalidPage
    const limit = validateLimit(args)
    if (!limit) return error('INVALID_LIMIT', 'limit must be an integer from 1 to 100.')
    const maxRounds = args.max_rounds === undefined ? 2 : Number(args.max_rounds)
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5) return error('INVALID_ARGUMENT', 'max_rounds must be an integer from 1 to 5.')
    if (args.expand_replies !== undefined && typeof args.expand_replies !== 'boolean') return error('INVALID_ARGUMENT', 'expand_replies must be a boolean.')
    let root = commentRoot()
    if (!root) return error('COMMENTS_UNSUPPORTED', 'No recognizable visible comments container is present.')
    const noteId = currentNoteId()!
    const pageUrl = location.href
    const initiallySeen = rowKeys(root)
    const seen = new Set(initiallySeen)
    let stopReason = 'round_limit'
    let rounds = 0
    const actions: string[] = []
    for (let round = 0; round < maxRounds; round++) {
      const invalid = guard(noteId, pageUrl)
      if (invalid) return invalid
      const expand = args.expand_replies === true ? expansionButtons(root)[0] : undefined
      if (!expand && (endVisible(root) || emptyVisible(root))) { stopReason = 'end_of_list'; break }
      const before = rowKeys(root)
      if (expand) {
        expand.click()
        actions.push('expand_replies')
      } else {
        const container = scrollContainer(root)
        if (!container) {
          return { ...error('COMMENTS_SCROLL_UNSUPPORTED', 'No recognizable scrollable note/comments container is present.'), data: snapshot(root, limit, true) }
        }
        const previousTop = container.scrollTop
        container.scrollTop = container.scrollHeight
        actions.push(container.scrollTop !== previousTop ? 'scroll_changed' : 'scroll_unchanged')
      }
      rounds++
      let changed = false
      const started = Date.now()
      while (Date.now() - started < ROUND_TIMEOUT_MS) {
        const pageError = guard(noteId, pageUrl)
        if (pageError) return pageError
        const currentRoot = commentRoot()
        if (!currentRoot) return error('COMMENTS_UNSUPPORTED', 'The comments container disappeared while loading. Read the page again.')
        root = currentRoot
        const currentKeys = rowKeys(root)
        for (const key of currentKeys) seen.add(key)
        changed = Array.from(currentKeys).some((key) => !before.has(key))
        // A parent-list end marker can already be visible while a reply request is pending.
        if (changed || (!expand && (endVisible(root) || emptyVisible(root)))) break
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }
      if (!changed) {
        stopReason = !expand && (endVisible(root) || emptyVisible(root)) ? 'end_of_list' : loadingVisible(root) ? 'timeout' : 'no_new_comments'
        break
      }
      if (endVisible(root) && !(args.expand_replies === true && expansionButtons(root).length > 0)) {
        stopReason = 'end_of_list'; break
      }
    }
    const finalError = guard(noteId, pageUrl)
    if (finalError) return finalError
    const addedCount = Array.from(seen).filter((key) => !initiallySeen.has(key)).length
    return result('ok', {
      ...snapshot(root, limit, true),
      attempted_rounds: rounds,
      actions,
      added_count: addedCount,
      load_succeeded: addedCount > 0,
      stop_reason: stopReason,
    })
  },
}
