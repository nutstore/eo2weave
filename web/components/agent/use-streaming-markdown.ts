/**
 * use-streaming-markdown.ts — React hook wiring the pure streaming-markdown
 * reducer into a component lifecycle.
 *
 * The hook:
 *   1. Feeds every content change into the reducer ('token' action).
 *   2. Watches the reducer state for pending timers (`promotionAt` / `refreshAt`)
 *      and schedules a single `setTimeout` for the earliest one; when it fires,
 *      dispatches the corresponding tick action and lets the next state
 *      re-trigger scheduling. Timers are cleared on unmount / state change.
 *   3. Returns `renderMarkdown` + the content to render, so the caller can
 *      switch between the plain-text (60fps) and markdown renderers.
 *
 * Because every state transition flows through the reducer (pure), the timer
 * pump is derived: no manual re-scheduling bookkeeping, no stale-state reads.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  createInitialStreamingMarkdownState,
  streamingMarkdownReducer,
  type StreamingMarkdownState,
} from './streaming-markdown'

export interface UseStreamingMarkdownResult {
  /** True when the markdown renderer should be used for `content`. */
  renderMarkdown: boolean
  /** The content snapshot for the markdown renderer. */
  content: string
}

/**
 * @param content raw streaming content
 * @param streaming whether the stream is still active
 */
export function useStreamingMarkdown(
  content: string,
  streaming: boolean,
): UseStreamingMarkdownResult {
  const [state, setState] = useState<StreamingMarkdownState>(() =>
    createInitialStreamingMarkdownState(),
  )

  // ── Feed content changes into the reducer ──
  useEffect(() => {
    if (!streaming) {
      // Commit the final content when the stream ends (or on mount if never
      // streaming — e.g. a persisted step rendered for the first time).
      setState((prev) =>
        streamingMarkdownReducer(prev, { type: 'finish', content, now: Date.now() }),
      )
      return
    }
    setState((prev) => streamingMarkdownReducer(prev, { type: 'token', content, now: Date.now() }))
  }, [content, streaming])

  // ── Derived timer pump: schedule the earliest pending tick ──
  useEffect(() => {
    if (!streaming) return
    const s = state
    const pending: Array<{ at: number; type: 'promotion_tick' | 'refresh_tick' }> = []
    if (s.promotionAt !== null) pending.push({ at: s.promotionAt, type: 'promotion_tick' })
    if (s.refreshAt !== null) pending.push({ at: s.refreshAt, type: 'refresh_tick' })
    if (pending.length === 0) return

    pending.sort((a, b) => a.at - b.at)
    const next = pending[0]
    const delay = Math.max(0, next.at - Date.now())
    const timer = setTimeout(() => {
      setState((prev) => streamingMarkdownReducer(prev, { type: next.type, now: Date.now() }))
    }, delay)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.promotionAt, state.refreshAt, state.mode, streaming])

  return useMemo(
    () => ({
      renderMarkdown: state.mode === 'markdown',
      content: state.mode === 'markdown' ? state.snapshot : state.latest,
    }),
    [state.mode, state.snapshot, state.latest],
  )
}
