import type { MessageUsage } from '@/agent/message-types'
import { getModelPricing } from '@/agent/providers/model-store'
import { getOpenRouterPricing } from '@/agent/providers/openrouter-pricing'
import type { LLMProviderType } from '@/agent/providers/types'

export interface UsagePricingSnapshot {
  inputPerMillionUsd: number
  outputPerMillionUsd: number
  cacheReadPerMillionUsd?: number
  source: 'provider' | 'openrouter'
}

export interface UsageCostSnapshot {
  inputUsd: number
  outputUsd: number
  cacheReadUsd: number
  totalUsd: number
}

function parseUsdPerToken(value: string | undefined | null): number | null {
  if (value == null) return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/** Resolve the best price known at execution time, expressed in USD / 1M tokens. */
export function resolveUsagePricing(
  provider: string | undefined,
  model: string | undefined
): UsagePricingSnapshot | null {
  if (!model) return null

  const slashIndex = model.lastIndexOf('/')
  const bareModel = slashIndex >= 0 ? model.slice(slashIndex + 1) : model
  const candidates = [model, ...(bareModel && bareModel !== model ? [bareModel] : [])]

  if (provider) {
    for (const candidate of candidates) {
      const dynamic = getModelPricing(provider as LLMProviderType, candidate)
      if (!dynamic) continue
      const input = parseUsdPerToken(dynamic.prompt)
      const output = parseUsdPerToken(dynamic.completion)
      const cacheRead = parseUsdPerToken(dynamic.input_cache_read)
      if (input != null || output != null) {
        return {
          inputPerMillionUsd: (input ?? 0) * 1_000_000,
          outputPerMillionUsd: (output ?? 0) * 1_000_000,
          ...(cacheRead != null ? { cacheReadPerMillionUsd: cacheRead * 1_000_000 } : {}),
          source: 'provider',
        }
      }
    }
  }

  for (const candidate of candidates) {
    const fallback = getOpenRouterPricing(candidate)
    if (fallback) {
      return {
        inputPerMillionUsd: fallback.input,
        outputPerMillionUsd: fallback.output,
        ...(fallback.cacheRead != null ? { cacheReadPerMillionUsd: fallback.cacheRead } : {}),
        source: 'openrouter',
      }
    }
  }

  return null
}

export function calculateUsageCost(
  usage: Pick<MessageUsage, 'promptTokens' | 'completionTokens' | 'cacheReadTokens'>,
  pricing: UsagePricingSnapshot
): UsageCostSnapshot {
  const inputUsd = (usage.promptTokens / 1_000_000) * pricing.inputPerMillionUsd
  const outputUsd = (usage.completionTokens / 1_000_000) * pricing.outputPerMillionUsd
  const cacheReadUsd =
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * (pricing.cacheReadPerMillionUsd ?? 0)
  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    totalUsd: inputUsd + outputUsd + cacheReadUsd,
  }
}

/** Freeze model identity, pricing, and computed cost alongside API-reported tokens. */
export function createUsageSnapshot(
  usage: MessageUsage,
  provider: string | undefined,
  model: string | undefined
): MessageUsage {
  const pricing = resolveUsagePricing(provider, model)
  return {
    ...usage,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(pricing ? { pricing, cost: calculateUsageCost(usage, pricing) } : {}),
  }
}
