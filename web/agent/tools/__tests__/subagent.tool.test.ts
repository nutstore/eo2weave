import { describe, expect, it, vi } from 'vitest'
import { SubagentError, SubagentErrorCode, type SubagentRuntime, type ToolContext } from '../tool-types'
import {
  batchSpawnDefinition,
  batchSpawnExecutor,
  getSubagentStatusDefinition,
  getSubagentStatusExecutor,
  sendMessageToSubagentDefinition,
  spawnSubagentDefinition,
  spawnSubagentExecutor,
  waitSubagentsDefinition,
  waitSubagentsExecutor,
} from '../subagent.tool'

function parseJson(result: string): Record<string, unknown> {
  return JSON.parse(result) as Record<string, unknown>
}

function createMockRuntime(): SubagentRuntime {
  return {
    start: vi.fn().mockResolvedValue({ agentId: 'subagent_1', status: 'pending', description: 'task' }),
    batchStart: vi.fn().mockResolvedValue({ accepted: [{ task_index: 0, agentId: 'subagent_1', status: 'pending', description: 't1' }], rejected: [] }),
    wait: vi.fn().mockResolvedValue({ results: [], pending: ['subagent_1'], timed_out: true }),
    spawn: vi.fn().mockResolvedValue({
      status: 'completed',
      agentId: 'subagent_1',
      content: 'task done',
    }),
    sendMessage: vi.fn().mockResolvedValue({
      success: true,
      message: 'queued',
      queue_position: 1,
    }),
    stop: vi.fn().mockResolvedValue({
      success: true,
    }),
    stopAll: vi.fn().mockResolvedValue({ stopped: [] }),
    resume: vi.fn().mockResolvedValue({
      status: 'resumed',
      agentId: 'subagent_1',
      resumed_from: null,
      transcript_entries_recovered: 1,
    }),
    getStatus: vi.fn().mockResolvedValue({
      agentId: 'subagent_1',
      status: 'running',
      description: 'task',
      created_at: 1,
      updated_at: 2,
      last_activity_at: 2,
      queue_depth: 0,
    }),
    list: vi.fn().mockResolvedValue({
      agents: [],
      total: 0,
    }),
    batchSpawn: vi.fn().mockResolvedValue({
      completed: [{ task_index: 0, agentId: 'subagent_1', content: 'done' }],
      failed: [],
    }),
    shutdown: vi.fn(),
  }
}

describe('subagent tools', () => {
  it('exposes expected tool names', () => {
    expect(spawnSubagentDefinition.function.name).toBe('spawn_subagent')
    expect(batchSpawnDefinition.function.name).toBe('batch_spawn')
    expect(sendMessageToSubagentDefinition.function.name).toBe('send_message_to_subagent')
    expect(getSubagentStatusDefinition.function.name).toBe('get_subagent_status')
    expect(waitSubagentsDefinition.function.name).toBe('wait_subagents')
  })

  it('caps batch concurrency at five in its public schema', () => {
    expect(batchSpawnDefinition.function.parameters.properties.max_concurrency.maximum).toBe(5)
  })

  it('returns runtime unavailable when runtime is missing', async () => {
    const result = await spawnSubagentExecutor(
      { description: 'task', prompt: 'do it' },
      { directoryHandle: null } as ToolContext
    )
    const parsed = parseJson(result)
    expect(parsed.ok).toBe(false)
    expect((parsed.error as { code: string }).code).toBe('SUBAGENT_RUNTIME_UNAVAILABLE')
  })

  it('spawns subagent with runtime', async () => {
    const runtime = createMockRuntime()
    const result = await spawnSubagentExecutor(
      { description: 'task', prompt: 'do it' },
      { directoryHandle: null, subagentRuntime: runtime, currentToolCallId: 'spawn-call-a' } as ToolContext
    )
    const parsed = parseJson(result)
    expect(parsed.ok).toBe(true)
    expect((runtime.start as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect((runtime.start as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      parentToolCallId: 'spawn-call-a',
    })
  })

  it('returns an accepted receipt without applying completed-output health detection', async () => {
    const runtime = createMockRuntime()
    const result = parseJson(await spawnSubagentExecutor({ description: 'task', prompt: 'work' }, { directoryHandle: null, subagentRuntime: runtime }))
    expect(result).toMatchObject({ ok: true, data: { status: 'pending', agentId: 'subagent_1' } })
    expect(result.health).toBeUndefined()
    expect(runtime.spawn).not.toHaveBeenCalled()
  })

  it('passes the wait scope and abort signal to the runtime', async () => {
    const runtime = createMockRuntime()
    const controller = new AbortController()
    const result = parseJson(await waitSubagentsExecutor({ agentIds: ['subagent_1'], timeout_ms: 10, wait_for: 'any' },
      { directoryHandle: null, subagentRuntime: runtime, abortSignal: controller.signal }))
    expect(result).toMatchObject({ ok: true, data: { pending: ['subagent_1'], timed_out: true } })
    expect(runtime.wait).toHaveBeenCalledWith({ agentIds: ['subagent_1'], timeout_ms: 10, wait_for: 'any', signal: controller.signal })
  })

  it('returns compact wait results without child transcripts or continuation config', async () => {
    const runtime = createMockRuntime()
    vi.mocked(runtime.wait).mockResolvedValueOnce({ results: [{ id: 'a:e', agentId: 'a', executionId: 'e', taskStatus: 'completed',
      result: 'finished', messages: [{ content: 'private detailed trace' }], continuation: { modelName: 'internal model' },
      changedPaths: ['a.ts'] } as any], pending: [], timed_out: false })
    const result = parseJson(await waitSubagentsExecutor({ agentIds: ['a'] }, { directoryHandle: null, subagentRuntime: runtime }))
    const encoded = JSON.stringify(result)
    expect(encoded).not.toContain('private detailed trace')
    expect(encoded).not.toContain('internal model')
    expect(result).toMatchObject({ data: { results: [{ agentId: 'a', result: 'finished', changedPaths: ['a.ts'] }] } })
  })

  it('keeps valid batch members when another member fails validation', async () => {
    const runtime = createMockRuntime()
    const result = parseJson(await batchSpawnExecutor({ tasks: [{ description: '', prompt: 'bad' }, { description: 'task', prompt: 'work' }] },
      { directoryHandle: null, subagentRuntime: runtime }))
    expect(result).toMatchObject({ ok: true, data: { accepted: [{ task_index: 1 }], rejected: [{ task_index: 0 }] } })
  })

  it('maps status query error to TASK_NOT_FOUND', async () => {
    const runtime = createMockRuntime()
    ;(runtime.getStatus as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new SubagentError(SubagentErrorCode.TASK_NOT_FOUND, 'not found'))
    const result = await getSubagentStatusExecutor(
      { agentId: 'missing' },
      { directoryHandle: null, subagentRuntime: runtime } as ToolContext
    )
    const parsed = parseJson(result)
    expect(parsed.ok).toBe(false)
    expect((parsed.error as { code: string }).code).toBe('TASK_NOT_FOUND')
  })

  it('supports batch spawn tool', async () => {
    const runtime = createMockRuntime()
    const result = await batchSpawnExecutor(
      {
        tasks: [{ description: 't1', prompt: 'p1' }],
        max_concurrency: 2,
      },
      { directoryHandle: null, subagentRuntime: runtime } as ToolContext
    )
    const parsed = parseJson(result)
    expect(parsed.ok).toBe(true)
    expect((runtime.batchStart as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })
})
