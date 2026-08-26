/**
 * ConversationUsageBar - sticky bar at the top of the conversation showing
 * cumulative token usage across all turns (all agent loops).
 *
 * Aggregates from EVERY assistant message in the conversation:
 *  - input  (non-cache prompt tokens)
 *  - output (completion tokens)
 *  - cache  (cached prompt tokens, discounted by most providers)
 *
 * Renders as a 3-segment stacked horizontal bar with a cost estimate
 * sourced from OpenRouter's public /api/v1/models pricing data.
 * Cost display currency is build-time selected: USD on the international
 * build, RMB (converted at a fixed indicative rate) on the CN build —
 * see lib/currency.ts.
 */

import { useMemo } from 'react'
import { Database, TrendingUp } from 'lucide-react'
import { useT } from '@/i18n'
import { useSettingsStore } from '@/store/settings.store'
import { DISPLAY_CURRENCY, formatCost } from '@/lib/currency'
import { useUsdToCnyRate } from '@/lib/fx-rate'
import type { Message } from '@/agent/message-types'
import { calculateUsageCost, resolveUsagePricing } from '@/agent/usage-cost'

// ── Aggregation ──────────────────────────────────────────────────

interface AggregatedUsage {
  input: number
  output: number
  cache: number
  inputCost: number
  outputCost: number
  cacheCost: number
  unpricedRequests: number
  models: string[]
}

function aggregateAllMessages(
  messages: Message[],
  fallbackProvider: string,
  fallbackModel: string
): AggregatedUsage {
  let input = 0
  let output = 0
  let cache = 0
  let inputCost = 0
  let outputCost = 0
  let cacheCost = 0
  let unpricedRequests = 0
  const models = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    const u = m.usage
    if (!u) continue
    input += u.promptTokens
    output += u.completionTokens
    cache += u.cacheReadTokens || 0
    const provider = u.provider || fallbackProvider
    const model = u.model || fallbackModel
    if (model) models.add(model)
    const pricing = u.pricing ?? resolveUsagePricing(provider, model)
    const cost = u.cost ?? (pricing ? calculateUsageCost(u, pricing) : null)
    if (cost) {
      inputCost += cost.inputUsd
      outputCost += cost.outputUsd
      cacheCost += cost.cacheReadUsd
    } else {
      unpricedRequests += 1
    }
  }
  return {
    input,
    output,
    cache,
    inputCost,
    outputCost,
    cacheCost,
    unpricedRequests,
    models: [...models],
  }
}

// ── Formatting helpers ────────────────────────────────────────────

/** Format token count: 999 → "999", 1234 → "1.2K", 1_234_567 → "1.23M" */
function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 2 : 1) + 'K'
  return (n / 1_000_000).toFixed(2) + 'M'
}


// ── Component ────────────────────────────────────────────────────

export interface ConversationUsageBarProps {
  messages: Message[]
}

export function ConversationUsageBar({ messages }: ConversationUsageBarProps) {
  const t = useT()
  const providerType = useSettingsStore((s) => s.providerType)
  const modelName = useSettingsStore((s) => s.modelName)
  // Live USD→CNY rate (CN build): starts from cache/static, re-renders when
  // a fresh rate lands. On the international build this is a no-op constant.
  const fxRate = useUsdToCnyRate()

  const usage = useMemo(
    () => aggregateAllMessages(messages, providerType, modelName),
    [messages, modelName, providerType]
  )
  const cost = usage.unpricedRequests === 0
    ? {
        input: usage.inputCost,
        output: usage.outputCost,
        cache: usage.cacheCost,
        total: usage.inputCost + usage.outputCost + usage.cacheCost,
      }
    : null
  const modelLabel = usage.models.length > 0 ? usage.models.join(', ') : 'unknown'

  const total = usage.input + usage.output + usage.cache
  // Avoid /0 — if no usage at all, render nothing (the bar would be 0% width).
  if (total === 0) return null

  const inputPct = (usage.input / total) * 100
  const outputPct = (usage.output / total) * 100
  const cachePct = (usage.cache / total) * 100

  return (
    <div className="sticky top-0 z-10 -mx-4 mb-4 border-b border-neutral-200/70 bg-neutral-50/80 px-4 py-2 backdrop-blur-sm dark:border-neutral-800/60 dark:bg-neutral-900/70">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        {/* Left: label + breakdown */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1 font-medium text-neutral-600 text-neutral-300 text-neutral-300 dark:text-neutral-300">
            <TrendingUp className="h-3 w-3" />
            {t('conversation.usageBar.title')}
          </span>
          <span
            className="inline-flex items-center gap-1 text-neutral-600 text-neutral-400 text-neutral-400 dark:text-neutral-400"
            title={t('conversation.usage.input')}
          >
            <span className="h-2 w-2 rounded-full bg-blue-500" />
            ↑{formatTokens(usage.input)}
          </span>
          <span
            className="inline-flex items-center gap-1 text-neutral-600 text-neutral-400 text-neutral-400 dark:text-neutral-400"
            title={t('conversation.usage.output')}
          >
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            ↓{formatTokens(usage.output)}
          </span>
          {usage.cache > 0 && (
            <span
              className="inline-flex items-center gap-1 text-neutral-600 text-neutral-400 text-neutral-400 dark:text-neutral-400"
              title={t('conversation.usage.cache')}
            >
              <Database className="h-3 w-3 text-violet-500" />
              {formatTokens(usage.cache)}
            </span>
          )}
        </div>

        {/* Right: cost */}
        <div className="flex items-center gap-1 text-neutral-500 tabular-nums text-neutral-400 text-neutral-400 dark:text-neutral-400">
          {cost ? (
            <span title={t('conversation.usageBar.costBreakdown', {
              input: formatCost(cost.input, DISPLAY_CURRENCY, fxRate),
              output: formatCost(cost.output, DISPLAY_CURRENCY, fxRate),
              cache: formatCost(cost.cache, DISPLAY_CURRENCY, fxRate),
              model: modelLabel,
            })}>
              {t('conversation.usageBar.cost', { amount: formatCost(cost.total, DISPLAY_CURRENCY, fxRate) })}
            </span>
          ) : (
            // Unknown pricing — show em-dash so we don't claim "free"
            // for models that are actually paid (e.g. GLM, MiniMax).
            <span title={t('conversation.usageBar.unknownPricing', { model: modelLabel })}>—</span>
          )}
        </div>
      </div>

      {/* 3-segment stacked horizontal bar */}
      <div
        className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-neutral-200/60 dark:bg-neutral-800/60"
        title={t('conversation.usageBar.barTooltip', {
          input: formatTokens(usage.input),
          output: formatTokens(usage.output),
          cache: formatTokens(usage.cache),
        })}
      >
        {inputPct > 0 && (
          <div
            className="h-full bg-blue-500 dark:bg-blue-400"
            style={{ width: `${inputPct}%` }}
          />
        )}
        {outputPct > 0 && (
          <div
            className="h-full bg-emerald-500 dark:bg-emerald-400"
            style={{ width: `${outputPct}%` }}
          />
        )}
        {cachePct > 0 && (
          <div
            className="h-full bg-violet-500 dark:bg-violet-400"
            style={{ width: `${cachePct}%` }}
          />
        )}
      </div>
    </div>
  )
}
