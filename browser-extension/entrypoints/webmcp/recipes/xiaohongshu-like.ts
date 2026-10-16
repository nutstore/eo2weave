// Port LikeAction and getInteractState from xpzouying/xiaohongshu-mcp
// at 7797fd375aba02dcd33afe143f6bee13e5870859, using the current tab.
import { HOST, currentNoteId, navigation, result, error } from './xiaohongshu-page'
import { XHS_INTERACT_TIMEOUT_MS, sampleInputTiming } from '../xiaohongshu-input-protocol'
import { clickWithCdp } from './xiaohongshu-publish-input'

const LIKE_BUTTON = '.interact-container .left .like-lottie'
const READY = '.interact-container, .note-scroller, .access-wrapper, .error-wrapper, .not-found-wrapper, .blocked-wrapper'
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
class InteractStateError extends Error {}
interface InteractState {
  liked: boolean
  collected: boolean
  liked_field_present: boolean
  liked_raw: boolean | null
  liked_value_source: 'page_boolean' | 'upstream_go_bool_default' | 'upstream_go_null_ignored'
}

function readInteractState(feedId: string): InteractState {
  const state = (window as Window & { __INITIAL_STATE__?: { note?: { noteDetailMap?: unknown } } }).__INITIAL_STATE__
  // Preserve the upstream page expression. Evaluation/stringification failures
  // escape, like MustEval; returned missing/decoding errors permit the first click.
  const serialized = state && state.note && state.note.noteDetailMap ? JSON.stringify(state.note.noteDetailMap) : ''
  if (!serialized) throw new InteractStateError('No feed detail in __INITIAL_STATE__.note.noteDetailMap.')
  let map: unknown
  try { map = JSON.parse(serialized) } catch {
    throw new InteractStateError('Cannot decode serialized noteDetailMap as upstream JSON.')
  }
  const object = (value: unknown, path: string): Record<string, unknown> | null => {
    if (value === null) return null
    if (typeof value !== 'object' || Array.isArray(value)) throw new InteractStateError(`Cannot decode ${path} as the upstream Go object.`)
    return value as Record<string, unknown>
  }
  const entries = object(map, 'noteDetailMap')
  let target: InteractState | undefined
  // Go unmarshals the entire map, even entries other than the target. Known
  // struct fields match case-insensitively; absent/null booleans keep zero values.
  for (const [id, entry] of Object.entries(entries ?? {})) {
    const parsed: InteractState = { liked: false, collected: false, liked_field_present: false, liked_raw: null, liked_value_source: 'upstream_go_bool_default' }
    for (const [noteKey, note] of Object.entries(object(entry, 'detail') ?? {})) {
      if (noteKey.toLowerCase() !== 'note') continue
      for (const [infoKey, info] of Object.entries(object(note, 'note') ?? {})) {
        if (infoKey.toLowerCase() !== 'interactinfo') continue
        for (const [key, value] of Object.entries(object(info, 'interactInfo') ?? {})) {
          const field = key.toLowerCase()
          if (field !== 'liked' && field !== 'collected') continue
          if (value !== null && typeof value !== 'boolean') throw new InteractStateError(`Cannot decode interactInfo.${key} as the upstream Go bool.`)
          if (field === 'liked') {
            parsed.liked_field_present = true
            parsed.liked_raw = value as boolean | null
            parsed.liked_value_source = value === null ? 'upstream_go_null_ignored' : 'page_boolean'
          }
          if (value !== null) parsed[field] = value as boolean
        }
      }
    }
    if (id === feedId) target = parsed
  }
  if (!target) throw new InteractStateError('Requested feed is not in noteDetailMap.')
  return target
}

export const xiaohongshuLikeTools: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  async xhs_like_feed(args) {
    if (location.hostname !== HOST) return error('UNSUPPORTED_PAGE', 'Like notes in the current Xiaohongshu main-site tab.')
    for (const key of ['feed_id', 'xsec_token']) {
      if (typeof args[key] !== 'string' || args[key] === '') return error('INVALID_ARGUMENT', `Missing nonempty ${key} string.`)
    }
    const feedId = args.feed_id as string, unlike = args.unlike === true, want = !unlike
    if (currentNoteId() !== feedId) {
      const url = new URL(`https://${HOST}/explore/${encodeURIComponent(feedId)}`)
      url.searchParams.set('xsec_token', args.xsec_token as string)
      url.searchParams.set('xsec_source', 'pc_feed')
      const opening = navigation(url.href, 'Opening the target note; no like click performed. Rediscover tools, read the note, then call xhs_like_feed with the same arguments.')
      return { ...opening, data: { ...opening.data, feed_id: feedId, unlike, target_liked: want, click_attempted: false, state_verified: null } }
    }

    const pageUrl = location.href, pageDeadline = Date.now() + XHS_INTERACT_TIMEOUT_MS
    let phase = 'page_ready', clickAttempts = 0, completedClicks = 0, clickAttempted: boolean | null = false
    let before: InteractState | null = null, after: InteractState | null = null, initialStateError: string | null = null
    const guard = () => {
      if (location.href !== pageUrl || currentNoteId() !== feedId) throw new Error('The tab changed during the like operation.')
      if (Date.now() >= pageDeadline) throw new Error('Upstream 60-second interaction page budget expired.')
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
    const observation = (verified: boolean | null) => ({
      feed_id: feedId, unlike, target_liked: want, phase, click_attempts: clickAttempts,
      completed_clicks: completedClicks, click_attempted: clickAttempted, state_before: before, state_after: after,
      initial_state_error: initialStateError, state_verified: verified,
      verification_source: '__INITIAL_STATE__.note.noteDetailMap[feed_id].note.interactInfo',
      verification_timeout_ms: 4000, verification_poll_ms: 500, max_click_attempts: 2,
      verification_limitations: 'Upstream reads the exact note ID from serialized page state, not a server receipt or icon/count. Missing/null bools retain Go defaults; inspect liked_raw, liked_field_present and liked_value_source. Initial returned state errors still permit one click; a post-click state error stops without another click. State mismatch permits the upstream second click, not an automatic retry of a failed tool invocation.',
    })
    try {
      while (document.readyState !== 'complete') { guard(); await sleep(100) }
      await find(READY, Math.min(pageDeadline, Date.now() + 8000))
      await sleep(sampleInputTiming(0.41, 0.45, 600, 6000))
      guard()
      phase = 'reading_state'
      try { before = readInteractState(feedId) } catch (failure) {
        if (!(failure instanceof InteractStateError)) throw failure
        initialStateError = failure.message
      }
      guard()
      if (before?.liked === want) {
        phase = 'completed'
        return result('ok', { ...observation(true), success: true, skipped_noop: true, success_scope: 'upstream_initial_state_check' })
      }
      for (let attempt = 1; attempt <= 2; attempt++) {
        phase = 'clicking'
        const button = await find(LIKE_BUTTON, pageDeadline)
        if (!button) throw new Error('Like control unavailable after waiting.')
        guard()
        clickAttempts = attempt
        clickAttempted = null
        await clickWithCdp(button)
        completedClicks++
        clickAttempted = true
        phase = 'verifying'
        const deadline = Date.now() + 4000
        while (true) {
          guard()
          try { after = readInteractState(feedId) } catch (failure) {
            if (!(failure instanceof InteractStateError)) throw failure
            return { ...error('LIKE_STATE_UNAVAILABLE', failure.message), data: { ...observation(false), state_error: failure.message, success: false } }
          }
          if (after.liked === want) {
            await sleep(sampleInputTiming(0.88, 0.30, 2000, 3000))
            guard()
            phase = 'completed'
            return result('ok', { ...observation(true), success: true, skipped_noop: false, success_scope: 'upstream_state_check' })
          }
          if (Date.now() > deadline) break
          await sleep(500)
        }
      }
      return { ...error('LIKE_NOT_CONFIRMED', 'Page state did not reach the requested liked value after the upstream two-click policy. Inspect the webpage before retrying.'), data: { ...observation(false), success: false } }
    } catch (failure) {
      return { ...error(location.href !== pageUrl || currentNoteId() !== feedId ? 'PAGE_CHANGED' : 'LIKE_ACTION_FAILED', failure instanceof Error ? failure.message : 'Like action failed.'), data: { ...observation(null), success: null } }
    }
  },
}
