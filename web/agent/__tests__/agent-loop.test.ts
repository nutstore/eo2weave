/**
 * AgentLoop Unit Tests (Pi core single-path)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentLoop } from '../agent-loop'
import type { Message } from '../message-types'
import type { ToolContext } from '../tools/tool-types'
import type { ChatMessage } from '../llm/llm-provider'
import { PiAIProvider } from '../llm/pi-ai-provider'
import { agentLoopContinue } from '@earendil-works/pi-agent-core'
import { truncateLargeToolResult } from '../loop/tool-execution'

vi.mock('@/skills/skill-manager', () => ({
  getSkillManager: vi.fn(() => ({
    getEnhancedSystemPrompt: vi.fn((prompt: string) => prompt),
  })),
}))

vi.mock('../intelligence-coordinator', () => ({
  getIntelligenceCoordinator: vi.fn(() => ({
    enhanceSystemPrompt: vi.fn((prompt: string) => Promise.resolve({ systemPrompt: prompt })),
  })),
}))

vi.mock('@/mcp', () => ({
  getMCPManager: vi.fn(() => ({
    initialize: vi.fn(() => Promise.resolve()),
  })),
}))

vi.mock('../prefetch', () => ({
  triggerPrefetch: vi.fn(() => Promise.resolve()),
}))

vi.mock('@earendil-works/pi-agent-core', () => ({
  agentLoopContinue: vi.fn(),
}))

function createMockProvider(): PiAIProvider {
  const provider = Object.create(PiAIProvider.prototype) as any
  provider.name = 'mock'
  provider.maxContextTokens = 128000
  provider.getModel = vi.fn(() => ({
    api: 'openai-completions',
    provider: 'mock-provider',
    id: 'mock-model',
    maxTokens: 4096,
  }))
  provider.getApiKey = vi.fn(() => 'test-key')
  provider.chat = vi.fn()
  provider.chatStream = vi.fn()
  provider.estimateTokens = vi.fn(() => 1)
  return provider
}

function createMockToolRegistry() {
  const registry = {
    getToolDefinitions: vi.fn(() => []),
    getToolDefinitionsForMode: vi.fn((_mode: 'plan' | 'act') => registry.getToolDefinitions()),
    execute: vi.fn(async (name: string, args: Record<string, unknown>) => {
      return `Executed ${name} with ${JSON.stringify(args)}`
    }),
    registerMCPTools: vi.fn(() => Promise.resolve()),
  }
  return registry as any
}

function createMockContextManager() {
  return {
    trimMessages: vi.fn((msgs: ChatMessage[]) => ({
      messages: msgs,
      wasTruncated: false,
      droppedGroups: 0,
    })),
    setSystemPrompt: vi.fn(),
    getConfig: vi.fn(() => ({ systemPrompt: 'sys', maxContextTokens: 128000, reserveTokens: 4096 })),
  } as any
}

function createUserMessage(content: string): Message {
  return {
    id: `msg-${Date.now()}`,
    timestamp: Date.now(),
    role: 'user',
    content,
  }
}

function createMockToolContext(): ToolContext {
  return { directoryHandle: null }
}

function assistantMessage(text: string): any {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    usage: { input: 1, output: 1, totalTokens: 2 },
    timestamp: Date.now(),
  }
}

function toolResultMessage(toolCallId: string, toolName: string, text: string): any {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  }
}

const mockAgentLoopContinue = vi.mocked(agentLoopContinue) as any

describe('AgentLoop', () => {
  let mockProvider: PiAIProvider
  let mockTools: ReturnType<typeof createMockToolRegistry>
  let mockContextManager: ReturnType<typeof createMockContextManager>

  beforeEach(() => {
    vi.clearAllMocks()
    mockProvider = createMockProvider()
    mockTools = createMockToolRegistry()
    mockContextManager = createMockContextManager()

    mockAgentLoopContinue.mockImplementation((context: any, config: any) => {
      return (async function* () {
        if (config.convertToLlm) {
          await config.convertToLlm(context.messages)
        }
        yield { type: 'message_start', message: assistantMessage('') }
        yield { type: 'message_end', message: assistantMessage('Hello!') }
      })()
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('should initialize with provided config', () => {
      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })
      expect(loop).toBeInstanceOf(AgentLoop)
    })

    it('should set system prompt on context manager', () => {
      new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
        systemPrompt: 'custom prompt',
      })

      expect(mockContextManager.setSystemPrompt).toHaveBeenCalledWith('custom prompt')
    })
  })

  describe('truncateLargeToolResult()', () => {
    it('returns summary when even one search hit cannot fit token budget', async () => {
      const rawResult = JSON.stringify({
        results: [
          {
            path: 'src/huge.ts',
            line: 10,
            column: 1,
            match: 'x'.repeat(3000),
            preview: 'x'.repeat(3000),
          },
        ],
        totalMatches: 1,
        scannedFiles: 1,
      })

      const truncated = await truncateLargeToolResult({
        rawResult,
        toolName: 'search',
        existingTokens: 1800,
        maxContextTokens: 2200,
        reserveTokens: 200,
        estimateTextTokens: (text) => text.length,
      })
      const parsed = JSON.parse(truncated)

      expect(parsed.truncated).toBe(true)
      expect(parsed.results).toEqual([])
      expect(parsed.originalTotalMatches).toBe(1)
    })

    it('restores toolContext after tool execution failure', async () => {
      mockTools.getToolDefinitions.mockReturnValue([
        {
          type: 'function',
          function: {
            name: 'read',
            description: 'Read file',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
      ])
      mockTools.execute.mockRejectedValueOnce(new Error('tool failed'))

      mockAgentLoopContinue.mockImplementation((context: any) => {
        return (async function* () {
          await context.tools[0].execute('call_1', {})
        })()
      })

      const originalToolContext = createMockToolContext()
      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: originalToolContext,
      })

      await expect(loop.run([createUserMessage('test')])).rejects.toThrow('tool failed')
      expect((loop as any).toolContext).toBe(originalToolContext)
      expect((loop as any).toolContext.contextUsage).toBeUndefined()
    })
  })

  describe('run()', () => {
    it('should only send messages from latest context summary to model context', async () => {
      let capturedContextMessages: any[] = []
      mockAgentLoopContinue.mockImplementation((context: any, config: any) => {
        capturedContextMessages = context.messages
        return (async function* () {
          if (config.convertToLlm) {
            await config.convertToLlm(context.messages)
          }
          yield { type: 'message_start', message: assistantMessage('') }
          yield { type: 'message_end', message: assistantMessage('OK') }
        })()
      })

      const now = Date.now()
      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      await loop.run([
        {
          id: 'old-user',
          timestamp: now - 3000,
          role: 'user',
          content: 'old user message',
        },
        {
          id: 'old-assistant',
          timestamp: now - 2000,
          role: 'assistant',
          content: 'old assistant message',
        },
        {
          id: 'summary',
          timestamp: now - 1000,
          role: 'assistant',
          kind: 'context_summary',
          content: 'compressed summary',
        },
        {
          id: 'latest-user',
          timestamp: now,
          role: 'user',
          content: 'latest user message',
        },
      ])

      expect(capturedContextMessages).toHaveLength(3)
      expect(capturedContextMessages[2].content).toContain('<runtime_context_update>')
      expect(capturedContextMessages[0]?.role).toBe('user')
      expect(capturedContextMessages[0]?.content).toContain('Earlier conversation summary:')
      expect(capturedContextMessages[0]?.content).toContain('compressed summary')
      expect(capturedContextMessages[1]?.role).toBe('user')
      expect(capturedContextMessages[1]?.content).toBe('latest user message')
    })

    it('should execute single turn conversation', async () => {
      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      const callbacks = { onMessageStart: vi.fn(), onComplete: vi.fn() }
      const result = await loop.run([createUserMessage('test')], callbacks)

      expect(callbacks.onMessageStart).toHaveBeenCalledOnce()
      expect(callbacks.onComplete).toHaveBeenCalledOnce()
      const turns = result.filter(message => message.kind !== 'context_update')
      expect(turns).toHaveLength(2)
      expect(turns[1].role).toBe('assistant')
      expect(turns[1].content).toBe('Hello!')
    })

    it('should call onMessageStart for each assistant message', async () => {
      mockAgentLoopContinue.mockImplementation(() => {
        return (async function* () {
          yield { type: 'message_start', message: assistantMessage('') }
          yield { type: 'message_end', message: assistantMessage('First') }
          yield { type: 'message_start', message: assistantMessage('') }
          yield { type: 'message_end', message: assistantMessage('Second') }
        })()
      })

      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      const callbacks = { onMessageStart: vi.fn() }
      const result = await loop.run([createUserMessage('test')], callbacks)
      expect(callbacks.onMessageStart).toHaveBeenCalledTimes(2)
      expect(result.filter((m) => m.role === 'assistant')).toHaveLength(2)
    })

    it('should fallback to onMessageStart when message_update arrives before message_start', async () => {
      mockAgentLoopContinue.mockImplementation(() => {
        return (async function* () {
          yield { type: 'message_update', assistantMessageEvent: { type: 'text_start' } }
          yield { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } }
          yield { type: 'message_end', message: assistantMessage('Hello') }
        })()
      })

      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      const callbacks = { onMessageStart: vi.fn() }
      const result = await loop.run([createUserMessage('test')], callbacks)
      expect(callbacks.onMessageStart).toHaveBeenCalledOnce()
      expect(result[result.length - 1].content).toBe('Hello')
    })

    it('should handle empty assistant content', async () => {
      mockAgentLoopContinue.mockImplementation(() => {
        return (async function* () {
          yield { type: 'message_end', message: assistantMessage('') }
        })()
      })

      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      const result = await loop.run([createUserMessage('test')])
      expect(result[1].content).toBeNull()
    })

    it('does not heuristically trim context in the convertToLlm bridge', async () => {
      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      await loop.run([createUserMessage('test')])
      expect(mockContextManager.trimMessages).not.toHaveBeenCalled()
    })

    it('should call LLM to summarize dropped context when compression occurs', async () => {
      let convertedMessages: any[] | null = null
      ;(mockProvider.chat as any).mockResolvedValue({
        choices: [{ message: { content: 'Earlier requirement implemented with fallback.' } }],
      })

      mockAgentLoopContinue.mockImplementation((_context: any, config: any) => {
        return (async function* () {
          convertedMessages = await config.convertToLlm([
            { role: 'user', content: 'earlier requirement', timestamp: Date.now() - 2_000 },
            { ...assistantMessage('earlier implementation'), usage: { input: 90_000, output: 1, totalTokens: 110_000 }, timestamp: Date.now() - 1_000 },
          ])
          yield { type: 'message_start', message: assistantMessage('') }
          yield { type: 'message_end', message: assistantMessage('Hello!') }
        })()
      })

      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      await loop.run([createUserMessage('test')])

      expect(mockProvider.chat).toHaveBeenCalledTimes(1)
      expect(mockContextManager.trimMessages).not.toHaveBeenCalled()
      expect(convertedMessages).toBeTruthy()
      const hasSummary = (convertedMessages || []).some(
        (m: any) =>
          m.role === 'user' &&
          typeof m.content === 'string' &&
          m.content.includes('Earlier conversation summary')
      )
      expect(hasSummary).toBe(true)
    })

    it('skips LLM summary without a prior real token usage report', async () => {

      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      await loop.run([createUserMessage('test')])
      expect(mockProvider.chat).not.toHaveBeenCalled()
    })

    it('propagates an LLM summary failure after real token usage triggers compression', async () => {
      ;(mockProvider.chat as any).mockRejectedValue(new Error('network failed'))

      mockAgentLoopContinue.mockImplementation((_context: any, config: any) => {
        return (async function* () {
          await config.convertToLlm([
            { role: 'user', content: 'critical requirement', timestamp: Date.now() - 2_000 },
            { ...assistantMessage('implementation detail'), usage: { input: 90_000, output: 1, totalTokens: 110_000 }, timestamp: Date.now() - 1_000 },
          ])
          yield { type: 'message_start', message: assistantMessage('') }
          yield { type: 'message_end', message: assistantMessage('Hello!') }
        })()
      })

      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      await expect(loop.run([createUserMessage('test')])).rejects.toThrow('network failed')
      expect(mockProvider.chat).toHaveBeenCalledTimes(1)
    })

    it('keeps all messages until a later real usage report triggers compression', async () => {
      let firstConvertMessages: any[] = []
      let secondConvertMessages: any[] = []

      ;(mockProvider.chat as any).mockResolvedValue({
        choices: [{ message: { content: 'Compressed baseline summary.' } }],
      })

      mockAgentLoopContinue.mockImplementation((_context: any, config: any) => {
        return (async function* () {
          const now = Date.now()
          firstConvertMessages = await config.convertToLlm([
            { role: 'user', content: 'old user request', timestamp: now - 5000 },
            { ...assistantMessage('old assistant response'), timestamp: now - 4000 },
            { role: 'user', content: 'latest user request', timestamp: now - 1000 },
          ])

          secondConvertMessages = await config.convertToLlm([
            { role: 'user', content: 'old user request', timestamp: now - 5000 },
            { ...assistantMessage('old assistant response'), timestamp: now - 4000 },
            { role: 'user', content: 'latest user request', timestamp: now - 1000 },
            {
              ...toolResultMessage('call_1', 'read', 'fresh tool result'),
              timestamp: now - 500,
            },
          ])

          yield { type: 'message_end', message: assistantMessage('Done') }
        })()
      })

      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      await loop.run([createUserMessage('test')])

      const hasOldUser = secondConvertMessages.some(
        (m: any) => m.role === 'user' && m.content === 'old user request'
      )
      const hasOldAssistant = secondConvertMessages.some(
        (m: any) =>
          m.role === 'assistant' &&
          Array.isArray(m.content) &&
          m.content.some((item: any) => item.type === 'text' && item.text === 'old assistant response')
      )
      const hasLatestUser = secondConvertMessages.some(
        (m: any) => m.role === 'user' && m.content === 'latest user request'
      )
      const hasLatestTool = secondConvertMessages.some(
        (m: any) => m.role === 'toolResult' && m.toolCallId === 'call_1'
      )

      expect(firstConvertMessages.length).toBeGreaterThan(0)
      expect(hasOldUser).toBe(true)
      expect(hasOldAssistant).toBe(true)
      expect(hasLatestUser).toBe(true)
      expect(hasLatestTool).toBe(true)
    })

    it('should update messages through callbacks', async () => {
      const updates: Message[][] = []
      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      await loop.run([createUserMessage('test')], {
        onMessagesUpdated: (msgs) => updates.push(msgs),
      })

      expect(updates.length).toBeGreaterThan(0)
      expect(updates[updates.length - 1].filter(message => message.kind !== 'context_update')).toHaveLength(2)
    })
  })

  describe('tool calling', () => {
    it('should execute tool and continue to final response', async () => {
      mockAgentLoopContinue.mockImplementation((context: any) => {
        return (async function* () {
          const tool = context.tools.find((t: any) => t.name === 'list_files')
          yield {
            type: 'tool_execution_start',
            toolCallId: 'call_1',
            toolName: 'list_files',
            args: {},
          }
          const result = await tool.execute('call_1', {})
          yield {
            type: 'tool_execution_end',
            toolCallId: 'call_1',
            toolName: 'list_files',
            result,
          }
          yield { type: 'message_end', message: toolResultMessage('call_1', 'list_files', result.content[0].text) }
          yield { type: 'message_end', message: assistantMessage('Done!') }
        })()
      })

      mockTools.getToolDefinitions.mockReturnValue([
        {
          type: 'function',
          function: {
            name: 'list_files',
            description: 'list files',
            parameters: { type: 'object', properties: {} },
          },
        },
      ])

      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      const result = await loop.run([createUserMessage('list files')])
      expect(mockTools.execute).toHaveBeenCalledWith(
        'list_files',
        {},
        expect.objectContaining({ directoryHandle: null, abortSignal: expect.any(AbortSignal) })
      )
      expect(result.some((m) => m.role === 'tool')).toBe(true)
      expect(result[result.length - 1].content).toBe('Done!')
    })

    it('should emit tool callbacks in order', async () => {
      const events: string[] = []
      mockAgentLoopContinue.mockImplementation((context: any) => {
        return (async function* () {
          const tool = context.tools.find((t: any) => t.name === 'tool_a')
          yield {
            type: 'message_update',
            assistantMessageEvent: {
              type: 'toolcall_start',
              contentIndex: 0,
              partial: {
                content: [{ type: 'toolCall', id: 'call_1', name: 'tool_a', arguments: {} }],
              },
            },
          }
          yield { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'tool_a', args: {} }
          const result = await tool.execute('call_1', {})
          yield { type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'tool_a', result }
          yield { type: 'message_end', message: toolResultMessage('call_1', 'tool_a', result.content[0].text) }
          yield { type: 'message_end', message: assistantMessage('Done') }
        })()
      })

      mockTools.getToolDefinitions.mockReturnValue([
        {
          type: 'function',
          function: { name: 'tool_a', description: 'a', parameters: { type: 'object', properties: {} } },
        },
      ])

      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      await loop.run([createUserMessage('run tools')], {
        onToolCallStart: (tc) => events.push(`start:${tc.id}`),
        onMessagesUpdated: (msgs) => {
          const last = msgs[msgs.length - 1]
          if (last?.role === 'tool') events.push(`msg:${last.toolCallId}`)
        },
        onToolCallComplete: (tc) => events.push(`complete:${tc.id}`),
      })

      expect(events).toEqual(['start:call_1', 'msg:call_1', 'complete:call_1'])
    })

    it('should surface tool error as tool result message', async () => {
      mockAgentLoopContinue.mockImplementation((context: any) => {
        return (async function* () {
          const tool = context.tools.find((t: any) => t.name === 'bad_tool')
          yield { type: 'tool_execution_start', toolCallId: 'call_err', toolName: 'bad_tool', args: {} }
          let resultText = ''
          try {
            await tool.execute('call_err', {})
          } catch (err) {
            resultText = `Error: ${err instanceof Error ? err.message : String(err)}`
          }
          yield {
            type: 'tool_execution_end',
            toolCallId: 'call_err',
            toolName: 'bad_tool',
            result: { content: [{ type: 'text', text: resultText }] },
          }
          yield { type: 'message_end', message: toolResultMessage('call_err', 'bad_tool', resultText) }
          yield { type: 'message_end', message: assistantMessage('Done') }
        })()
      })

      const errorRegistry = createMockToolRegistry()
      errorRegistry.getToolDefinitions.mockReturnValue([
        {
          type: 'function',
          function: {
            name: 'bad_tool',
            description: 'bad',
            parameters: { type: 'object', properties: {} },
          },
        },
      ])
      errorRegistry.execute = vi.fn(async () => {
        throw new Error('Tool failed')
      })

      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: errorRegistry,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      const result = await loop.run([createUserMessage('run bad tool')])
      const toolResult = result.find((m) => m.role === 'tool')
      expect(toolResult?.content).toContain('Error: Tool failed')
    })
  })

  describe('streaming callbacks', () => {
    it('should emit reasoning and content deltas', async () => {
      mockAgentLoopContinue.mockImplementation(() => {
        return (async function* () {
          yield { type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } }
          yield { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Thinking...' } }
          yield { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', content: 'Thinking...' } }
          yield { type: 'message_update', assistantMessageEvent: { type: 'text_start' } }
          yield { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Response' } }
          yield { type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'Response' } }
          yield { type: 'message_end', message: assistantMessage('Response') }
        })()
      })

      const callbacks = {
        onReasoningStart: vi.fn(),
        onReasoningDelta: vi.fn(),
        onReasoningComplete: vi.fn(),
        onContentStart: vi.fn(),
        onContentDelta: vi.fn(),
        onContentComplete: vi.fn(),
      }

      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      await loop.run([createUserMessage('test')], callbacks)
      expect(callbacks.onReasoningStart).toHaveBeenCalledOnce()
      expect(callbacks.onReasoningDelta).toHaveBeenCalledWith('Thinking...')
      expect(callbacks.onReasoningComplete).toHaveBeenCalledWith('Thinking...')
      expect(callbacks.onContentStart).toHaveBeenCalledOnce()
      expect(callbacks.onContentDelta).toHaveBeenCalledWith('Response')
      expect(callbacks.onContentComplete).toHaveBeenCalledWith('Response')
    })

    it('should emit tool-call argument deltas', async () => {
      mockAgentLoopContinue.mockImplementation(() => {
        return (async function* () {
          yield {
            type: 'message_update',
            assistantMessageEvent: {
              type: 'toolcall_start',
              contentIndex: 0,
              partial: {
                content: [{ type: 'toolCall', id: 'call_1', name: 'test_tool', arguments: {} }],
              },
            },
          }
          yield {
            type: 'message_update',
            assistantMessageEvent: {
              type: 'toolcall_delta',
              contentIndex: 0,
              delta: '{"path":',
            },
          }
          yield {
            type: 'message_update',
            assistantMessageEvent: {
              type: 'toolcall_delta',
              contentIndex: 0,
              delta: ' "src"}',
            },
          }
          yield { type: 'message_end', message: assistantMessage('Done') }
        })()
      })

      const toolDeltas: string[] = []
      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      await loop.run([createUserMessage('test')], {
        onToolCallDelta: (index, delta, toolCallId) => toolDeltas.push(`${index}:${toolCallId || 'none'}:${delta}`),
      })

      expect(toolDeltas).toEqual(['0:call_1:{"path":', '0:call_1: "src"}'])
    })
  })

  describe('cancel()', () => {
    it('should cancel running loop without onError', async () => {
      mockAgentLoopContinue.mockImplementation((_context: any, _config: any, signal?: AbortSignal) => {
        return (async function* () {
          yield { type: 'message_end', message: assistantMessage('first chunk') }
          for (let i = 0; i < 50; i++) {
            if (signal?.aborted) return
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
          yield { type: 'message_end', message: assistantMessage('final') }
        })()
      })

      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      const callbacks = { onError: vi.fn() }
      const runPromise = loop.run([createUserMessage('test')], callbacks)
      await new Promise((resolve) => setTimeout(resolve, 20))
      loop.cancel()

      const result = await runPromise
      expect(callbacks.onError).not.toHaveBeenCalled()
      expect(result.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('error handling', () => {
    it('should handle provider errors', async () => {
      mockAgentLoopContinue.mockImplementation(() => {
        return (async function* () {
          throw new Error('Provider error')
        })()
      })

      const callbacks = { onError: vi.fn() }
      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      await expect(loop.run([createUserMessage('test')], callbacks)).rejects.toThrow('Provider error')
      expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Provider error' }))
    })

    it('preserves the latest tool result when no real usage triggers compression', async () => {
      let convertedMessages: any[] = []
      mockProvider.estimateTokens = vi.fn((messages: ChatMessage[]) => {
        return messages.reduce((sum, msg) => {
          const content = typeof msg.content === 'string' ? msg.content.length : 0
          return sum + content
        }, 0)
      }) as any
      mockContextManager.getConfig.mockReturnValue({
        systemPrompt: 'sys',
        maxContextTokens: 200,
        reserveTokens: 20,
      })

      mockAgentLoopContinue.mockImplementation((_context: any, config: any) => {
        return (async function* () {
          convertedMessages = await config.convertToLlm([
            createUserMessage('Please read big file'),
            toolResultMessage('call_read_1', 'read', 'x'.repeat(500)),
          ])
          yield { type: 'message_end', message: assistantMessage('ok') }
        })()
      })

      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
      })

      const result = await loop.run([createUserMessage('test')])

      expect(result.some((m) => m.role === 'assistant')).toBe(true)
      const degradedToolMessage = convertedMessages.find(
        (m: any) => m.role === 'toolResult' && m.toolCallId === 'call_read_1'
      )
      expect(degradedToolMessage).toBeDefined()
      expect(Array.isArray(degradedToolMessage.content)).toBe(true)
      expect(degradedToolMessage.content[0]?.type).toBe('text')
      expect(degradedToolMessage.content[0]?.text).toBe('x'.repeat(500))
    })

    it('should stop gracefully at maxIterations in Pi loop', async () => {
      mockAgentLoopContinue.mockImplementation(() => {
        return (async function* () {
          yield { type: 'message_end', message: assistantMessage('1') }
          yield { type: 'message_end', message: assistantMessage('2') }
          yield { type: 'message_end', message: assistantMessage('3') }
        })()
      })

      const onLoopComplete = vi.fn(async () => {})
      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
        maxIterations: 2,
        onLoopComplete,
      })

      const callbacks = {
        onIterationLimitReached: vi.fn(),
        onComplete: vi.fn(),
      }
      const result = await loop.run([createUserMessage('test')], callbacks)
      expect(result.filter((m) => m.role === 'assistant')).toHaveLength(2)
      expect(callbacks.onIterationLimitReached).toHaveBeenCalledWith(2)
      expect(callbacks.onComplete).toHaveBeenCalledOnce()
      expect(onLoopComplete).toHaveBeenCalledOnce()
    })

    it('treats maxIterations=0 as unlimited in Pi loop', async () => {
      mockAgentLoopContinue.mockImplementation(() => {
        return (async function* () {
          for (let i = 1; i <= 25; i += 1) {
            yield { type: 'message_end', message: assistantMessage(String(i)) }
          }
        })()
      })

      const loop = new AgentLoop({
        provider: mockProvider,
        toolRegistry: mockTools,
        contextManager: mockContextManager,
        toolContext: createMockToolContext(),
        maxIterations: 0,
      })

      const callbacks = {
        onIterationLimitReached: vi.fn(),
        onComplete: vi.fn(),
      }
      const result = await loop.run([createUserMessage('test')], callbacks)
      expect(result.filter((m) => m.role === 'assistant')).toHaveLength(25)
      expect(callbacks.onIterationLimitReached).not.toHaveBeenCalled()
      expect(callbacks.onComplete).toHaveBeenCalledOnce()
    })
  })
})
