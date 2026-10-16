// Port ReplyToComment/findCommentElement and feed_detail.go search helpers from
// xpzouying/xiaohongshu-mcp at 7797fd375aba02dcd33afe143f6bee13e5870859.
import { HOST, currentNoteId, navigation, result, error } from './xiaohongshu-page'
import { XHS_REPLY_TIMEOUT_MS, sampleInputTiming } from '../xiaohongshu-input-protocol'
import { clickWithCdp, insertWithCdp, scrollIntoViewWithCdp, scrollWheelWithCdp } from './xiaohongshu-publish-input'
import { commentScrollDelta, commentScrollNotch, commentScrollInterval } from './xiaohongshu-comment-policy'
import { renderedTextContains } from './xiaohongshu-post-comment'

const ERROR_WRAPPERS = '.access-wrapper, .error-wrapper, .not-found-wrapper, .blocked-wrapper'
const READY = `.interact-container, .note-scroller, ${ERROR_WRAPPERS}`
const SCROLLERS = ['.note-scroller', '.comments-container']
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const betweenScroll = () => sleep(sampleInputTiming(-0.22, 0.40, 250, 3000))
const reading = () => sleep(sampleInputTiming(-0.36, 0.40, 300, 3000))
export const REPLY_SEARCH_POLICY = { maxScrolls: 25, maxExpandRounds: 5, durationMs: 90_000, stagnantChecks: 10 } as const

export const xiaohongshuReplyCommentTools: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  async xhs_reply_comment_in_feed(args) {
    if (location.hostname !== HOST) return error('UNSUPPORTED_PAGE', 'Reply in the current Xiaohongshu main-site tab.')
    for (const key of ['feed_id', 'xsec_token', 'content']) {
      if (typeof args[key] !== 'string' || args[key] === '') return error('INVALID_ARGUMENT', `Missing nonempty ${key} string.`)
    }
    // Upstream handlers ignore non-string optional IDs and require at least one.
    const commentId = typeof args.comment_id === 'string' ? args.comment_id : ''
    const userId = typeof args.user_id === 'string' ? args.user_id : ''
    if (!commentId && !userId) return error('INVALID_ARGUMENT', 'Missing comment_id or user_id.')
    const feedId = args.feed_id as string, content = args.content as string
    if (currentNoteId() !== feedId) {
      const target = new URL(`https://${HOST}/explore/${encodeURIComponent(feedId)}`)
      target.searchParams.set('xsec_token', args.xsec_token as string)
      target.searchParams.set('xsec_source', 'pc_feed')
      const opening = navigation(target.href, 'Opening the target note; no reply submitted. Rediscover tools, read the note, then call xhs_reply_comment_in_feed with the same arguments.')
      return { ...opening, data: { ...opening.data, feed_id: feedId, submission_attempted: false, comment_rendered: null } }
    }

    const pageUrl = location.href, pageDeadline = Date.now() + XHS_REPLY_TIMEOUT_MS
    let phase = 'page_ready', submissionAttempted: boolean | null = false, presentBefore: boolean | null = null
    let matchedBy: 'comment_id' | 'user_id' | null = null, matchedCommentId: string | null = null
    const search = { scroll_attempts: 0, expanded_controls: 0, expand_rounds: 0, stagnant_checks: 0,
      last_parent_count: 0, elapsed_ms: 0, stop_reason: null as string | null }
    const guard = () => {
      if (location.href !== pageUrl || currentNoteId() !== feedId) throw new Error('The tab changed during the reply operation.')
      if (Date.now() >= pageDeadline) throw new Error('Upstream five-minute reply page budget expired.')
    }
    const find = async (root: ParentNode, selector: string, until: number): Promise<HTMLElement | null> => {
      while (Date.now() < until) {
        guard()
        const element = root.querySelector<HTMLElement>(selector)
        if (element) return element
        await sleep(100)
      }
      return null
    }
    const lookup = async (): Promise<HTMLElement | null> => {
      if (commentId) {
        // CSS escaping preserves the supplied ID; it adds no matching rule.
        const exact = await find(document, `#${CSS.escape(`comment-${commentId}`)}`, Date.now() + 2000)
        if (exact) { matchedBy = 'comment_id'; return exact }
      }
      if (!userId) return null
      for (const row of document.querySelectorAll<HTMLElement>('.comment-item')) {
        if (await find(row, `[data-user-id="${CSS.escape(userId)}"]`, Date.now() + 500)) {
          matchedBy = 'user_id'; return row
        }
      }
      return null
    }
    const smartScroll = async (delta: number) => {
      let scroller: HTMLElement | undefined
      for (const selector of SCROLLERS) {
        const element = await find(document, selector, Date.now() + 2000)
        if (element?.getClientRects().length) { scroller = element; break }
      }
      for (let remaining = delta; remaining > 0;) {
        guard()
        const notch = Math.min(commentScrollNotch(), remaining)
        await scrollWheelWithCdp(notch, scroller)
        remaining -= notch
        if (remaining > 0) await sleep(commentScrollInterval())
      }
    }
    const scrollTop = () => {
      for (const selector of SCROLLERS) {
        const element = document.querySelector<HTMLElement>(selector)
        if (element && element.scrollHeight > element.clientHeight) return element.scrollTop
      }
      return window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0
    }
    const humanScroll = async () => {
      const before = scrollTop()
      await smartScroll(commentScrollDelta(window.innerHeight, 'normal', false))
      await sleep(150)
      if (scrollTop() - before <= 5) {
        await smartScroll(window.innerHeight * 3)
        await sleep(400)
      }
    }
    const expandNearby = async () => {
      const maxClick = 3 + Math.floor(Math.random() * 3)
      let clicked = 0
      for (const element of document.querySelectorAll<HTMLElement>('.show-more')) {
        if (clicked >= maxClick) break
        guard()
        const style = getComputedStyle(element), rect = element.getBoundingClientRect()
        // Port isElementClickable/isNearViewport/isSafeExpandButton, including
        // the upstream readable-size checks and exact reply-expansion labels.
        if (!element.getClientRects().length || style.display === 'none' || style.visibility === 'hidden'
          || rect.width < 24 || rect.height < 10 || rect.top <= -window.innerHeight || rect.top >= 2 * window.innerHeight
          || !/^展开\s*(\d+\s*条|更多)回复$/.test(element.innerText.trim())) continue
        for (let attempt = 0; attempt < 3; attempt++) {
          guard()
          try {
            await scrollIntoViewWithCdp(element)
            await reading()
            guard()
            await clickWithCdp(element)
            await reading()
            clicked++
            break
          } catch {
            guard()
            if (attempt < 2) await sleep(100 * 2 ** attempt + Math.floor(Math.random() * 200))
          }
        }
      }
      search.expanded_controls += clicked
      return clicked
    }
    const locate = async () => {
      const container = await find(document, '.comments-container', Date.now() + 2000)
      if (container) await scrollIntoViewWithCdp(container)
      await sleep(400)
      await smartScroll(100)
      await betweenScroll()
      const started = Date.now(), deadline = started + REPLY_SEARCH_POLICY.durationMs
      try {
        while (search.scroll_attempts < REPLY_SEARCH_POLICY.maxScrolls) {
          guard()
          if (Date.now() > deadline) { search.stop_reason = 'search_timeout'; return null }
          let target = await lookup()
          if (target) { search.stop_reason = 'matched'; return target }
          if (search.expand_rounds < REPLY_SEARCH_POLICY.maxExpandRounds && await expandNearby() > 0) {
            search.expand_rounds++
            await reading()
            target = await lookup()
            if (target) { search.stop_reason = 'matched'; return target }
            continue
          }
          search.expand_rounds = 0
          search.scroll_attempts++
          const end = await find(document, '.end-container', Date.now() + 2000)
          const endText = end?.innerText.trim().toUpperCase() ?? ''
          if (endText.includes('THE END') || endText.includes('THEEND')) { search.stop_reason = 'end_container'; return null }
          const count = document.querySelectorAll('.parent-comment').length
          if (count !== search.last_parent_count) { search.last_parent_count = count; search.stagnant_checks = 0 }
          else if (++search.stagnant_checks >= REPLY_SEARCH_POLICY.stagnantChecks) { search.stop_reason = 'stagnation'; return null }
          if (count > 0) {
            const rows = document.querySelectorAll<HTMLElement>('.comment-item')
            // Upstream ignores an unsuccessful last-row scroll, then uses the wheel.
            if (rows.length) { try { await scrollIntoViewWithCdp(rows[rows.length - 1]) } catch { guard() } }
            await betweenScroll()
          }
          await humanScroll()
          await betweenScroll()
        }
        search.stop_reason = 'scroll_limit'
        return null
      } finally { search.elapsed_ms = Date.now() - started }
    }
    const observation = (rendered: boolean | null) => ({
      feed_id: feedId, target_comment_id: commentId || null, target_user_id: userId || null,
      matched_by: matchedBy, matched_comment_id: matchedCommentId, content, phase,
      search: { ...search, policy: REPLY_SEARCH_POLICY }, submission_attempted: submissionAttempted,
      comment_rendered: rendered, text_present_before_submit: presentBefore,
      verification_scope: 'upstream_first_comments_container_innerText_includes_content',
      verification_timeout_ms: 4000, verification_poll_ms: 300,
      new_comment_id: null, new_comment_verified: null, author_verified: null, reply_relationship_verified: null,
      verification_limitations: 'Upstream checks substring presence in the first loaded comments container. Existing comments or replies can match; this does not establish a new reply ID, author or reply relationship. User-ID fallback uses the first matching comment-item, including descendants. No reload or scroll is performed during verification.',
    })
    try {
      while (document.readyState !== 'complete') { guard(); await sleep(100) }
      await find(document, READY, Math.min(pageDeadline, Date.now() + 8000))
      await sleep(sampleInputTiming(0.41, 0.45, 600, 6000))
      phase = 'page_accessibility'
      await sleep(500)
      const wrapper = await find(document, ERROR_WRAPPERS, Date.now() + 2000)
      const siteError = wrapper?.innerText.trim()
      if (siteError) return { ...error('NOTE_UNAVAILABLE', 'The site could not display this note; its error text does not establish the cause.'), data: { ...observation(null), site_error_message: siteError } }
      await sleep(2000)
      phase = 'finding_comment'
      const target = await locate()
      if (!target) return { ...error('COMMENT_NOT_FOUND', 'Target comment was not found within the upstream search policy; no reply submitted.'), data: { ...observation(null), success: false } }
      matchedCommentId = target.id.startsWith('comment-') ? target.id.slice('comment-'.length) : null
      phase = 'opening_reply'
      guard()
      await scrollIntoViewWithCdp(target)
      await betweenScroll()
      const reply = await find(target, '.right .interactions .reply', pageDeadline)
      if (!reply) throw new Error('Reply control unavailable after waiting.')
      guard()
      await clickWithCdp(reply)
      await sleep(sampleInputTiming(-0.92, 0.35, 150, 2000))
      phase = 'typing'
      const input = await find(document, 'div.input-box div.content-edit p.content-input', pageDeadline)
      if (!input) throw new Error('Reply input unavailable after waiting.')
      guard()
      await insertWithCdp(input, content)
      await sleep(sampleInputTiming(-0.51, 0.40, 200, 3000))
      phase = 'submitting'
      const submit = await find(document, 'div.bottom button.submit', pageDeadline)
      if (!submit) throw new Error('Submit control unavailable after waiting.')
      guard()
      presentBefore = renderedTextContains(content)
      submissionAttempted = null
      await clickWithCdp(submit)
      submissionAttempted = true
      await sleep(sampleInputTiming(-0.92, 0.35, 150, 2000))
      phase = 'verifying'
      const deadline = Date.now() + 4000
      while (Date.now() < deadline) {
        guard()
        if (renderedTextContains(content)) {
          phase = 'completed'
          return result('ok', { ...observation(true), success: true, success_scope: 'upstream_rendered_text_check' })
        }
        await sleep(300)
      }
      return { ...error('REPLY_NOT_CONFIRMED', 'Submitted reply text did not appear within the upstream verification window. Check the webpage before retrying; no automatic resubmission occurs.'), data: { ...observation(false), success: false } }
    } catch (failure) {
      return { ...error(location.href !== pageUrl || currentNoteId() !== feedId ? 'PAGE_CHANGED' : 'REPLY_ACTION_FAILED', failure instanceof Error ? failure.message : 'Reply action failed.'), data: { ...observation(null), success: null } }
    }
  },
}
