/**
 * ContextUsageBar — compact context window usage indicator.
 *
 * Direction-4 redesign: a mini conic-gradient donut replaces the straight bar.
 * The donut is pure CSS (conic-gradient + ::after mask hole) so no extra
 * dependency is introduced. Tone (teal / amber / red) follows the same
 * thresholds as before (>=95 danger, >=85 warning).
 */

import { useT } from '@/i18n'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import type { ContextWindowUsage } from '@/agent/message-types'

interface ContextUsageBarProps {
  contextWindowUsage: ContextWindowUsage | null
  isProcessing: boolean
}

export function ContextUsageBar({
  contextWindowUsage,
  isProcessing,
}: ContextUsageBarProps) {
  const t = useT()

  const getUsageToneClass = (usagePercent: number): { text: string; label: string } => {
    if (usagePercent >= 95) {
      return { text: 'text-danger dark:text-danger', label: t('conversation.usage.highRisk') }
    }
    if (usagePercent >= 85) {
      return {
        text: 'text-warning dark:text-warning',
        label: t('conversation.usage.nearLimit'),
      }
    }
    return {
      text: 'text-neutral-600 dark:text-neutral-300',
      label: t('conversation.usage.comfortable'),
    }
  }

  const formatTokenCompact = (value: number): string => {
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
    return `${value}`
  }

  if (!contextWindowUsage) return null

  const reserveTokens = contextWindowUsage.reserveTokens
  const modelMaxTokens = contextWindowUsage.modelMaxTokens ?? contextWindowUsage.maxTokens + reserveTokens
  const displayPercent = Math.max(0, Math.min(100, (contextWindowUsage.usedTokens / modelMaxTokens) * 100))
  const usageTone = getUsageToneClass(displayPercent)

  const donutColorClass =
    displayPercent >= 95
      ? 'text-danger dark:text-danger'
      : displayPercent >= 85
        ? 'text-warning dark:text-warning'
        : 'text-primary-500 dark:text-primary-400'

  const tooltip = t('conversation.tokenBudget', {
    effectiveBudget: contextWindowUsage.maxTokens,
    modelMaxTokens,
    reserveTokens,
  })

  return (
    <div className="flex shrink-0 items-center gap-1.5 sm:gap-2.5">
      <span
        role="img"
        aria-label={usageTone.label}
        title={usageTone.label}
        style={{ '--usage-percent': displayPercent } as CSSProperties}
        className={cn('usage-donut shrink-0', donutColorClass)}
      />
      <span className={cn('text-[11px] font-semibold tabular-nums sm:text-xs', usageTone.text)}>
        {displayPercent.toFixed(0)}%
      </span>

      {/* Token counts: hidden on narrow screens — they alone made the toolbar
          wrap on mobile. The tooltip on the donut still carries the detail. */}
      <span
        className="hidden text-[11px] tabular-nums text-neutral-500 dark:text-neutral-400 sm:inline"
        title={tooltip}
      >
        {formatTokenCompact(contextWindowUsage.usedTokens)}
        <span className="mx-0.5 opacity-50">/</span>
        {formatTokenCompact(modelMaxTokens)}
      </span>

      {isProcessing && (
        <span className="dark:bg-primary-500 h-1.5 w-1.5 animate-pulse rounded-full bg-primary-500" />
      )}
    </div>
  )
}
