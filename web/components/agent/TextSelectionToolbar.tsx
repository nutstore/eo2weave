/**
 * TextSelectionToolbar — selection actions for assistant message content.
 *
 * Selecting text inside a message content area raises a small floating menu
 * with Copy / Quote. Clipboard writes require an explicit Copy action.
 *
 * Quote hands the selection lines to the composer, which inserts them as a
 * quote block. The text sent to the model is the same markdown blockquote the
 * user sees (`> ` per line).
 *
 * The document-level `selectionchange` listener is a module-level SINGLETON
 * shared by all mounted instances: one listener total, which serializes the
 * selection (`selection.toString()`) at most once per event and dispatches only
 * to the container that owns the anchor node. (Previously every mounted message
 * added its own listener, so each selection change ran O(instances)
 * full-selection serializations.)
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Quote } from 'lucide-react'
import { useT } from '@/i18n'
import { toast } from 'sonner'
import { toQuotedSelection } from './selection-quote'

/** Minimum selection length to trigger the toolbar */
const MIN_SELECTION_LENGTH = 2

/** Debounce delay before the floating menu appears */
const MENU_DEBOUNCE_MS = 150

/** Gap between the selection and the floating menu, in px */
const MENU_GAP_PX = 8

/** Menu size, used only to keep it inside the viewport */
const MENU_WIDTH_PX = 148
const MENU_HEIGHT_PX = 36

export interface SelectionSnapshot {
  text: string
  rect: DOMRect
}

interface SelectionSubscriber {
  getContainer(): HTMLElement | null
  onSelectionChange: (snapshot: SelectionSnapshot | null) => void
}

const selectionSubscribers = new Set<SelectionSubscriber>()
let singletonListenerInstalled = false

function notifyAllSelectionEnd(): void {
  for (const subscriber of selectionSubscribers) subscriber.onSelectionChange(null)
}

function handleDocumentSelectionChange(): void {
  const selection = window.getSelection()
  const anchorNode = selection?.anchorNode
  if (!selection || selection.isCollapsed || !selection.rangeCount || !anchorNode) {
    notifyAllSelectionEnd()
    return
  }
  for (const subscriber of selectionSubscribers) {
    const container = subscriber.getContainer()
    if (!container || !container.contains(anchorNode)) continue
    // Serialize only once per event, and only when a container matches.
    const text = selection.toString().trim()
    if (text.length < MIN_SELECTION_LENGTH) {
      subscriber.onSelectionChange(null)
      return
    }
    subscriber.onSelectionChange({ text, rect: selection.getRangeAt(0).getBoundingClientRect() })
    return
  }
  notifyAllSelectionEnd()
}

function subscribeTextSelection(subscriber: SelectionSubscriber): () => void {
  selectionSubscribers.add(subscriber)
  if (!singletonListenerInstalled) {
    singletonListenerInstalled = true
    document.addEventListener('selectionchange', handleDocumentSelectionChange)
  }
  return () => {
    selectionSubscribers.delete(subscriber)
    if (selectionSubscribers.size === 0 && singletonListenerInstalled) {
      singletonListenerInstalled = false
      document.removeEventListener('selectionchange', handleDocumentSelectionChange)
    }
  }
}

/** Keep the menu next to the selection, flipping above it near the bottom edge. */
function menuPosition(rect: DOMRect): { top: number; left: number } {
  const maxLeft = Math.max(MENU_GAP_PX, window.innerWidth - MENU_WIDTH_PX - MENU_GAP_PX)
  const left = Math.min(Math.max(rect.left, MENU_GAP_PX), maxLeft)
  const below = rect.bottom + MENU_GAP_PX
  const top =
    below + MENU_HEIGHT_PX > window.innerHeight
      ? Math.max(MENU_GAP_PX, rect.top - MENU_HEIGHT_PX - MENU_GAP_PX)
      : below
  return { top, left }
}

export const TextSelectionToolbar = memo(function TextSelectionToolbar({
  containerRef,
  onQuote,
}: {
  containerRef: React.RefObject<HTMLElement | null>
  /** Insert the selection into the composer. Omit to hide the Quote action. */
  onQuote?: (lines: string[]) => void
}) {
  const t = useT()
  const [active, setActive] = useState<SelectionSnapshot | null>(null)
  const [trackingSelection, setTrackingSelection] = useState(false)
  const activeRef = useRef<SelectionSnapshot | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearMenuTimer = useCallback(() => {
    if (menuTimerRef.current) {
      clearTimeout(menuTimerRef.current)
      menuTimerRef.current = null
    }
  }, [])

  const closeMenu = useCallback(() => {
    clearMenuTimer()
    activeRef.current = null
    setActive(null)
    setTrackingSelection(false)
  }, [clearMenuTimer])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearMenuTimer()
    }
  }, [clearMenuTimer])

  const handleSelectionChange = useCallback(
    (snapshot: SelectionSnapshot | null) => {
      if (!snapshot) {
        closeMenu()
        return
      }

      // Start dismissal handling while the menu is still pending.
      setTrackingSelection(true)
      clearMenuTimer()
      menuTimerRef.current = setTimeout(() => {
        menuTimerRef.current = null
        activeRef.current = snapshot
        setActive(snapshot)
      }, MENU_DEBOUNCE_MS)
    },
    [clearMenuTimer, closeMenu]
  )

  useEffect(() => {
    return subscribeTextSelection({
      getContainer: () => containerRef.current,
      onSelectionChange: handleSelectionChange,
    })
  }, [containerRef, handleSelectionChange])

  // Cancel pending and visible menus on scroll, resize, outside click and Escape.
  useEffect(() => {
    if (!trackingSelection) return
    const handlePointerDown = (event: PointerEvent) => {
      const menu = menuRef.current
      if (menu && event.target instanceof globalThis.Node && menu.contains(event.target)) return
      closeMenu()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }
    const dismiss = () => closeMenu()

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [trackingSelection, closeMenu])

  const handleCopy = useCallback(async () => {
    const snapshot = activeRef.current
    if (!snapshot) return
    try {
      await navigator.clipboard.writeText(snapshot.text)
      toast.success(t('common.copied'), { duration: 1500 })
    } catch {
      // Silently ignore clipboard errors (e.g. permissions)
    }
    closeMenu()
  }, [closeMenu, t])

  const handleQuote = useCallback(() => {
    const snapshot = activeRef.current
    if (!snapshot || !onQuote) return
    const { lines } = toQuotedSelection(snapshot.text)
    closeMenu()
    if (lines.length === 0) return
    // Drop our own selection BEFORE handing over: the composer focuses itself
    // on insert, and clearing ranges afterwards would wipe that caret.
    window.getSelection()?.removeAllRanges()
    onQuote(lines)
  }, [closeMenu, onQuote])

  if (!active) return null

  const { top, left } = menuPosition(active.rect)

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 flex items-center gap-1 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
      style={{ top, left }}
      // Keep the selection alive while the user aims at the menu.
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        onClick={handleCopy}
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-700"
      >
        <Copy className="h-3 w-3" aria-hidden="true" />
        {t('common.copy')}
      </button>
      {onQuote && (
        <button
          type="button"
          onClick={handleQuote}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-700"
        >
          <Quote className="h-3 w-3" aria-hidden="true" />
          {t('common.quote')}
        </button>
      )}
    </div>,
    document.body
  )
})
