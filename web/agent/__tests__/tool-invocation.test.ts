import { describe, expect, it, vi } from 'vitest'
import { invokeTool } from '@/agent/tool-invocation'
import type { BuildAgentToolsInput } from '@/agent/loop/build-agent-tools'
import type { ToolContext } from '@/agent/tools/tool-types'

vi.mock('@/store/workspace-preferences.store', () => ({ getCurrentWorkspaceAgentMode: () => 'act' }))

function input(execute: (name: string, args: unknown, context: ToolContext) => Promise<string>) {
  return {
    mode: 'act', toolExecutionTimeout: 1000, toolTimeoutExemptions: new Set(),
    getAbortSignal: () => undefined,
    toolRegistry: {
      getToolDefinitionsForMode: () => [{ function: { name: 'read' } }], execute,
    },
  } as unknown as BuildAgentToolsInput
}

describe('shared tool invocation', () => {
  it('keeps full structured data and per-call contexts isolated', async () => {
    const contexts: ToolContext[] = []
    const config = input(async (_name, _args, context) => {
      contexts.push(context)
      await Promise.resolve()
      context.deferContext!([{ type: 'text', text: context.currentToolCallId! }])
      return JSON.stringify({ ok: true, version: 2, tool: 'read', data: { text: 'x'.repeat(100000) } })
    })
    const context = { directoryHandle: null }
    const results = await Promise.all(['a', 'b'].map(toolCallId => invokeTool(config, {
      toolName: 'read', toolCallId, args: {}, context,
    })))
    expect(contexts[0]).not.toBe(contexts[1])
    expect(context).toEqual({ directoryHandle: null })
    expect(results.map(r => r.deferred[0].sourceCallId)).toEqual(['a', 'b'])
    expect(results[0].value).toEqual({ text: 'x'.repeat(100000) })
  })

  it('preserves emitted context on failure and ignores late emissions', async () => {
    let emit: NonNullable<ToolContext['deferContext']> = () => {}
    const config = input(async (_name, _args, context) => {
      emit = context.deferContext!
      emit([{ type: 'text', text: 'before failure' }])
      throw new Error('failed')
    })
    const result = await invokeTool(config, { toolName: 'read', toolCallId: 'a', args: {}, context: { directoryHandle: null } })
    emit([{ type: 'text', text: 'late' }])
    expect(result.isError).toBe(true)
    expect(result.deferred).toHaveLength(1)
  })
})
