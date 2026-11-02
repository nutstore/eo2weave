import { useState, useEffect, useCallback, memo } from 'react'
import { ChevronDown } from 'lucide-react'
import { useT } from '@/i18n'

/**
 * Callback used to (un)register this button as the receiver of Virtuoso's
 * at-bottom state. ConversationView owns the registry ("hub") object and
 * passes the registration function here; ConversationMessages invokes the
 * registered listeners on every `atBottomStateChange`.
 */
export type VirtualAtBottomListener = (atBottom: boolean) => void
export type RegisterVirtualAtBottomListener = (cb: VirtualAtBottomListener | null) => void

/** Shared registry for Virtuoso at-bottom updates (owned by ConversationView). */
export interface VirtualAtBottomHub {
  listeners: Set<VirtualAtBottomListener>
}

interface ScrollToBottomButtonProps {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  isUserAtBottomRef: React.MutableRefObject<boolean>
  convId: string | undefined
  /** Message-list handle — the virtual-mode click delegates to its scrollToLastTurn. */
  virtuosoRef?: React.RefObject<{ scrollToLastTurn?: (behavior?: 'smooth' | 'auto') => void } | null>
  /** Whether the conversation is currently rendered through react-virtuoso. */
  isVirtualized?: boolean
  /** Registration channel for Virtuoso's atBottomStateChange (virtual mode). */
  registerVirtualAtBottomListener?: RegisterVirtualAtBottomListener
}

/**
 * Isolated scroll-to-bottom button.
 *
 * Manages its own visibility state so that scroll events do **not** cause
 * ConversationView (and therefore AgentRichInput) to re-render.
 *
 * Two at-bottom sources, never mixed (issue #141):
 * - Virtualized mode: react-virtuoso's `atBottomStateChange` →
 *   ConversationMessages → this component. Native DOM geometry is meaningless
 *   here: under virtual scrolling the DOM only holds the window slice, so
 *   `scrollHeight - scrollTop - clientHeight` disagrees with Virtuoso's own
 *   tracking and the button desyncs from the real position.
 * - Plain mode: native geometry via the scroll listener (unchanged behavior).
 */
export const ScrollToBottomButton = memo(function ScrollToBottomButton({
  scrollContainerRef,
  messagesEndRef: _messagesEndRef,
  isUserAtBottomRef,
  convId,
  virtuosoRef,
  isVirtualized = false,
  registerVirtualAtBottomListener,
}: ScrollToBottomButtonProps) {
  const t = useT()
  const [show, setShow] = useState(false)
  // null = no Virtuoso signal yet (button stays hidden, matching the previous
  // mount state); true/false = Virtuoso's last atBottomStateChange value.
  const [virtualAtBottom, setVirtualAtBottom] = useState<boolean | null>(null)

  // ── Virtualized mode: receive Virtuoso's at-bottom state ──
  useEffect(() => {
    if (!isVirtualized || !registerVirtualAtBottomListener) return
    const listener: VirtualAtBottomListener = (atBottom) => {
      isUserAtBottomRef.current = atBottom
      setVirtualAtBottom(atBottom)
    }
    registerVirtualAtBottomListener(listener)
    return () => {
      registerVirtualAtBottomListener(null)
      setVirtualAtBottom(null)
    }
  }, [isVirtualized, registerVirtualAtBottomListener, isUserAtBottomRef])

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
    return () => el.removeEventListener('scroll', handleScroll)
  }, [convId, scrollContainerRef, isUserAtBottomRef, isVirtualized])

  const handleClick = useCallback(() => {
    isUserAtBottomRef.current = true
    if (isVirtualized) {
      // Under virtual scrolling the DOM only holds the window slice, so a
      // raw scrollTop assignment cannot reach the real bottom — delegate to
      // the list handle, which routes through Virtuoso's scrollToIndex
      // (via the custom scroll parent). atBottomStateChange confirms once
      // the animation settles.
      virtuosoRef?.current?.scrollToLastTurn?.('smooth')
      // Optimistic hide, mirroring the plain path's immediate UX; Virtuoso
      // will re-affirm (or revoke) via atBottomStateChange.
      setVirtualAtBottom(true)
      return
    }
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
      className="absolute bottom-3 right-4 rounded-full bg-neutral-800/70 p-2 text-white shadow-lg backdrop-blur-sm transition-opacity hover:bg-neutral-700/80 dark:bg-neutral-200/70 dark:text-neutral-900 dark:hover:bg-neutral-200/90"
      title={t('conversation.buttons.scrollToBottom')}
    >
      <ChevronDown className="h-4 w-4" />
    </button>
  )
})
