import { useState, useEffect, useCallback, useRef, memo } from 'react'
import { ChevronDown } from 'lucide-react'
import { useT } from '@/i18n'

/**
 * Callback receiving Virtuoso's at-bottom state. ConversationMessages invokes
 * the listeners registered on the hub on every `atBottomStateChange`.
 */
export type VirtualAtBottomListener = (atBottom: boolean) => void

/**
 * Shared registry for Virtuoso at-bottom updates (owned by ConversationView).
 *
 * `lastAtBottom` replays the most recent broadcast to late subscribers: a
 * Virtuoso signal that arrived before a subscriber's effect ran is not lost,
 * so the button never stays stuck on its initial "no signal" state.
 */
export interface VirtualAtBottomHub {
  listeners: Set<VirtualAtBottomListener>
  /** Last value broadcast through the funnel; null before Virtuoso's first signal. */
  lastAtBottom: boolean | null
}

/**
 * Props form for virtualized mode (isVirtualized: true). Under virtual
 * scrolling the DOM only holds the window slice, so the click must delegate
 * to the message-list handle and visibility must track Virtuoso via the hub —
 * both are required, hence non-optional here.
 */
interface ScrollToBottomButtonVirtualProps {
  /** Message-list handle — the virtual-mode click delegates to it. */
  virtuosoRef: React.RefObject<
    | {
        scrollToLastTurn: (behavior?: 'smooth' | 'auto') => void
        notifyVirtualAtBottom: (atBottom: boolean) => void
      }
    | null
  >
  /** Whether the conversation is currently rendered through react-virtuoso. */
  isVirtualized: true
  /** Shared hub receiving Virtuoso's atBottomStateChange (virtual mode). */
  virtualAtBottomHub: VirtualAtBottomHub
}

/** Props form for plain mode (isVirtualized: false/omitted) — native geometry. */
interface ScrollToBottomButtonPlainProps {
  virtuosoRef?: undefined
  isVirtualized?: false
  virtualAtBottomHub?: undefined
}

type ScrollToBottomButtonProps = ScrollToBottomButtonPropsBase &
  (ScrollToBottomButtonVirtualProps | ScrollToBottomButtonPlainProps)

interface ScrollToBottomButtonPropsBase {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  isUserAtBottomRef: React.MutableRefObject<boolean>
  convId: string | undefined
}

/**
 * Isolated scroll-to-bottom button.
 *
 * Manages its own visibility state so that scroll events do **not** cause
 * ConversationView (and therefore AgentRichInput) to re-render.
 *
 * Two at-bottom sources, never mixed (issue #141):
 * - Virtualized mode: react-virtuoso's `atBottomStateChange` →
 *   ConversationMessages → the hub → this component. Native DOM geometry is
 *   meaningless here: under virtual scrolling the DOM only holds the window
 *   slice, so `scrollHeight - scrollTop - clientHeight` disagrees with
 *   Virtuoso's own tracking and the button desyncs from the real position.
 * - Plain mode: native geometry via the scroll listener (unchanged behavior).
 */
export const ScrollToBottomButton = memo(function ScrollToBottomButton({
  scrollContainerRef,
  messagesEndRef: _messagesEndRef,
  isUserAtBottomRef,
  convId,
  virtuosoRef,
  isVirtualized,
  virtualAtBottomHub,
}: ScrollToBottomButtonProps) {
  const t = useT()
  const [show, setShow] = useState(false)
  // null = no Virtuoso signal yet (button stays hidden, matching the previous
  // mount state); true/false = Virtuoso's last atBottomStateChange value.
  const [virtualAtBottom, setVirtualAtBottom] = useState<boolean | null>(null)
  // PR #142 review (Sourcery, Medium): after a click we hide the button
  // optimistically while the smooth jump is in flight, WITHOUT overwriting
  // the authoritative virtualAtBottom — Virtuoso still reports not-at-bottom
  // until the animation lands, so writing true here would desync the state:
  // an interrupted jump (user scrolls up mid-animation) produces no
  // atBottomStateChange transition and the stale `true` kept the button
  // hidden forever. jumpPending is cleared by (a) Virtuoso confirming
  // at-bottom (jump landed) or (b) a scroll event on the container while
  // Virtuoso is still not-at-bottom (jump interrupted → resync & re-show).
  const [jumpPending, setJumpPending] = useState(false)
  // Mirror for the scroll-listener effect (it must read the live flag without
  // re-subscribing on every jump).
  const jumpPendingRef = useRef(false)
  const setJumpPendingBoth = useCallback((v: boolean) => {
    jumpPendingRef.current = v
    setJumpPending(v)
  }, [])

  // ── Virtualized mode: receive Virtuoso's at-bottom state via the hub ──
  useEffect(() => {
    if (!isVirtualized || !virtualAtBottomHub) return
    const listener: VirtualAtBottomListener = (atBottom) => {
      setVirtualAtBottom(atBottom)
      // Virtuoso's verdict always ends the optimistic jump — true (landed)
      // and false (a real interruption Virtuoso did report) alike.
      setJumpPendingBoth(false)
    }
    virtualAtBottomHub.listeners.add(listener)
    // Replay the last broadcast: Virtuoso may have reported a state change
    // before this effect registered (e.g. on a virtualized↔plain mode switch
    // that remounts this subscription). Without the replay the button would
    // hide on a stale `null` until the next scroll event.
    if (virtualAtBottomHub.lastAtBottom !== null) {
      setVirtualAtBottom(virtualAtBottomHub.lastAtBottom)
    }
    return () => {
      virtualAtBottomHub.listeners.delete(listener)
      setVirtualAtBottom(null)
      setJumpPendingBoth(false)
    }
  }, [isVirtualized, virtualAtBottomHub, setJumpPendingBoth])

  // ── Plain mode: native geometry scroll listener ──
  useEffect(() => {
    if (isVirtualized) return
    const el = scrollContainerRef.current
    if (!el) return
    const handleScroll = () => {
      const threshold = 80
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
      isUserAtBottomRef.current = atBottom
      setShow(!atBottom)
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    // Compute once at setup so the initial visibility (and the value left
    // behind by a virtualized→plain mode switch) is derived from the current
    // geometry instead of staying stale until the first scroll event.
    handleScroll()
    return () => el.removeEventListener('scroll', handleScroll)
  }, [convId, scrollContainerRef, isUserAtBottomRef, isVirtualized])

  // ── Virtualized mode: interrupted-jump resync (PR #142 review round 3) ──
  // Virtuoso only broadcasts on at-bottom TRANSITIONS. The click pushes the
  // optimistic at-bottom through the funnel (to re-enable followOutput), but
  // Virtuoso's OWN state stays not-at-bottom until the animation lands — so
  // a jump interrupted by scrolling up fires no transition and the stale
  // optimistic `true` kept the button hidden forever. While a jump is
  // pending, a scroll event that Virtuoso did not confirm as a landing means
  // the jump was interrupted (had it landed, atBottomStateChange(true) would
  // already have cleared jumpPending): resynchronize the list AND hub with
  // Virtuoso's actual at-bottom state (not at bottom).
  useEffect(() => {
    if (!isVirtualized || !virtualAtBottomHub) return
    const el = scrollContainerRef.current
    if (!el) return
    let lastTop = 0
    let seen = false
    const handleInterrupt = () => {
      if (!jumpPendingRef.current) return
      // First scroll event after the click just calibrates the baseline —
      // the smooth animation itself fires scroll events while it runs, and
      // those move TOWARD the bottom. Only a scroll moving AWAY from the
      // bottom (scrollTop decreasing) is a genuine user interruption.
      if (!seen) {
        seen = true
        lastTop = el.scrollTop
        return
      }
      if (el.scrollTop >= lastTop) {
        lastTop = el.scrollTop
        return
      }
      setJumpPendingBoth(false)
      // Funnel resync: ref + list state (followOutput off) + hub + listeners,
      // so the button re-shows and streaming no longer yanks the view.
      virtuosoRef?.current?.notifyVirtualAtBottom(false)
    }
    el.addEventListener('scroll', handleInterrupt, { passive: true })
    return () => el.removeEventListener('scroll', handleInterrupt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVirtualized, virtualAtBottomHub, scrollContainerRef, setJumpPendingBoth, virtuosoRef])

  const handleClick = useCallback(() => {
    if (isVirtualized) {
      // Push at-bottom back through ConversationMessages' funnel FIRST, so
      // its `isUserAtBottom` state (which followOutput reads) re-enables and
      // the next appended turn is followed. Writing only the shared ref is
      // not enough: followOutput reads the list component's state.
      virtuosoRef?.current?.notifyVirtualAtBottom(true)
      // Under virtual scrolling the DOM only holds the window slice —
      // delegate to the list handle, which jumps to the true bottom of the
      // scroller (footer content included).
      virtuosoRef?.current?.scrollToLastTurn('smooth')
      // Optimistic hide WITHOUT overwriting the authoritative virtualAtBottom
      // (review round 3): the hub keeps Virtuoso's real not-at-bottom value,
      // so an interrupted jump can resync from it (see the scroll listener).
      setJumpPendingBoth(true)
      return
    }
    isUserAtBottomRef.current = true
    const el = scrollContainerRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [scrollContainerRef, isUserAtBottomRef, isVirtualized, virtuosoRef, setJumpPendingBoth])

  // Visibility per mode — never derived from native geometry while
  // virtualized (that mixed-source desync is exactly the #141 bug).
  // jumpPending hides the button optimistically during the smooth jump;
  // virtualAtBottom keeps Virtuoso's authoritative value the whole time.
  const showButton = isVirtualized ? virtualAtBottom === false && !jumpPending : show

  if (!showButton) return null

  return (
    <button
      type="button"
      onClick={handleClick}
      data-testid="scroll-to-bottom"
      className="absolute bottom-3 right-4 rounded-full bg-neutral-800/70 p-2 text-white shadow-lg backdrop-blur-sm transition-opacity hover:bg-neutral-700/80 dark:bg-neutral-200/70 dark:text-neutral-900 dark:hover:bg-neutral-200/90"
      title={t('conversation.buttons.scrollToBottom')}
    >
      <ChevronDown className="h-4 w-4" />
    </button>
  )
})
