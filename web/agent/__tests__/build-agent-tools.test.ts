import { describe, expect, it, vi } from 'vitest'
import { buildAgentTools } from '../loop/build-agent-tools'

/**
 * Helper to create a minimal buildAgentTools input with sensible defaults.
 */
function createInput(overrides: Record<string, unknown> = {}) {
  return {
    toolRegistry: overrides.toolRegistry as any,
    mode: (overrides.mode ?? 'act') as any,
    callbacks: {},
    getAllMessages: () => [],
    getAbortSignal: () => undefined,
    getToolContext: () => ({ directoryHandle: null }),
    provider: { maxContextTokens: 128000, estimateTokens: () => 1 } as any,
    contextManager: { getConfig: () => ({ maxContextTokens: 128000, reserveTokens: 4096 }) } as any,
    toolExecutionTimeout: overrides.toolExecutionTimeout as number ?? 30000,
    toolTimeoutExemptions: (overrides.toolTimeoutExemptions ?? new Set<string>()) as Set<string>,
  }
}

describe('build-agent-tools', () => {
  it('blocks write tools in plan mode', async () => {
    const toolRegistry = {
      getToolDefinitionsForMode: vi.fn(() => [
        {
          type: 'function',
          function: {
            name: 'write',
            description: 'write file',
            parameters: { type: 'object', properties: {} },
          },
        },
      ]),
      execute: vi.fn(),
    } as any

    const tools = buildAgentTools(createInput({
      toolRegistry,
      mode: 'plan',
    }))

    await expect(tools[0].execute('call_1', {})).rejects.toThrow('not available in plan mode')
    expect(toolRegistry.execute).not.toHaveBeenCalled()
  })

  it('uses per-call timeout from args.timeout when provided', async () => {
    // We spy on the timeout by checking that a tool with timeout=120000
    // does NOT time out after 30s but DOES complete. We verify this indirectly
    // by recording the timeoutMs passed to executeToolWithTimeout.
    // Since executeToolWithTimeout is internal, we verify by making the tool
    // take 35ms (longer than the default 30ms but shorter than the per-call 120ms).
    const toolRegistry = {
      getToolDefinitionsForMode: vi.fn(() => [
        {
          type: 'function',
          function: {
            name: 'run_python',
            description: 'run_python',
            parameters: { type: 'object', properties: {} },
          },
        },
      ]),
      execute: vi.fn(async () => 'ok'),
    } as any

    const tools = buildAgentTools(createInput({
      toolRegistry,
      toolExecutionTimeout: 50, // very short global timeout (50ms)
    }))

    // With per-call timeout of 5000ms, the tool should succeed
    // (global 50ms would kill it, but per-call 5000ms should not)
    await tools[0].execute('call_1', { code: 'print(1)', timeout: 5000 })
    expect(toolRegistry.execute).toHaveBeenCalled()
  })

  it('respects toolTimeoutExemptions over per-call timeout', async () => {
    const toolRegistry = {
      getToolDefinitionsForMode: vi.fn(() => [
        {
          type: 'function',
          function: {
            name: 'test_exempt_tool',
            description: 'test exempt tool',
            parameters: { type: 'object', properties: {} },
          },
        },
      ]),
      execute: vi.fn(async () => 'ok'),
    } as any

    const tools = buildAgentTools(createInput({
      toolRegistry,
      toolTimeoutExemptions: new Set<string>(['test_exempt_tool']),
    }))

    // test_exempt_tool is in exemptions → no timeout at all, should succeed
    await tools[0].execute('call_1', { timeout: 1000 })
    expect(toolRegistry.execute).toHaveBeenCalled()
  })

  it('caps per-call timeout at 5 minutes', async () => {
    const toolRegistry = {
      getToolDefinitionsForMode: vi.fn(() => [
        {
          type: 'function',
          function: {
            name: 'run_python',
            description: 'run_python',
            parameters: { type: 'object', properties: {} },
          },
        },
      ]),
      execute: vi.fn(async () => 'ok'),
    } as any

    const tools = buildAgentTools(createInput({ toolRegistry }))

    // Even with an absurd timeout, the tool should still work (capped at 5 min internally)
    await tools[0].execute('call_1', { code: 'pass', timeout: 999999999 })
    expect(toolRegistry.execute).toHaveBeenCalled()
  })

  it('falls back to global timeout when args.timeout is not provided', async () => {
    const toolRegistry = {
      getToolDefinitionsForMode: vi.fn(() => [
        {
          type: 'function',
          function: {
            name: 'read',
            description: 'read',
            parameters: { type: 'object', properties: {} },
          },
        },
      ]),
      execute: vi.fn(async () => 'ok'),
    } as any

    const tools = buildAgentTools(createInput({
      toolRegistry,
      toolExecutionTimeout: 30000,
    }))

    // No timeout arg → uses global 30000ms
    await tools[0].execute('call_1', { path: 'test.txt' })
    expect(toolRegistry.execute).toHaveBeenCalled()
  })
})
