/**
 * RunEndPolicySelect - choose how eligible file changes are handled when a run ends.
 *
 * This is intentionally controlled: persistence and run lifecycle integration live
 * above the component, so callers own the selected policy and change handler.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { useT } from '@/i18n'

export type RunEndPolicy = 'manual' | 'auto'

export interface RunEndPolicySelectProps {
  /** Policy evaluated when the current agent run completes normally. */
  runEndPolicy: RunEndPolicy
  /** Called after the user chooses a different end-of-run policy. */
  onRunEndPolicyChange: (policy: RunEndPolicy) => void
  /** Prevent policy changes while the surrounding experience is unavailable. */
  disabled?: boolean
  className?: string
}

const POLICIES: RunEndPolicy[] = ['manual', 'auto']

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5l3 3 3-3" />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 6.5l2.5 2.5 4.5-5" />
    </svg>
  )
}

export function RunEndPolicySelect({
  runEndPolicy,
  onRunEndPolicyChange,
  disabled = false,
  className = '',
}: RunEndPolicySelectProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Partial<Record<RunEndPolicy, HTMLButtonElement | null>>>({})
  const pendingFocusPolicyRef = useRef<RunEndPolicy>(runEndPolicy)
  const menuId = useId()
  const isOpen = open && !disabled

  const labelFor = (policy: RunEndPolicy) =>
    policy === 'manual' ? t('agent.runEndPolicy.manual') : t('agent.runEndPolicy.auto')
  const descriptionFor = (policy: RunEndPolicy) =>
    policy === 'manual'
      ? t('agent.runEndPolicy.manualDescription')
      : t('agent.runEndPolicy.autoDescription')

  useEffect(() => {
    if (disabled) {
      setOpen(false)
    }
  }, [disabled])

  useEffect(() => {
    if (!isOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    optionRefs.current[pendingFocusPolicyRef.current]?.focus()
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [isOpen])

  const openMenu = (initialFocusPolicy: RunEndPolicy = runEndPolicy) => {
    if (disabled) return
    pendingFocusPolicyRef.current = initialFocusPolicy
    setOpen(true)
  }

  const closeAndRestoreFocus = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const handleSelect = (policy: RunEndPolicy) => {
    onRunEndPolicyChange(policy)
    closeAndRestoreFocus()
  }

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, policy: RunEndPolicy) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeAndRestoreFocus()
      return
    }

    // Let the browser continue its normal tab order, but do not leave an
    // orphaned menu visible after focus has moved outside this control.
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }

    let targetIndex: number | null = null
    const index = POLICIES.indexOf(policy)
    if (event.key === 'ArrowDown') targetIndex = (index + 1) % POLICIES.length
    if (event.key === 'ArrowUp') targetIndex = (index - 1 + POLICIES.length) % POLICIES.length
    if (event.key === 'Home') targetIndex = 0
    if (event.key === 'End') targetIndex = POLICIES.length - 1

    if (targetIndex !== null) {
      event.preventDefault()
      optionRefs.current[POLICIES[targetIndex]]?.focus()
    }
  }

  const currentLabel = labelFor(runEndPolicy)

  /** Auto gets a teal tint (actively applying changes); manual stays gray. */
  const triggerClass =
    runEndPolicy === 'auto'
      ? 'bg-primary-100/60 text-primary-700 dark:bg-primary-100/15 dark:text-primary-300'
      : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'

  return (
    <div ref={containerRef} className={`relative inline-flex shrink-0 ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-controls={isOpen ? menuId : undefined}
        aria-expanded={isOpen}
        aria-label={t('agent.runEndPolicy.currentAriaLabel', { policy: currentLabel })}
        onClick={() => {
          if (isOpen) {
            setOpen(false)
          } else {
            openMenu()
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            openMenu(POLICIES[0])
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            openMenu(POLICIES[POLICIES.length - 1])
          }
        }}
        className={`inline-flex h-7 min-h-0 shrink-0 items-center gap-1 rounded-full border-none px-2 text-[11px] font-medium transition-colors sm:h-auto sm:min-h-8 sm:gap-1.5 sm:px-2.5 ${triggerClass} ${
          disabled
            ? 'cursor-not-allowed opacity-40'
            : 'hover:brightness-95 dark:hover:brightness-110'
        } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900`}
      >
        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${runEndPolicy === 'auto' ? 'bg-primary-500' : 'bg-neutral-400'}`} />
        <span>{currentLabel}</span>
        <ChevronIcon className={`h-3 w-3 text-neutral-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div
          id={menuId}
          role="menu"
          aria-label={t('agent.runEndPolicy.menuLabel')}
          className="absolute bottom-full left-0 z-50 mb-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          {POLICIES.map((policy) => {
            const selected = policy === runEndPolicy
            return (
              <button
                key={policy}
                ref={(element) => { optionRefs.current[policy] = element }}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => handleSelect(policy)}
                onKeyDown={(event) => handleOptionKeyDown(event, policy)}
                className="flex w-full items-start gap-2.5 px-3 py-2 text-left text-neutral-700 transition-colors hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
              >
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${policy === 'auto' ? 'bg-primary-500' : 'bg-neutral-400'}`} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium">{labelFor(policy)}</span>
                  <span className="mt-0.5 block break-words text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">
                    {descriptionFor(policy)}
                  </span>
                </span>
                {selected && <CheckIcon className="mt-1 h-3.5 w-3.5 shrink-0 text-primary-600 dark:text-primary-400" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
