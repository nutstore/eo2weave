import { describe, expect, it } from 'vitest'
import { calculateUsageCost, createUsageSnapshot } from './usage-cost'

describe('usage cost snapshots', () => {
  it('calculates input, output and cache-read cost in USD', () => {
    expect(
      calculateUsageCost(
        { promptTokens: 2_000_000, completionTokens: 500_000, cacheReadTokens: 1_000_000 },
        {
          inputPerMillionUsd: 2,
          outputPerMillionUsd: 8,
          cacheReadPerMillionUsd: 0.5,
          source: 'provider',
        }
      )
    ).toEqual({ inputUsd: 4, outputUsd: 4, cacheReadUsd: 0.5, totalUsd: 8.5 })
  })

  it('persists model identity even when pricing is unknown', () => {
    const usage = createUsageSnapshot(
      { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      'custom-openai',
      'private-model-with-no-public-price'
    )
    expect(usage).toMatchObject({
      provider: 'custom-openai',
      model: 'private-model-with-no-public-price',
    })
    expect(usage.pricing).toBeUndefined()
    expect(usage.cost).toBeUndefined()
  })
})
