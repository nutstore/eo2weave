/**
 * streaming-markdown.ts — incremental Markdown rendering scheduler for streaming content.
 *
 * Problem: during LLM token streaming the content string updates at ~60fps.
 * Re-parsing the whole markdown through react-markdown + KaTeX on every frame
 * is expensive (long answers, big tables, math blocks) and causes jank.
 * Plain-text rendering is nearly free but loses all formatting mid-stream.
 *
 * Strategy — "plain 60fps + quiet-window markdown promotion":
 *
 *   - Small content (< STREAMING_MARKDOWN_IMMEDIATE_THRESHOLD): render markdown
 *     immediately on every update. Parsing cost is negligible at this size.
 *   - Large content (>= threshold): stay on the plain-text path while
 *     tokens keep arriving. When the content has been QUIET for a window
 *     (model pause — e.g. end of a paragraph), promote the current snapshot
 *     to markdown. A size-based backoff (`marksPerSecond`) keeps promotion
 *     rate proportional to incoming token rate.
 *   - While showing markdown, new tokens do NOT flash back to plain text:
 *     the snapshot is refreshed on a throttled cadence
 *     (STREAMING_MARKDOWN_MIN_UPDATE_MS). The throttle deadline is anchored to
 *     the last actual render (NOT reset on every token), so snapshot staleness
 *     stays bounded even under a steady high-rate token stream.
 *   - When the stream ends, the final content is rendered exactly once.
 *
 * The reducer is pure and deterministic — unit-testable without a DOM.
 */

/** Content below this size renders markdown immediately on every update. */
export const STREAMING_MARKDOWN_IMMEDIATE_THRESHOLD = 600
/** Min quiet window (ms) before promoting large content to markdown. */
export const STREAMING_MARKDOWN_QUIET_MS = 240
/** Min interval (ms) between markdown snapshot refreshes while streaming. */
export const STREAMING_MARKDOWN_MIN_UPDATE_MS = 150
/** Above this content length (chars), promotion is throttled by marksPerSecond. */
export const STREAMING_MARKDOWN_BACKOFF_THRESHOLD = 1200
/** Lower bound of marks-per-second backoff. */
export const STREAMING_MARKDOWN_MIN_MARKS_PER_SEC = 120
/** Upper bound of marks-per-second backoff. */
export const STREAMING_MARKDOWN_MAX_MARKS_PER_SEC = 800

export type StreamingMarkdownMode = 'plain' | 'markdown'

export interface StreamingMarkdownState {
  /** Which renderer the UI should use right now. */
  mode: StreamingMarkdownMode
  /** Latest raw content (source of truth for the plain-text path). */
  latest: string
  /** Content currently rendered by the markdown path ('' if never rendered). */
  snapshot: string
  /** Epoch ms at which a pending plain→markdown promotion should fire (null = none). */
  promotionAt: number | null
  /** Epoch ms at which a pending markdown snapshot refresh should fire (null = none). */
  refreshAt: number | null
  /** Epoch ms of the last actual markdown render. */
  lastMarkdownAt: number
}

export type StreamingMarkdownAction =
  | { type: 'token'; content: string; now: number }
  | { type: 'promotion_tick'; now: number }
  | { type: 'refresh_tick'; now: number }
  | { type: 'finish'; content: string; now: number }

export function createInitialStreamingMarkdownState(): StreamingMarkdownState {
  return {
    mode: 'plain',
    latest: '',
    snapshot: '',
    promotionAt: null,
    refreshAt: null,
    lastMarkdownAt: 0,
  }
}

/** Size-based promotion backoff: larger content → longer min interval. */
function promotionMinIntervalMs(contentLength: number): number {
  if (contentLength < STREAMING_MARKDOWN_BACKOFF_THRESHOLD) return 0
  const ratio = Math.min(1, contentLength / 4096)
  const marksPerSecond =
    STREAMING_MARKDOWN_MAX_MARKS_PER_SEC -
    ratio * (STREAMING_MARKDOWN_MAX_MARKS_PER_SEC - STREAMING_MARKDOWN_MIN_MARKS_PER_SEC)
  return 1000 / marksPerSecond
}

export function streamingMarkdownReducer(
  state: StreamingMarkdownState,
  action: StreamingMarkdownAction,
): StreamingMarkdownState {
  switch (action.type) {
    case 'token': {
      const { content, now } = action
      if (content === state.snapshot && state.mode === 'markdown') {
        // No change since last render — keep showing the markdown snapshot.
        return { ...state, latest: content }
      }

      // Small content: promote to markdown immediately (cheap to parse).
      if (content.length < STREAMING_MARKDOWN_IMMEDIATE_THRESHOLD) {
        return {
          mode: 'markdown',
          latest: content,
          snapshot: content,
          promotionAt: null,
          refreshAt: null,
          lastMarkdownAt: now,
        }
      }

      if (state.mode === 'markdown') {
        // Already showing markdown — schedule a throttled snapshot refresh
        // instead of flashing back to plain text.
        //
        // Throttle reset policy (NOT debounce): keep any pending deadline so a
        // steady token stream cannot starve the refresh forever, and anchor new
        // deadlines to the last actual render (lastMarkdownAt) instead of
        // "now". Resetting to now + MIN on every token would turn the throttle
        // into a debounce — under continuous tokens the snapshot would never
        // refresh until the stream ends.
        const dueAt = state.lastMarkdownAt + STREAMING_MARKDOWN_MIN_UPDATE_MS
        return {
          ...state,
          latest: content,
          refreshAt: state.refreshAt ?? (dueAt > now ? dueAt : now),
        }
      }

      // Plain path: schedule promotion after the quiet window (+ backoff).
      // Keep any already-pending deadline — re-anchoring to `now` on every
      // token (the old Math.max form) let a steady stream push promotion out
      // indefinitely (throttle degenerating into debounce).
      if (state.promotionAt !== null) {
        return { ...state, latest: content }
      }
      const minInterval = promotionMinIntervalMs(content.length)
      const earliest = now + STREAMING_MARKDOWN_QUIET_MS
      const promotionAt = Math.max(earliest, state.lastMarkdownAt + minInterval)
      return {
        ...state,
        latest: content,
        promotionAt,
        refreshAt: null,
      }
    }

    case 'promotion_tick': {
      const { now } = action
      if (state.mode !== 'plain' || state.promotionAt === null) return state
      if (now < state.promotionAt) {
        // Timer fired slightly early (setTimeout can fire 1-2ms early).
        // Keep the same deadline so the effect re-schedules — but the
        // deadline value is unchanged, so React won't re-render and the
        // effect won't re-run. Instead return a *later* deadline so the
        // effect dependency changes and re-schedules the timer.
        return { ...state, promotionAt: state.promotionAt + 16 }
      }
      return {
        mode: 'markdown',
        latest: state.latest,
        snapshot: state.latest,
        promotionAt: null,
        refreshAt: null,
        lastMarkdownAt: now,
      }
    }

    case 'refresh_tick': {
      const { now } = action
      if (state.mode !== 'markdown' || state.refreshAt === null) return state
      if (now < state.refreshAt) {
        // Same early-tick handling as promotion_tick (see above).
        return { ...state, refreshAt: state.refreshAt + 16 }
      }
      return {
        ...state,
        snapshot: state.latest,
        refreshAt: null,
        lastMarkdownAt: now,
      }
    }

    case 'finish': {
      return {
        mode: 'markdown',
        latest: action.content,
        snapshot: action.content,
        promotionAt: null,
        refreshAt: null,
        lastMarkdownAt: action.now,
      }
    }
  }
}

/** Result handed to the UI: which renderer to use and with what content. */
export interface StreamingMarkdownRender {
  /** True → render `content` with the markdown renderer. False → plain text. */
  renderMarkdown: boolean
  content: string
}
