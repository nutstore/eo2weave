// Port PostComment and waitCommentRendered from xpzouying/xiaohongshu-mcp
// at 7797fd375aba02dcd33afe143f6bee13e5870859. Navigation yields to EO2's relay.
import { HOST, currentNoteId, navigation, result, error } from './xiaohongshu-page'
import { XHS_COMMENT_TIMEOUT_MS, sampleInputTiming } from '../xiaohongshu-input-protocol'
import { clickWithCdp, insertWithCdp } from './xiaohongshu-publish-input'

const ERROR_WRAPPERS = '.access-wrapper, .error-wrapper, .not-found-wrapper, .blocked-wrapper'
const READY = `.interact-container, .note-scroller, ${ERROR_WRAPPERS}`
const INPUT_ENTRY = 'div.input-box div.content-edit span'
const INPUT = 'div.input-box div.content-edit p.content-input'
const SUBMIT = 'div.bottom button.submit'
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function renderedTextContains(content: string): boolean {
  // Preserve upstream's first-container substring check, without scrolling,
  // navigating, comment-row matching, author inference or text normalization.
  return document.querySelector<HTMLElement>('.comments-container')?.innerText.includes(content) ?? false
}

export const xiaohongshuPostCommentTools: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  async xhs_post_comment_to_feed(args) {
    if (location.hostname !== HOST) return error('UNSUPPORTED_PAGE', 'Post comments in the current Xiaohongshu main-site tab.')
    // Upstream handlePostComment accepts nonempty strings without trimming or length limits.
    for (const key of ['feed_id', 'xsec_token', 'content']) {
      if (typeof args[key] !== 'string' || args[key] === '') return error('INVALID_ARGUMENT', `Missing nonempty ${key} string.`)
    }
    const feedId = args.feed_id as string, content = args.content as string
    if (currentNoteId() !== feedId) {
      const target = new URL(`https://${HOST}/explore/${encodeURIComponent(feedId)}`)
      target.searchParams.set('xsec_token', args.xsec_token as string)
      target.searchParams.set('xsec_source', 'pc_feed')
      const opening = navigation(target.href, 'Opening the target note in this tab; no comment was submitted. Rediscover tools, read the note, then call xhs_post_comment_to_feed with the same arguments.')
      return { ...opening, data: { ...opening.data, feed_id: feedId, submission_attempted: false, comment_rendered: null } }
    }

    const pageUrl = location.href, deadline = Date.now() + XHS_COMMENT_TIMEOUT_MS
    let phase = 'page_ready', submissionAttempted: boolean | null = false, presentBefore: boolean | null = null
    const guard = () => {
      // A bound tab may still navigate while awaiting browser input. Do not write
      // into a different document or attribute its comments to the requested note.
      if (location.href !== pageUrl || currentNoteId() !== feedId) throw new Error('The tab changed during the comment operation.')
    }
    const find = async (selector: string, until: number): Promise<HTMLElement | null> => {
      while (Date.now() < until) {
        guard()
        const element = document.querySelector<HTMLElement>(selector)
        if (element) return element
        await sleep(100)
      }
      return null
    }
    const required = async (selector: string): Promise<HTMLElement> => {
      const element = await find(selector, deadline)
      if (!element) throw new Error(`Website control unavailable after waiting: ${selector}.`)
      return element
    }
    const observation = (rendered: boolean | null) => ({
      feed_id: feedId, content, phase, submission_attempted: submissionAttempted,
      comment_rendered: rendered, text_present_before_submit: presentBefore,
      verification_scope: 'upstream_first_comments_container_innerText_includes_content',
      verification_timeout_ms: 4000, verification_poll_ms: 300,
      new_comment_id: null, new_comment_verified: null, author_verified: null,
      verification_limitations: 'Substring presence after submission is the upstream check. It may match a pre-existing comment or a reply; it does not identify a new comment or its author. No reload or scroll is performed.',
    })
    try {
      // waitFeedPageReady: wait for load, then up to eight seconds for a key
      // container; missing readiness containers do not block later selectors.
      while (document.readyState !== 'complete' && Date.now() < deadline) { guard(); await sleep(100) }
      await find(READY, Math.min(deadline, Date.now() + 8000))
      await sleep(sampleInputTiming(0.41, 0.45, 600, 6000))
      phase = 'page_accessibility'
      await sleep(500)
      const wrapper = await find(ERROR_WRAPPERS, Math.min(deadline, Date.now() + 2000))
      const siteError = wrapper?.innerText.trim()
      if (siteError) return { ...error('NOTE_UNAVAILABLE', 'The site could not display this note; its error text does not establish the cause.'), data: { ...observation(null), site_error_message: siteError } }

      phase = 'opening_input'
      await clickWithCdp(await required(INPUT_ENTRY))
      await sleep(sampleInputTiming(-0.92, 0.35, 150, 2000))
      phase = 'typing'
      await insertWithCdp(await required(INPUT), content)
      await sleep(sampleInputTiming(-0.51, 0.40, 200, 3000))
      phase = 'submitting'
      const submit = await required(SUBMIT)
      guard()
      presentBefore = renderedTextContains(content)
      // If CDP fails after pressing the mouse, delivery may already have happened.
      submissionAttempted = null
      await clickWithCdp(submit)
      submissionAttempted = true
      await sleep(sampleInputTiming(-0.92, 0.35, 150, 2000))
      phase = 'verifying'
      const verificationDeadline = Date.now() + 4000
      while (Date.now() < verificationDeadline) {
        guard()
        if (renderedTextContains(content)) {
          phase = 'completed'
          return result('ok', { ...observation(true), success: true, success_scope: 'upstream_rendered_text_check' })
        }
        await sleep(300)
      }
      return { ...error('COMMENT_NOT_CONFIRMED', 'After submission, the requested text did not appear in the loaded comments within the upstream verification window. Check the webpage before any retry; no automatic resubmission is performed.'), data: { ...observation(false), success: false } }
    } catch (failure) {
      return { ...error(location.href !== pageUrl || currentNoteId() !== feedId ? 'PAGE_CHANGED' : 'COMMENT_ACTION_FAILED', failure instanceof Error ? failure.message : 'Comment action failed.'), data: { ...observation(null), success: null } }
    }
  },
}
