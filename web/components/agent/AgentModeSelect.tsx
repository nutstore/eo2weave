/**
 * AgentModeSelect - Three-state mode selector replacing the Plan/Act toggle.
 *
 * Modes:
 *   🔍 Plan  → agentMode='plan'                      (read-only, no writes)
 *   ⚡ Act   → agentMode='act', yolo off  (writes/external calls, each confirmed)
 *   🚀 YOLO  → agentMode='act', yolo on   (ALL prompt-level approvals skipped:
 *          external calls, disk writes, page-action writes — still URL-blacklist
 *          gated, never forbidden tools; conversation-scoped)
 *
 * Since PR-4 yolo generalizes beyond page-action tools (it also covers
 * call_tool and sync-to-disk), the option is shown EVERYWHERE — not only in
 * extension side-panel mode.
 *
 * The underlying system stays two-state (plan/act) + conversation-scoped
 * yolo (yolo-mode.store); this component maps the three visible options to
 * the correct combination and mirrors the legacy page-action flag for older
 * UI consumers.
 *
 * Design: compact pill button → popover with three options.
 */

import { useState, useRef, useEffect } from 'react'
import { usePageActionSessionStore } from '@/store/page-action-session.store'
import { useYoloModeStore, syncLegacyPageActionYolo } from '@/store/yolo-mode.store'
import { useConversationStoreSQLite } from '@/store/conversation.store.sqlite'
import { useT } from '@/i18n'

export interface AgentModeSelectProps {
  /** Current agent mode ('plan' | 'act') */
  mode: 'plan' | 'act'
  /** Callback when the agent mode should change */
  onModeChange: (mode: 'plan' | 'act') => void
  /** Whether the selector is disabled */
  disabled?: boolean
  /** Additional CSS class */
  className?: string
}

type VisibleMode = 'plan' | 'act' | 'yolo'

function modeDotClass(mode: VisibleMode): string {
  return mode === 'yolo' ? 'bg-warning' : 'bg-neutral-400'
}

const ChevronIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 5l3 3 3-3" />
  </svg>
)

const CheckIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 6.5l2.5 2.5 4.5-5" />
  </svg>
)

// ── Option rows for the dropdown ─────────────────────────────────────────────
function ModeOption({
  visibleMode,
  label,
  description,
  isSelected,
  onSelect,
}: {
  visibleMode: VisibleMode
  label: string
  description: string
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className="flex w-full items-start gap-2.5 px-3 py-2 text-left text-neutral-700 transition-colors hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-800"
    >
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${modeDotClass(visibleMode)}`} aria-hidden="true" />

      {/* Label + description */}
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium">
          {label}
        </div>
        <div className="mt-0.5 text-[11px] leading-tight text-neutral-500 dark:text-neutral-400">
          {description}
        </div>
      </div>

      {/* Check mark if selected */}
      {isSelected && (
        <CheckIcon className="mt-1 h-3.5 w-3.5 shrink-0 text-primary-600 dark:text-primary-400" />
      )}
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * Read the active conversation id non-reactively (indicator positioning only).
 * Store access goes through a guarded try/catch so the component module stays
 * loadable in isolation (tests): a failed store lookup degrades to null.
 */
function useConversationStoreSafeId(): string | null {
  try {
    return useConversationStoreSQLite.getState().activeConversationId
  } catch {
    return null
  }
}

export function AgentModeSelect({
  mode,
  onModeChange,
  disabled = false,
  className = '',
}: AgentModeSelectProps) {
  const t = useT()
  const pageActionYolo = usePageActionSessionStore((s) => s.pageActionYolo)
  const setPageActionYolo = usePageActionSessionStore((s) => s.setPageActionYolo)
  const yoloByConversation = useYoloModeStore((s) => s.yoloByConversation)
  const setYolo = useYoloModeStore((s) => s.setYolo)
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // YOLO used to be side-panel-only (it only affected page-action writes).
  // Since PR-4 it also covers external calls and disk writes in normal tabs,
  // so the option is always shown.
  const showYolo = true

  // Derive the visible mode from the underlying states. YOLO is now
  // conversation-scoped (yolo-mode.store); the legacy global flag is kept as
  // a shim and used only when no conversation is known.
  const activeConvId = useConversationStoreSafeId()
  const conversationYoloOn = activeConvId
    ? Boolean(yoloByConversation[activeConvId])
    : pageActionYolo
  const visibleMode: VisibleMode =
    mode === 'plan' ? 'plan' : (showYolo && conversationYoloOn) ? 'yolo' : 'act'

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const handleSelect = (target: VisibleMode) => {
    // YOLO is conversation-scoped (PR-4). Both stores are kept in sync: the
    // yolo-mode store is authoritative, the legacy page-action flag stays
    // updated so older UI consumers keep rendering correctly.
    const applyYolo = (on: boolean) => {
      setYolo(activeConvId, on)
      syncLegacyPageActionYolo(on)
    }
    if (target === 'plan') {
      // Switching to Plan: disable page writes and clear any prior YOLO approval.
      onModeChange('plan')
      applyYolo(false)
      setPageActionYolo(false)
    } else if (target === 'act') {
      // Switching to Act (confirmed): agentMode=act, yolo off
      onModeChange('act')
      applyYolo(false)
      setPageActionYolo(false)
    } else {
      // Switching to YOLO: agentMode=act, yolo on (this conversation only)
      onModeChange('act')
      applyYolo(true)
      setPageActionYolo(true)
    }
    setOpen(false)
  }

  const visibleLabel =
    visibleMode === 'plan'
      ? t('agent.mode.plan')
      : visibleMode === 'act'
        ? t('agent.mode.act')
        : t('agent.mode.yolo')

  return (
    <div ref={containerRef} className={`relative inline-flex shrink-0 ${className}`}>
      {/* Trigger button */}
      <button
        onClick={() => !disabled && setOpen((prev) => !prev)}
        disabled={disabled}
        aria-label={t('agent.mode.currentAriaLabel', { mode: visibleLabel })}
        className={`inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-1 text-[11px] font-medium text-neutral-600 transition-colors dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 ${
          disabled
            ? 'cursor-not-allowed opacity-40'
            : 'hover:bg-neutral-100 dark:hover:bg-neutral-700'
        }`}
      >
        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${modeDotClass(visibleMode)}`} />
        <span>{visibleLabel}</span>

        {/* Chevron (dropdown indicator) */}
        <ChevronIcon className={`h-3 w-3 opacity-50 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown */}
      {open && !disabled && (
        <div
          className={`
            absolute bottom-full left-0 z-50 mb-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border shadow-lg
            bg-white dark:bg-neutral-900
            border-neutral-200/80 dark:border-neutral-700/80
          `}
        >
          <ModeOption
            visibleMode="plan"
            label={t('agent.mode.plan')}
            description={t('agent.mode.planShort')}
            isSelected={visibleMode === 'plan'}
            onSelect={() => handleSelect('plan')}
          />
          <div className="border-t border-neutral-100 dark:border-neutral-800" />
          <ModeOption
            visibleMode="act"
            label={t('agent.mode.act')}
            description={t('agent.mode.actShort')}
            isSelected={visibleMode === 'act'}
            onSelect={() => handleSelect('act')}
          />
          <div className="border-t border-neutral-100 dark:border-neutral-800" />
          {showYolo && (
            <>
              <ModeOption
                visibleMode="yolo"
                label={t('agent.mode.yolo')}
                description={t('agent.mode.yoloShort')}
                isSelected={visibleMode === 'yolo'}
                onSelect={() => handleSelect('yolo')}
              />
            </>
          )}
        </div>
      )}
    </div>
  )
}
