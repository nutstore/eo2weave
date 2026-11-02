import { useState, useEffect, useCallback, memo } from 'react'
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

  // ── Virtualized mode: receive Virtuoso's at-bottom state via the hub ──
  useEffect(() => {
    if (!isVirtualized || !virtualAtBottomHub) return
    const listener: VirtualAtBottomListener = (atBottom) => {
      setVirtualAtBottom(atBottom)
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
    }
  }, [isVirtualized, virtualAtBottomHub])

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
      // Optimistic hide, mirroring the plain path's immediate UX; Virtuoso
      // will re-affirm (or revoke) via atBottomStateChange.
      setVirtualAtBottom(true)
      return
    }
    isUserAtBottomRef.current = true
    const el = scrollContainerRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [scrollContainerRef, isUserAtBottomRef, isVirtualized, virtuosoRef])

  // Visibility per mode — never derived from native geometry while
  // virtualized (that mixed-source desync is exactly the #141 bug).
  const showButton = isVirtualized ? virtualAtBottom === false : show

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
