import { describe, expect, it } from 'vitest'
import { buildProjectUsageExportRows } from './project-usage-export'

describe('buildProjectUsageExportRows', () => {
  it('exports conversation and delegated subagent usage with an auditable project total', () => {
    const rows = buildProjectUsageExportRows(
      { id: 'project-1', name: 'Test Project' },
      [
        { id: 'conv-1', title: 'Run tests', createdAt: 100, updatedAt: 300 },
        { id: 'conv-2', title: 'No model calls', createdAt: 200, updatedAt: 200 },
      ],
      [
        {
          conversationId: 'conv-1',
          scope: 'conversation',
          timestamp: 110,
          usage: {
            promptTokens: 1_000,
            completionTokens: 500,
            totalTokens: 1_500,
            provider: 'openai',
            model: 'test-model',
            pricing: {
              inputPerMillionUsd: 2,
              outputPerMillionUsd: 4,
              source: 'provider',
            },
          },
        },
        {
          conversationId: 'conv-1',
          scope: 'subagent',
          subagentId: 'agent-1',
          subagentName: 'tester',
          timestamp: 120,
          usage: {
            promptTokens: 300,
            completionTokens: 100,
            totalTokens: 400,
          },
        },
      ]
    )

    const total = rows[0]
    expect(total).toMatchObject({
      record_type: 'project_total',
      request_count: 2,
      total_tokens: 1_900,
      known_estimated_cost_usd: 0.004,
      cost_complete: false,
      unpriced_request_count: 1,
      estimated_total_cost_usd: '',
    })

    expect(rows).toContainEqual(
      expect.objectContaining({
        conversation_id: 'conv-1',
        scope: 'conversation',
        provider: 'openai',
        model: 'test-model',
        model_source: 'recorded',
        estimated_total_cost_usd: 0.004,
        pricing_source: 'provider',
      })
    )
    expect(rows).toContainEqual(
      expect.objectContaining({
        conversation_id: 'conv-1',
        scope: 'subagent',
        subagent_id: 'agent-1',
        model: 'unknown',
        cost_complete: false,
      })
    )
    expect(rows).toContainEqual(
      expect.objectContaining({
        conversation_id: 'conv-2',
        request_count: 0,
        total_tokens: 0,
        pricing_source: 'not_applicable',
      })
    )
  })

  it('uses the currently selected model for legacy usage without model metadata', () => {
    const rows = buildProjectUsageExportRows(
      { id: 'project-legacy', name: 'Legacy Project' },
      [{ id: 'conv-legacy', title: 'Old run', createdAt: 100, updatedAt: 200 }],
      [
        {
          conversationId: 'conv-legacy',
          scope: 'conversation',
          timestamp: 150,
          usage: { promptTokens: 1_000, completionTokens: 500, totalTokens: 1_500 },
        },
      ],
      { provider: 'openai', model: 'gpt-4o' }
    )

    expect(rows).toContainEqual(
      expect.objectContaining({
        conversation_id: 'conv-legacy',
        provider: 'openai',
        model: 'gpt-4o',
        model_source: 'current_selection_fallback',
        cost_complete: true,
        unpriced_request_count: 0,
      })
    )
  })
})
