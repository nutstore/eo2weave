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
        previewVirtualAtBottom: (atBottom: boolean) => void
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
  // at-bottom (jump landed) or (b) the interrupt detector (user gesture
  // moved the view away from the jump).
  const [jumpPending, setJumpPending] = useState(false)
  // Mirror for the scroll-listener effect (it must read the live flag without
  // re-subscribing on every jump).
  const jumpPendingRef = useRef(false)
  // Running scroll baseline for interrupted-jump detection: captured at click
  // time (before the animation starts) and advanced on every scroll toward
  // the bottom. The very first scroll event after a click — even one arriving
  // before any animation event — is thus compared against a real starting
  // position instead of being consumed as calibration, and every jump
  // re-captures it so no stale baseline leaks into the next jump.
  const interruptBaselineRef = useRef(0)
  // PR #142 review round 5 (Sourcery, Medium): scroll events alone cannot
  // tell a USER interruption (wheel, drag, touch, keyboard) from browser
  // scroll-anchoring / Virtuoso measurement corrections — both are bare
  // scroll events. Track recent user scroll intents with short-window
  // timestamps: a decrease counts as an interruption only when one fired.
  // Corrections arrive without any gesture and no longer cancel jumps.
  const lastUserScrollIntentAtRef = useRef(0)
  const USER_INTENT_WINDOW_MS = 200
  const markUserScrollIntent = useCallback(() => {
    lastUserScrollIntentAtRef.current = Date.now()
  }, [])
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
  // Virtuoso only broadcasts on at-bottom TRANSITIONS. The click previews
  // at-bottom on the follow path (followOutput re-enables immediately), but
  // Virtuoso's OWN state stays not-at-bottom until the animation lands —
  // so a jump interrupted by the user fires no transition and the jump
  // would otherwise stay pending forever. While a jump is pending, a scroll
  // event driven by a recent USER gesture that Virtuoso did not confirm as
  // a landing means the jump was interrupted (had it landed,
  // atBottomStateChange(true) would already have cleared jumpPending):
  // resynchronize the list AND hub with Virtuoso's actual at-bottom state
  // (not at bottom). Review round 5: bare scroll decreases caused by scroll
  // anchoring or measurement corrections carry no gesture and no longer
  // cancel the jump — the smooth animation replays them (settling).
  useEffect(() => {
    if (!isVirtualized || !virtualAtBottomHub) return
    const el = scrollContainerRef.current
    if (!el) return
    const markIntent = markUserScrollIntent
    const userIntentTargets = ['wheel', 'touchstart'] as const
    const onKeyDown = (event: KeyboardEvent) => {
      // Keys the browser maps to scrolling when the scroller (or something
      // inside it) has focus.
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        markIntent()
      }
    }
    for (const type of userIntentTargets) {
      el.addEventListener(type, markIntent, { passive: true })
    }
    el.addEventListener('keydown', onKeyDown)
    const handleInterrupt = () => {
      if (!jumpPendingRef.current) return
      // The baseline was captured when the jump started (handleClick), so a
      // scroll event moving TOWARD the bottom (scrollTop increasing — the
      // smooth animation itself, or momentum) only advances it. A scroll
      // moving AWAY from the bottom is only a genuine user interruption
      // when a user scroll gesture recently fired: bare decreases (scroll
      // anchoring, row-measurement corrections) are browser adjustments
      // and must not cancel the jump (review round 5).
      if (el.scrollTop >= interruptBaselineRef.current) {
        interruptBaselineRef.current = el.scrollTop
        return
      }
      if (Date.now() - lastUserScrollIntentAtRef.current > USER_INTENT_WINDOW_MS) return
      setJumpPendingBoth(false)
      // Funnel resync: ref + list state (followOutput off) + hub + listeners,
      // so the button re-shows and streaming no longer yanks the view.
      virtuosoRef?.current?.notifyVirtualAtBottom(false)
    }
    el.addEventListener('scroll', handleInterrupt, { passive: true })
    return () => {
      el.removeEventListener('scroll', handleInterrupt)
      for (const type of userIntentTargets) {
        el.removeEventListener(type, markIntent)
      }
      el.removeEventListener('keydown', onKeyDown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVirtualized, virtualAtBottomHub, scrollContainerRef, setJumpPendingBoth, virtuosoRef, markUserScrollIntent])

  const handleClick = useCallback(() => {
    if (isVirtualized) {
      // Preview at-bottom on the FOLLOW path only (review round 5): the
      // shared ref and the list's followOutput state re-enable so the next
      // appended turn is followed during the jump. The hub and its
      // listeners keep Virtuoso's last CONFIRMED position — writing the
      // optimistic true there let a stopped-short jump or a mid-jump
      // virtualized↔plain switch resubscribe to a never-confirmed value
      // and keep the button hidden with followOutput stuck on.
      virtuosoRef?.current?.previewVirtualAtBottom(true)
      // Under virtual scrolling the DOM only holds the window slice —
      // delegate to the list handle, which jumps to the true bottom of the
      // scroller (footer content included).
      virtuosoRef?.current?.scrollToLastTurn('smooth')
      // Capture the pre-jump scroll position: the interrupt detector compares
      // every scroll event against THIS value, so the first user scroll after
      // the click is already attributable (decreasing scrollTop = interruption)
      // without a throwaway calibration event (review round 4). Re-captured on
      // every click, so no baseline survives into the next jump. The click
      // itself opens the intent window: a genuine first user gesture after
      // the click also fires wheel/touch/key markers.
      interruptBaselineRef.current = scrollContainerRef.current?.scrollTop ?? 0
      markUserScrollIntent()
      // Optimistic hide WITHOUT touching the authoritative virtualAtBottom
      // (review round 3): the hub keeps Virtuoso's real not-at-bottom value,
      // so an interrupted jump can resync from it (see the scroll listener).
      setJumpPendingBoth(true)
      return
    }
    isUserAtBottomRef.current = true
    const el = scrollContainerRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [scrollContainerRef, isUserAtBottomRef, isVirtualized, virtuosoRef, setJumpPendingBoth, markUserScrollIntent])

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
