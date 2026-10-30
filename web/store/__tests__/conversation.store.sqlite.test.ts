import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createToolMessage, createUserMessage } from '@/agent/message-types'
import { useConversationRuntimeStore } from '../conversation-runtime.store'

const deleteWorkspaceMock = vi.fn(() => Promise.resolve())
const conversationRepoDeleteMock = vi.fn(() => Promise.resolve())
const conversationRepoSaveMetaMock = vi.fn((..._: [Record<string, unknown>]) => Promise.resolve())
const conversationRepoUpdateKindMock = vi.fn((_id: string, _kind: 'project' | 'direct') => Promise.resolve())
const messageRepoInsertMock = vi.fn(() => Promise.resolve())
const messageRepoReplaceAllMock = vi.fn(() => Promise.resolve())
const toastErrorMock = vi.fn()

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: vi.fn(),
  },
}))

vi.mock('@/streaming-bus', () => ({
  emitThinkingStart: vi.fn(),
  emitThinkingDelta: vi.fn(),
  emitCompressionEvent: vi.fn(),
  emitToolStart: vi.fn(),
  emitComplete: vi.fn(),
  emitError: vi.fn(),
}))

vi.mock('../conversation-context.store', () => ({
  getActiveConversation: vi.fn(() => null),
  useConversationContextStore: {
    getState: vi.fn(() => ({
      activeWorkspaceId: null,
      workspaces: [],
      createWorkspace: vi.fn(() => Promise.resolve()),
      switchWorkspace: vi.fn(() => Promise.resolve()),
      refreshWorkspaces: vi.fn(() => Promise.resolve()),
      refreshPendingChanges: vi.fn(() => Promise.resolve()),
      deleteWorkspace: deleteWorkspaceMock,
    })),
  },
}))

vi.mock('../settings.store', () => {
  const mockSettingsState = {
    providerType: 'openai',
    modelName: 'mock-model',
    maxIterations: 20,
    getEffectiveProviderConfig: vi.fn(() => ({
      apiKeyProviderKey: 'openai',
      baseUrl: 'https://example.com',
      modelName: 'mock-model',
    })),
  }

  return {
    useSettingsStore: {
      getState: vi.fn(() => mockSettingsState),
    },
    __mockSettingsState: mockSettingsState,
  }
})

const conversationRepoMock = {
  findAll: vi.fn(() => Promise.resolve([])),
  findAllMeta: vi.fn(() => Promise.resolve([])),
  save: vi.fn(() => Promise.resolve()),
  saveMeta: conversationRepoSaveMetaMock,
  updateKind: conversationRepoUpdateKindMock,
  touch: vi.fn(() => Promise.resolve()),
  delete: conversationRepoDeleteMock,
}

vi.mock('@/sqlite', () => ({
  initSQLiteDB: vi.fn(() => Promise.resolve()),
  getApiKeyRepository: vi.fn(() => ({
    load: vi.fn(() => Promise.resolve('test-key')),
  })),
  getConversationRepository: vi.fn(() => conversationRepoMock),
  getMessageRepository: vi.fn(() => ({
    findByConversation: vi.fn(() => Promise.resolve([])),
    insert: messageRepoInsertMock,
    replaceAll: messageRepoReplaceAllMock,
    migrateFromJsonBlob: vi.fn(() => Promise.resolve({ conversations: 0, messages: 0 })),
    recoverFromAppSessions: vi.fn(() =>
      Promise.resolve({ sessions: 0, conversations: 0, messages: 0 })
    ),
  })),
  getSQLiteDB: vi.fn(() => ({
    queryFirst: vi.fn(() => Promise.resolve({ count: 0 })),
  })),
}))

vi.mock('@/agent/providers/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/providers/types')>()
  return {
    ...actual,
    LLM_PROVIDER_CONFIGS: {
      ...actual.LLM_PROVIDER_CONFIGS,
      openai: {
        ...actual.LLM_PROVIDER_CONFIGS.openai,
        baseURL: 'https://example.com',
        modelName: 'mock-model',
      },
    },
    isCustomProviderType: vi.fn(() => false),
  }
})

vi.mock('@/agent/llm/provider-factory', () => ({
  createLLMProvider: vi.fn(() => ({
    maxContextTokens: 128000,
  })),
}))

vi.mock('@/agent/context-manager', () => ({
  ContextManager: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('@/agent/tool-registry', () => ({
  getToolRegistry: vi.fn(() => ({})),
}))

vi.mock('@/agent/follow-up-generator', () => ({
  generateFollowUp: vi.fn(() => Promise.resolve('')),
}))

vi.mock('@/mcp/elicitation-handler.tsx', () => ({
  getElicitationHandler: vi.fn(() => ({
    handleBinaryElicitation: vi.fn(() => Promise.resolve({})),
  })),
}))

vi.mock('@/agent/agent-loop', () => {
  class MockAgentLoop {
    private config: any

    constructor(config: any) {
      this.config = config
      ;(globalThis as any).__lastAgentLoopConfig = config
    }

    cancel() {}

    async run(messages: any[], callbacks: any) {
      const customRun = (globalThis as any).__conversationStoreCustomRun
      if (typeof customRun === 'function') {
        const result = await customRun(messages, callbacks)
        this.config.onCompressionStateUpdate?.({
          convertCallCount: 17,
          lastSummaryConvertCall: 9,
        })
        return result
      }

      const beforeCompressionStart = (globalThis as any).__conversationStoreBeforeCompressionStart
      beforeCompressionStart?.()
      callbacks.onContextCompressionStart?.({
        droppedGroups: 1,
        droppedContentChars: 128,
      })
      ;(globalThis as any).__conversationStoreTestHook?.('after_compression_start')

      const toolA = {
        id: 'call_A',
        type: 'function',
        function: { name: 'glob', arguments: '{}' },
      }
      const toolB = {
        id: 'call_B',
        type: 'function',
        function: { name: 'list_files', arguments: '{}' },
      }

      callbacks.onToolCallStart?.(toolA)
      callbacks.onToolCallStart?.(toolB)
      callbacks.onToolCallDelta?.(0, '{"path":"a"', 'call_A')
      ;(globalThis as any).__conversationStoreTestHook?.('after_a_delta')

      callbacks.onToolCallComplete?.(toolA, 'result A')
      ;(globalThis as any).__conversationStoreTestHook?.('after_a_complete')

      callbacks.onToolCallDelta?.(1, '{"path":"b"', 'call_B')
      ;(globalThis as any).__conversationStoreTestHook?.('after_b_delta')

      callbacks.onToolCallComplete?.(toolB, 'result B')
      ;(globalThis as any).__conversationStoreTestHook?.('after_b_complete')

      this.config.onCompressionStateUpdate?.({
        convertCallCount: 17,
        lastSummaryConvertCall: 9,
      })

      return [
        ...messages,
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'Done',
          timestamp: Date.now(),
        },
      ]
    }
  }

  return {
    AgentLoop: MockAgentLoop,
  }
})

import { useConversationStore } from '../conversation.store'
import { findSpawnStepInDraft } from '../conversation.store.sqlite'
import { clearAgentLoops, setAgentLoop } from '../agent-loop-registry'
import { clearStreamingQueues } from '../streaming-queue-registry'

describe('conversation.store.sqlite tool-call routing', () => {
  beforeEach(() => {
    deleteWorkspaceMock.mockClear()
    conversationRepoDeleteMock.mockClear()
    conversationRepoSaveMetaMock.mockReset()
    conversationRepoSaveMetaMock.mockResolvedValue(undefined)
    conversationRepoUpdateKindMock.mockReset()
    conversationRepoUpdateKindMock.mockResolvedValue(undefined)
    messageRepoInsertMock.mockReset()
    messageRepoInsertMock.mockResolvedValue(undefined)
    messageRepoReplaceAllMock.mockReset()
    messageRepoReplaceAllMock.mockResolvedValue(undefined)
    conversationRepoMock.findAll.mockReset()
    conversationRepoMock.findAll.mockResolvedValue([])
    conversationRepoMock.findAllMeta.mockReset()
    conversationRepoMock.findAllMeta.mockResolvedValue([])
    clearAgentLoops()
    clearStreamingQueues()
    toastErrorMock.mockClear()
    useConversationRuntimeStore.setState({ runtimes: new Map() })
    useConversationStore.setState({
      conversations: [],
      activeConversationId: null,
      loaded: true,
      suggestedFollowUps: new Map(),
      cancelledRunIds: new Set(),
      mountedConversations: new Map(),
    } as any)
    delete (globalThis as any).__conversationStoreTestHook
    delete (globalThis as any).__conversationStoreBeforeCompressionStart
    delete (globalThis as any).__lastAgentLoopConfig
    delete (globalThis as any).__conversationStoreCustomRun
  })

  it('routes a subagent event to its owning spawn call instead of the active one', () => {
    const toolCallA = { id: 'spawn-a', type: 'function' as const, function: { name: 'spawn_subagent', arguments: '{}' } }
    const toolCallB = { id: 'spawn-b', type: 'function' as const, function: { name: 'spawn_subagent', arguments: '{}' } }
    const draft = {
      activeToolStepId: 'step-b',
      steps: [
        { id: 'step-a', type: 'tool_call' as const, toolCall: toolCallA, args: '{}', streaming: true },
        { id: 'step-b', type: 'tool_call' as const, toolCall: toolCallB, args: '{}', streaming: true },
      ],
    }

    expect(findSpawnStepInDraft(draft, 'spawn-a')?.toolCall.id).toBe('spawn-a')
    expect(findSpawnStepInDraft(draft, 'missing')).toBeUndefined()
  })

  it('should wait for new conversation metadata before persisting the first message', async () => {
    let resolveMeta!: () => void
    const metaPersisted = new Promise<void>((resolve) => {
      resolveMeta = resolve
    })
    conversationRepoSaveMetaMock.mockReturnValueOnce(metaPersisted)

    const conv = useConversationStore.getState().createNew('new-chat-race')
    useConversationStore.getState().addMessage(conv.id, createUserMessage('hello'))

    await Promise.resolve()
    await Promise.resolve()
      expect(messageRepoInsertMock).not.toHaveBeenCalled()

    resolveMeta()
    await metaPersisted
    await vi.waitFor(() => {
      expect(messageRepoInsertMock).toHaveBeenCalledTimes(1)
    })
  })

  it('should finalize non-current tool steps by toolCallId in interleaved calls', async () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('test')

    const snapshots: Array<{
      label: string
      currentToolCallId: string | null
      stepA?: { streaming: boolean; args: string; result?: string }
      stepB?: { streaming: boolean; args: string; result?: string }
    }> = []

    ;(globalThis as any).__conversationStoreTestHook = (label: string) => {
      const runtime = useConversationRuntimeStore.getState().runtimes.get(conv.id)
      const stepA = runtime?.draftAssistant?.steps.find(
        (s) => s.type === 'tool_call' && s.toolCall.id === 'call_A'
      ) as any
      const stepB = runtime?.draftAssistant?.steps.find(
        (s) => s.type === 'tool_call' && s.toolCall.id === 'call_B'
      ) as any
      snapshots.push({
        label,
        currentToolCallId: runtime?.currentToolCall?.id || null,
        stepA: stepA
          ? { streaming: stepA.streaming, args: stepA.args, result: stepA.result }
          : undefined,
        stepB: stepB
          ? { streaming: stepB.streaming, args: stepB.args, result: stepB.result }
          : undefined,
      })
    }

    await useConversationStore
      .getState()
      .runAgent(conv.id, 'openai' as any, 'mock-model', 1024, null)

    const aComplete = snapshots.find((s) => s.label === 'after_a_complete')
    expect(aComplete).toBeDefined()
    expect(aComplete?.currentToolCallId).toBe('call_B')
    expect(aComplete?.stepA?.streaming).toBe(false)
    expect(aComplete?.stepA?.result).toBe('result A')
    expect(aComplete?.stepB?.streaming).toBe(true)

    const bDelta = snapshots.find((s) => s.label === 'after_b_delta')
    expect(bDelta?.stepB?.args).toContain('{"path":"b"')

    const bComplete = snapshots.find((s) => s.label === 'after_b_complete')
    expect(bComplete?.stepB?.streaming).toBe(false)
    expect(bComplete?.stepB?.result).toBe('result B')
  })

  it('should pass maxIterations from settings store into AgentLoop', async () => {
    const settingsModule = await import('../settings.store')
    ;(settingsModule as any).__mockSettingsState.maxIterations = 37

    const store = useConversationStore.getState()
    const conv = store.createNew('max-iterations-prop')

    await useConversationStore
      .getState()
      .runAgent(conv.id, 'openai' as any, 'mock-model', 1024, null)

    const agentLoopConfig = (globalThis as any).__lastAgentLoopConfig
    expect(agentLoopConfig?.maxIterations).toBe(37)
  })

  it('should persist latest context usage metadata after run completion', async () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('context-usage-persist')
    useConversationStore.getState().addMessage(conv.id, createUserMessage('hello'))
    expect(conversationRepoSaveMetaMock).toHaveBeenCalled()
    conversationRepoSaveMetaMock.mockClear()
    useConversationStore.setState((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conv.id
          ? {
            ...c,
            lastContextWindowUsage: {
              usedTokens: 1234,
              maxTokens: 4096,
              reserveTokens: 1024,
              usagePercent: 24,
              modelMaxTokens: 5120,
            },
            contextWindowUsage: {
              usedTokens: 1234,
              maxTokens: 4096,
              reserveTokens: 1024,
              usagePercent: 24,
              modelMaxTokens: 5120,
            },
          }
          : c
      ),
    }))

    await useConversationStore
      .getState()
      .runAgent(conv.id, 'openai' as any, 'mock-model', 1024, null)
    const afterRun = useConversationStore.getState().conversations.find((c) => c.id === conv.id)
    expect(afterRun?.error).toBeNull()

    await vi.waitFor(() => {
      expect(conversationRepoSaveMetaMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: conv.id,
          contextUsage: expect.objectContaining({
            usedTokens: 1234,
            maxTokens: 4096,
            reserveTokens: 1024,
            modelMaxTokens: 5120,
          }),
        })
      )
    })
  })

  it('should derive context usage from assistant total tokens on completion', async () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('context-usage-finalize-fallback')
    useConversationStore.getState().addMessage(conv.id, createUserMessage('hello'))

    ;(globalThis as any).__conversationStoreCustomRun = async (messages: any[], callbacks: any) => {
      const assistantWithUsage = createAssistantMessage('done')
      assistantWithUsage.usage = {
        promptTokens: 456,
        completionTokens: 789,
        totalTokens: 1245,
      }
      callbacks.onMessagesUpdated?.([...messages, assistantWithUsage])
      return [...messages, assistantWithUsage]
    }

    await useConversationStore
      .getState()
      .runAgent(conv.id, 'openai' as any, 'mock-model', 1024, null)

    const updated = useConversationStore.getState().conversations.find((c) => c.id === conv.id)
    expect(updated?.contextWindowUsage?.usedTokens).toBe(1245)
    expect(updated?.contextWindowUsage?.reserveTokens).toBe(1024)
    expect(updated?.contextWindowUsage?.modelMaxTokens).toBe(128000)
  })

  it('should sync context usage immediately from assistant usage when no context callback in run', async () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('context-usage-immediate-sync')
    useConversationStore.getState().addMessage(conv.id, createUserMessage('hello'))

    let usedTokensDuringOnMessagesUpdated: number | null = null
    ;(globalThis as any).__conversationStoreCustomRun = async (messages: any[], callbacks: any) => {
      const assistantWithUsage = createAssistantMessage('done')
      assistantWithUsage.usage = {
        promptTokens: 4300,
        completionTokens: 120,
        totalTokens: 4420,
      }
      callbacks.onMessagesUpdated?.([...messages, assistantWithUsage])
      const current = useConversationStore.getState().conversations.find((c) => c.id === conv.id)
      usedTokensDuringOnMessagesUpdated = current?.contextWindowUsage?.usedTokens ?? null
      return [...messages, assistantWithUsage]
    }

    await useConversationStore
      .getState()
      .runAgent(conv.id, 'openai' as any, 'mock-model', 1024, null)

    expect(usedTokensDuringOnMessagesUpdated).toBe(4420)
  })

  it('should still sync usage on message_end when activeRunId becomes null in same epoch', async () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('context-usage-same-epoch')
    useConversationStore.getState().addMessage(conv.id, createUserMessage('hello'))

    ;(globalThis as any).__conversationStoreCustomRun = async (messages: any[], callbacks: any) => {
      useConversationStore.setState((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conv.id ? { ...c, activeRunId: null } : c
        ),
      }))
      const assistantWithUsage = createAssistantMessage('done')
      assistantWithUsage.usage = {
        promptTokens: 4310,
        completionTokens: 10,
        totalTokens: 4320,
      }
      callbacks.onMessagesUpdated?.([...messages, assistantWithUsage])
      return [...messages, assistantWithUsage]
    }

    await useConversationStore
      .getState()
      .runAgent(conv.id, 'openai' as any, 'mock-model', 1024, null)

    const updated = useConversationStore.getState().conversations.find((c) => c.id === conv.id)
    expect(updated?.lastContextWindowUsage?.usedTokens).toBe(4320)
    const runtime = useConversationRuntimeStore.getState().runtimes.get(conv.id)
    expect(runtime?.contextWindowUsage?.usedTokens).toBe(4320)
  })

  it('should process onMessagesUpdated when activeRunId is cleared but runtime epoch matches', async () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('context-usage-runtime-epoch')
    useConversationStore.getState().addMessage(conv.id, createUserMessage('hello'))

    ;(globalThis as any).__conversationStoreCustomRun = async (messages: any[], callbacks: any) => {
      useConversationStore.setState((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conv.id ? { ...c, activeRunId: null } : c
        ),
      }))
      useConversationRuntimeStore.setState((state) => {
        const rt = state.runtimes.get(conv.id)
        if (rt) {
          rt.activeRunId = null
        }
      })
      const assistantWithUsage = createAssistantMessage('done')
      assistantWithUsage.usage = {
        promptTokens: 4201,
        completionTokens: 99,
        totalTokens: 4300,
      }
      callbacks.onMessagesUpdated?.([...messages, assistantWithUsage])
      return [...messages, assistantWithUsage]
    }

    await useConversationStore
      .getState()
      .runAgent(conv.id, 'openai' as any, 'mock-model', 1024, null)

    const updated = useConversationStore.getState().conversations.find((c) => c.id === conv.id)
    expect(updated?.lastContextWindowUsage?.usedTokens).toBe(4300)
  })

  it('should override stale previous-run usage at finalize when current run lacks context callback', async () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('context-usage-stale-override')
    useConversationStore.getState().addMessage(conv.id, createUserMessage('hello'))

    // Simulate stale usage from previous run (e.g. 832)
    useConversationStore.setState((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conv.id
          ? {
            ...c,
            contextWindowUsage: {
              usedTokens: 832,
              maxTokens: 198000,
              reserveTokens: 2000,
              usagePercent: 0.42,
              modelMaxTokens: 200000,
            },
            lastContextWindowUsage: {
              usedTokens: 832,
              maxTokens: 198000,
              reserveTokens: 2000,
              usagePercent: 0.42,
              modelMaxTokens: 200000,
            },
          }
          : c
      ),
    }))

    ;(globalThis as any).__conversationStoreCustomRun = async (messages: any[], callbacks: any) => {
      const assistantWithUsage = createAssistantMessage('done')
      assistantWithUsage.usage = {
        promptTokens: 4200,
        completionTokens: 104,
        totalTokens: 4304,
      }
      callbacks.onMessagesUpdated?.([...messages, assistantWithUsage])
      return [...messages, assistantWithUsage]
    }

    await useConversationStore
      .getState()
      .runAgent(conv.id, 'openai' as any, 'mock-model', 1024, null)

    const updated = useConversationStore.getState().conversations.find((c) => c.id === conv.id)
    expect(updated?.lastContextWindowUsage?.usedTokens).toBe(4304)
    const runtime = useConversationRuntimeStore.getState().runtimes.get(conv.id)
    expect(runtime?.contextWindowUsage?.usedTokens).toBe(4304)
  })

  it('should carry compression counters across runAgent invocations', async () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('compression-state-carry')

    await useConversationStore
      .getState()
      .runAgent(conv.id, 'openai' as any, 'mock-model', 1024, null)

    const firstRunConfig = (globalThis as any).__lastAgentLoopConfig
    expect(firstRunConfig?.initialConvertCallCount ?? 0).toBe(0)
    expect(firstRunConfig?.initialLastSummaryConvertCall ?? Number.NEGATIVE_INFINITY).toBe(
      Number.NEGATIVE_INFINITY
    )

    await useConversationStore
      .getState()
      .runAgent(conv.id, 'openai' as any, 'mock-model', 1024, null)

    const secondRunConfig = (globalThis as any).__lastAgentLoopConfig
    expect(secondRunConfig?.initialConvertCallCount).toBe(17)
    expect(secondRunConfig?.initialLastSummaryConvertCall).toBe(9)
  })

  it('should reflect onMessagesUpdated into store messages during an active run', async () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('live-messages-during-run')
    const user = createUserMessage('hello')
    useConversationStore.getState().updateMessages(conv.id, [user])

    let messagesLengthSeenInsideRun = -1
    ;(globalThis as any).__conversationStoreCustomRun = async (messages: any[], callbacks: any) => {
      const liveAssistantMessage = {
        id: 'assistant-live-1',
        role: 'assistant',
        content: 'streamed chunk complete',
        timestamp: Date.now(),
      }
      callbacks.onMessagesUpdated?.([...messages, liveAssistantMessage])
      const current = useConversationStore.getState().conversations.find((x) => x.id === conv.id)
      messagesLengthSeenInsideRun = current?.messages.length ?? -1
      return [...messages, liveAssistantMessage]
    }

    await useConversationStore
      .getState()
      .runAgent(conv.id, 'openai' as any, 'mock-model', 1024, null)

    expect(messagesLengthSeenInsideRun).toBe(2)
  })

  it('should delete only the specified user message', () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('delete-user')

    const u1 = createUserMessage('u1')
    const a1 = createAssistantMessage('a1')
    const t1 = createToolMessage({ toolCallId: 'tc-1', name: 'file_read', content: 'r1' })
    const u2 = createUserMessage('u2')

    useConversationStore.getState().updateMessages(conv.id, [u1, a1, t1, u2])

    const ok = useConversationStore.getState().deleteUserMessage(conv.id, u1.id)
    expect(ok).toBe(true)

    const updated = useConversationStore.getState().conversations.find((x) => x.id === conv.id)
    expect(updated?.messages.map((m) => m.id)).toEqual([a1.id, t1.id, u2.id])
  })

  it('keeps automatic titles tied to human input when internal records survive deletion', () => {
    const conv = useConversationStore.getState().createNew('title-boundaries')
    const first = createUserMessage('First question')
    const second = createUserMessage('Second question')
    const context = { ...createUserMessage('PRIVATE_RUNTIME'), kind: 'context_update' as const }
    const delegation = { ...createUserMessage('PRIVATE_TASK'), delegationNote: { fromAgentId: 'a', task: 'task' } }
    useConversationStore.getState().updateMessages(conv.id, [first, context, delegation, second])
    expect(useConversationStore.getState().deleteUserMessage(conv.id, first.id)).toBe(true)
    let updated = useConversationStore.getState().conversations.find(c => c.id === conv.id)
    expect(updated?.title).toBe('Second question')
    expect(updated?.messages).toHaveLength(3)
    expect(useConversationStore.getState().deleteUserMessage(conv.id, second.id)).toBe(true)
    updated = useConversationStore.getState().conversations.find(c => c.id === conv.id)
    expect(updated?.title).toBe('New Chat')
    expect(updated?.messages).toHaveLength(2)
  })

  it('does not generate automatic titles from agent-only input', () => {
    const conv = useConversationStore.getState().createNew('agent-only')
    const before = useConversationStore.getState().conversations.find(c => c.id === conv.id)?.title
    useConversationStore.getState().addMessage(conv.id, {
      ...createUserMessage('PRIVATE_TASK'), delegationNote: { fromAgentId: 'a', task: 'task' },
    })
    expect(useConversationStore.getState().conversations.find(c => c.id === conv.id)?.title).toBe(before)
  })

  it('should delete a whole agent loop from user message to before next user message', () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('delete-loop')

    const u1 = createUserMessage('u1')
    const a1 = createAssistantMessage('a1')
    const t1 = createToolMessage({ toolCallId: 'tc-1', name: 'file_read', content: 'r1' })
    const u2 = createUserMessage('u2')
    const a2 = createAssistantMessage('a2')

    useConversationStore.getState().updateMessages(conv.id, [u1, a1, t1, u2, a2])

    const ok = useConversationStore.getState().deleteAgentLoop(conv.id, u1.id)
    expect(ok).toBe(true)

    const updated = useConversationStore.getState().conversations.find((x) => x.id === conv.id)
    expect(updated?.messages.map((m) => m.id)).toEqual([u2.id, a2.id])
  })

  it('should block loop deletion while conversation is running', () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('running-delete')
    const u1 = createUserMessage('u1')
    const a1 = createAssistantMessage('a1')
    useConversationStore.getState().updateMessages(conv.id, [u1, a1])

    useConversationStore.setState((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conv.id ? { ...c, status: 'streaming' as const } : c
      ),
    }))

    const ok = useConversationStore.getState().deleteAgentLoop(conv.id, u1.id)
    expect(ok).toBe(false)

    const updated = useConversationStore.getState().conversations.find((x) => x.id === conv.id)
    expect(updated?.messages.map((m) => m.id)).toEqual([u1.id, a1.id])
  })

  it('should delete multiple conversations in one action', async () => {
    const store = useConversationStore.getState()
    const conv1 = store.createNew('batch-1')
    const conv2 = store.createNew('batch-2')
    const conv3 = store.createNew('batch-3')
    await store.setActive(conv2.id)

    // include duplicate ids and a non-existing id
    const result = await useConversationStore
      .getState()
      .deleteConversations([conv1.id, conv2.id, conv2.id, 'missing-id'])

    const state = useConversationStore.getState()
    expect(state.activeConversationId).toBeNull()
    expect(state.conversations.map((c) => c.id)).toEqual([conv3.id])
    expect(result).toEqual({
      successIds: [conv1.id, conv2.id, 'missing-id'],
      failed: [],
    })
    expect(conversationRepoDeleteMock).toHaveBeenCalledTimes(3)
    expect(deleteWorkspaceMock).toHaveBeenCalledTimes(3)
    expect(conversationRepoDeleteMock).toHaveBeenCalledWith(conv1.id)
    expect(conversationRepoDeleteMock).toHaveBeenCalledWith(conv2.id)
    expect(conversationRepoDeleteMock).toHaveBeenCalledWith('missing-id')
  })

  it('should remove conversation even when workspace deletion fails', async () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('delete-fail')
    // Workspace (OPFS) deletion fails, but the conversation DB record delete
    // succeeds. The conversation should still be removed from memory — it is
    // already gone from the DB, so keeping it would be a ghost. Workspace
    // failure is treated as non-fatal (orphan dir can be GC'd later).
    deleteWorkspaceMock.mockRejectedValueOnce(new Error('opfs delete failed'))

    await useConversationStore.getState().deleteConversation(conv.id)

    const state = useConversationStore.getState()
    expect(state.conversations.some((c) => c.id === conv.id)).toBe(false)
    if (state.activeConversationId === conv.id) {
      expect(state.activeConversationId).toBeNull()
    }
  })

  it('should keep conversation when DB deletion fails', async () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('db-delete-fail')
    // The conversation record itself could not be deleted from the DB.
    // In-memory state must stay in sync with the DB, so the conversation is
    // kept and the error is surfaced.
    conversationRepoDeleteMock.mockRejectedValueOnce(new Error('db delete failed'))

    await expect(useConversationStore.getState().deleteConversation(conv.id)).rejects.toThrow(
      /delete conversation failed/i
    )

    const state = useConversationStore.getState()
    expect(state.conversations.some((c) => c.id === conv.id)).toBe(true)
  })

  it('should retitle to next user message when deleting the first auto-titled loop', () => {
    const store = useConversationStore.getState()
    const conv = store.createNew()

    const u1 = createUserMessage('first title source')
    const a1 = createAssistantMessage('a1')
    const u2 = createUserMessage('second title source')
    const a2 = createAssistantMessage('a2')

    useConversationStore.getState().addMessage(conv.id, u1)
    useConversationStore.getState().addMessage(conv.id, a1)
    useConversationStore.getState().addMessage(conv.id, u2)
    useConversationStore.getState().addMessage(conv.id, a2)

    const before = useConversationStore.getState().conversations.find((x) => x.id === conv.id)
    expect(before?.title).toBe('first title source')

    const ok = useConversationStore.getState().deleteAgentLoop(conv.id, u1.id)
    expect(ok).toBe(true)

    const updated = useConversationStore.getState().conversations.find((x) => x.id === conv.id)
    expect(updated?.messages.map((m) => m.id)).toEqual([u2.id, a2.id])
    expect(updated?.title).toBe('second title source')
  })

  it('should keep manual title unchanged when deleting the first loop', () => {
    const store = useConversationStore.getState()
    const conv = store.createNew()

    const u1 = createUserMessage('first title source')
    const a1 = createAssistantMessage('a1')
    const u2 = createUserMessage('second title source')
    const a2 = createAssistantMessage('a2')

    useConversationStore.getState().addMessage(conv.id, u1)
    useConversationStore.getState().addMessage(conv.id, a1)
    useConversationStore.getState().addMessage(conv.id, u2)
    useConversationStore.getState().addMessage(conv.id, a2)
    useConversationStore.getState().updateTitle(conv.id, 'first title source')

    const ok = useConversationStore.getState().deleteAgentLoop(conv.id, u1.id)
    expect(ok).toBe(true)

    const updated = useConversationStore.getState().conversations.find((x) => x.id === conv.id)
    expect(updated?.messages.map((m) => m.id)).toEqual([u2.id, a2.id])
    expect(updated?.title).toBe('first title source')
  })

  it('should regenerate by clearing all non-user messages in the target turn', () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('regen-clear-turn')

    const u1 = createUserMessage('u1')
    const a1 = createAssistantMessage('a1')
    const t1 = createToolMessage({ toolCallId: 'tc-1', name: 'read', content: 'r1' })
    const t2 = createToolMessage({ toolCallId: 'tc-2', name: 'search', content: 'r2' })
    const u2 = createUserMessage('u2')
    const a2 = createAssistantMessage('a2')

    useConversationStore.getState().updateMessages(conv.id, [u1, a1, t1, t2, u2, a2])

    useConversationStore.getState().regenerateUserMessage(conv.id, u1.id)

    const updated = useConversationStore.getState().conversations.find((x) => x.id === conv.id)
    expect(updated?.messages.map((m) => m.id)).toEqual([u1.id, u2.id, a2.id])
    expect(updated?.messages[0]?.role).toBe('user')
  })

  it('keeps the runtime status pending when compression starts before content or tool streaming', async () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('compression-pending')

    const snapshots: Array<{ label: string; status: string | undefined }> = []
    ;(globalThis as any).__conversationStoreTestHook = (label: string) => {
      const runtime = useConversationRuntimeStore.getState().runtimes.get(conv.id)
      snapshots.push({ label, status: runtime?.status })
    }

    await useConversationStore
      .getState()
      .runAgent(conv.id, 'openai' as any, 'mock-model', 1024, null)

    const compressionStart = snapshots.find((s) => s.label === 'after_compression_start')
    expect(compressionStart?.status).toBe('pending')
  })

  it('should keep streamed assistant text on cancel and discard pending tool call', () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('cancel-keep-partial')
    const user = createUserMessage('hello')
    useConversationStore.getState().updateMessages(conv.id, [user])

    const cancelSpy = vi.fn()
    const pendingToolCall = {
      id: 'tool-pending-1',
      type: 'function' as const,
      function: {
        name: 'read',
        arguments: '{"path":"README.md"}',
      },
    }

    useConversationStore.setState((state) => {
      const target = state.conversations.find((c) => c.id === conv.id)
      if (!target) return state
      target.status = 'tool_calling'
      target.activeRunId = 'run-1'
      target.currentToolCall = pendingToolCall
      target.activeToolCalls = [pendingToolCall]
      target.streamingContent = 'partial answer'
      target.streamingReasoning = 'thinking...'
      target.draftAssistant = {
        reasoning: 'thinking...',
        content: 'partial answer',
        toolCalls: [pendingToolCall],
        toolResults: {},
        toolCall: pendingToolCall,
        toolArgs: '{"path":"README.md"}',
        steps: [],
        activeReasoningStepId: null,
        activeContentStepId: null,
        activeToolStepId: `tool-${pendingToolCall.id}`,
        activeCompressionStepId: null,
      }
      setAgentLoop(conv.id, { cancel: cancelSpy } as any)
      return state
    })

    useConversationStore.getState().cancelAgent(conv.id)

    const updated = useConversationStore.getState().conversations.find((c) => c.id === conv.id)
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(updated?.status).toBe('idle')
    expect(updated?.activeRunId).toBeNull()
    expect(updated?.draftAssistant).toBeNull()
    expect(updated?.currentToolCall).toBeNull()
    expect(updated?.activeToolCalls).toEqual([])

    const assistantMessages = (updated?.messages || []).filter((m) => m.role === 'assistant')
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0].content).toBe('partial answer')
    expect(assistantMessages[0].reasoning).toBe('thinking...')
    expect(assistantMessages[0].toolCalls).toBeUndefined()
  })

  it('should keep completed draft tool call/result pairs on cancel and discard pending ones', () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('cancel-keep-completed-tools')
    const user = createUserMessage('hello')
    useConversationStore.getState().updateMessages(conv.id, [user])

    const cancelSpy = vi.fn()
    const completedToolCall = {
      id: 'tool-done-1',
      type: 'function' as const,
      function: {
        name: 'read',
        arguments: '{"path":"README.md"}',
      },
    }
    const pendingToolCall = {
      id: 'tool-pending-1',
      type: 'function' as const,
      function: {
        name: 'search',
        arguments: '{"query":"cancel"}',
      },
    }

    useConversationStore.setState((state) => {
      const target = state.conversations.find((c) => c.id === conv.id)
      if (!target) return state
      target.status = 'tool_calling'
      target.activeRunId = 'run-2'
      target.currentToolCall = pendingToolCall
      target.activeToolCalls = [pendingToolCall]
      target.streamingContent = 'partial answer'
      target.streamingReasoning = 'thinking...'
      target.draftAssistant = {
        reasoning: 'thinking...',
        content: 'partial answer',
        toolCalls: [completedToolCall, pendingToolCall],
        toolResults: {
          [completedToolCall.id]: 'README content',
        },
        toolCall: pendingToolCall,
        toolArgs: '{"query":"cancel"}',
        steps: [],
        activeReasoningStepId: null,
        activeContentStepId: null,
        activeToolStepId: `tool-${pendingToolCall.id}`,
        activeCompressionStepId: null,
      }
      setAgentLoop(conv.id, { cancel: cancelSpy } as any)
      return state
    })

    useConversationStore.getState().cancelAgent(conv.id)

    const updated = useConversationStore.getState().conversations.find((c) => c.id === conv.id)
    expect(cancelSpy).toHaveBeenCalledTimes(1)

    const assistantMessages = (updated?.messages || []).filter((m) => m.role === 'assistant')
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0].toolCalls?.map((tc) => tc.id)).toEqual([completedToolCall.id])

    const toolMessages = (updated?.messages || []).filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    expect(toolMessages[0].toolCallId).toBe(completedToolCall.id)
    expect(toolMessages[0].content).toBe('README content')
  })

  it('repairs a persisted orphaned tool call when cancelling a run', () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('cancel-repair-orphan')
    const orphanedToolCall = {
      id: 'tool-orphan-1',
      type: 'function' as const,
      function: { name: 'ask_user_question', arguments: '{"question":"Continue?"}' },
    }

    useConversationStore.setState((state) => {
      const target = state.conversations.find((c) => c.id === conv.id)
      if (!target) return state
      target.messages = [
        createUserMessage('hello'),
        createAssistantMessage(null, [orphanedToolCall]),
      ]
      target.status = 'tool_calling'
      target.activeRunId = 'run-orphan'
      setAgentLoop(conv.id, { cancel: vi.fn() } as any)
      return state
    })

    useConversationStore.getState().cancelAgent(conv.id)

    const updated = useConversationStore.getState().conversations.find((c) => c.id === conv.id)
    expect(updated?.messages.find((message) => message.role === 'tool' && message.toolCallId === orphanedToolCall.id))
      .toMatchObject({ name: 'ask_user_question' })
  })

  it('preserves in-flight spawn_subagent on cancel with synthetic interrupted result', () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('cancel-spawn-subagent')
    const user = createUserMessage('delegate work')
    useConversationStore.getState().updateMessages(conv.id, [user])

    const cancelSpy = vi.fn()
    const spawnToolCall = {
      id: 'tool-spawn-1',
      type: 'function' as const,
      function: {
        name: 'spawn_subagent',
        arguments: '{"description":"long task"}',
      },
    }

    useConversationStore.setState((state) => {
      const target = state.conversations.find((c) => c.id === conv.id)
      if (!target) return state
      target.status = 'tool_calling'
      target.activeRunId = 'run-spawn'
      target.currentToolCall = spawnToolCall
      target.activeToolCalls = [spawnToolCall]
      target.streamingContent = ''
      target.streamingReasoning = 'delegating...'
      target.draftAssistant = {
        reasoning: 'delegating...',
        content: '',
        toolCalls: [spawnToolCall],
        toolResults: {},
        toolCall: spawnToolCall,
        toolArgs: '{"description":"long task"}',
        steps: [
          {
            id: `tool-${spawnToolCall.id}`,
            timestamp: Date.now(),
            type: 'tool_call',
            toolCall: spawnToolCall,
            args: '{"description":"long task"}',
            streaming: true,
            subagentEvents: [
              {
                agentId: 'subagent_cancel_demo',
                status: 'running',
                summary: 'executing',
                timestamp: Date.now(),
              },
            ],
          },
        ],
        activeReasoningStepId: null,
        activeContentStepId: null,
        activeToolStepId: `tool-${spawnToolCall.id}`,
        activeCompressionStepId: null,
      }
      setAgentLoop(conv.id, { cancel: cancelSpy } as any)
      return state
    })

    useConversationStore.getState().cancelAgent(conv.id)

    const updated = useConversationStore.getState().conversations.find((c) => c.id === conv.id)
    expect(cancelSpy).toHaveBeenCalledTimes(1)

    // Assistant message must include the in-flight spawn_subagent call
    const assistantMessages = (updated?.messages || []).filter((m) => m.role === 'assistant')
    const lastAssistant = assistantMessages[assistantMessages.length - 1]
    expect(lastAssistant.toolCalls?.map((tc) => tc.id)).toContain(spawnToolCall.id)

    // A synthetic tool result must be present and contain the agentId
    const toolMessages = (updated?.messages || []).filter((m) => m.role === 'tool')
    const spawnToolMsg = toolMessages.find((m) => m.toolCallId === spawnToolCall.id)
    expect(spawnToolMsg).toBeDefined()
    const parsed = JSON.parse(spawnToolMsg!.content ?? '') as Record<string, unknown>
    const data = parsed.data as Record<string, unknown> | undefined
    expect(data?.agentId).toBe('subagent_cancel_demo')
    expect(data?.interrupted).toBe(true)
  })

  it('should stream think-tag reasoning before content completes', async () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('stream-think-tags')
    useConversationStore.getState().updateMessages(conv.id, [createUserMessage('hello')])

    const snapshots: Array<{
      label: string
      reasoning: string
      content: string
      reasoningStep?: { content: string; streaming: boolean } | null
    }> = []

    const capture = async (label: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const runtime = useConversationRuntimeStore.getState().runtimes.get(conv.id)
      const reasoningStep = runtime?.draftAssistant?.steps.find((s) => s.type === 'reasoning') as
        | { content: string; streaming: boolean }
        | undefined

      snapshots.push({
        label,
        reasoning: runtime?.draftAssistant?.reasoning || '',
        content: runtime?.draftAssistant?.content || '',
        reasoningStep: reasoningStep
          ? { content: reasoningStep.content, streaming: reasoningStep.streaming }
          : null,
      })
    }

    ;(globalThis as any).__conversationStoreCustomRun = async (messages: any[], callbacks: any) => {
      callbacks.onMessageStart?.()
      callbacks.onContentStart?.()
      callbacks.onContentDelta?.('<think>分析中')
      await capture('after_open_think')
      callbacks.onContentDelta?.('</think>最终答案')
      await capture('after_close_think')
      callbacks.onContentComplete?.('<think>分析中</think>最终答案')
      return [
        ...messages,
        {
          id: 'assistant-think-stream',
          role: 'assistant',
          content: '<think>分析中</think>最终答案',
          timestamp: Date.now(),
        },
      ]
    }

    await useConversationStore
      .getState()
      .runAgent(conv.id, 'openai' as any, 'mock-model', 1024, null)

    const openThink = snapshots.find((s) => s.label === 'after_open_think')
    expect(openThink?.reasoning).toBe('分析中')
    expect(openThink?.reasoningStep?.content).toBe('分析中')
    expect(openThink?.reasoningStep?.streaming).toBe(true)
    expect(openThink?.content).toBe('')

    const closeThink = snapshots.find((s) => s.label === 'after_close_think')
    expect(closeThink?.reasoning).toBe('分析中')
    expect(closeThink?.reasoningStep?.content).toBe('分析中')
    expect(closeThink?.content).toBe('最终答案')
  })

  // ── Direct chat (kind) coverage ────────────────────────────────────────

  describe('direct chat (conversation kind)', () => {
    it('createNew with kind:direct persists and carries the kind', () => {
      const store = useConversationStore.getState()
      const conv = store.createNew('New direct chat', { kind: 'direct' })

      expect(conv.kind).toBe('direct')
      expect(useConversationStore.getState().conversations.find((c) => c.id === conv.id)?.kind).toBe('direct')

      const metaCall = conversationRepoSaveMetaMock.mock.calls.at(-1)?.[0]
      expect(metaCall?.kind).toBe('direct')
    })

    it('createNew without kind leaves kind undefined (≡ project, legacy zero migration)', () => {
      const store = useConversationStore.getState()
      const conv = store.createNew('plain')

      expect(conv.kind).toBeUndefined()

      const metaCall = conversationRepoSaveMetaMock.mock.calls.at(-1)?.[0]
      expect(metaCall?.kind).toBeUndefined()
    })

    it('persisted kind survives a loadFromDB roundtrip (direct stays direct)', async () => {
      const store = useConversationStore.getState()
      const direct = store.createNew('direct-roundtrip', { kind: 'direct' })
      const project = store.createNew('project-roundtrip')

      // Reload from the mocked repo using LITERAL fixture rows — NOT values
      // echoed back from the saveMeta calls. If findAllMeta merely mirrored
      // what saveMeta was handed, a repository that dropped or corrupted
      // `kind` on write would round-trip undetected. Asserting an expected
      // literal ('direct') makes the test fail the moment the store stops
      // persisting or restoring the kind.
      const { getConversationRepository } = await import('@/sqlite')
      const repo = getConversationRepository() as any
      repo.findAllMeta.mockResolvedValueOnce([
        { id: direct.id, title: 'direct-roundtrip', kind: 'direct', createdAt: 1, updatedAt: 1 },
        { id: project.id, title: 'project-roundtrip', kind: 'project', createdAt: 2, updatedAt: 2 },
      ])

      // beforeEach seeds loaded:true; reset it so loadFromDB actually runs its
      // load path instead of being skipped (that skip is what this test guards).
      useConversationStore.setState({ loaded: false, activeConversationId: null } as any)

      await useConversationStore.getState().loadFromDB()

      const reloaded = useConversationStore.getState().conversations
      expect(reloaded.find((c) => c.id === direct.id)?.kind).toBe('direct')
      // project row roundtrips as undefined ≡ 'project'
      expect(reloaded.find((c) => c.id === project.id)?.kind).toBeUndefined()
      // The creation path must actually have persisted the direct kind —
      // this is the write the literal fixture above stands in for. A legacy
      // (pre-kind) conversation persists kind: undefined, which the
      // repository normalizes to a 'project' row on INSERT.
      expect(conversationRepoSaveMetaMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: direct.id, kind: 'direct' })
      )
      expect(conversationRepoSaveMetaMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: project.id, kind: undefined })
      )
    })

    it('setConversationKind flips direct → project and persists', async () => {
      const store = useConversationStore.getState()
      const conv = store.createNew('upgrade-me', { kind: 'direct' })

      const persisted = await useConversationStore.getState().setConversationKind(conv.id, 'project')

      expect(persisted).toBe(true)
      expect(useConversationStore.getState().conversations.find((c) => c.id === conv.id)?.kind).toBe('project')
      // The kind change goes through the dedicated updateKind write (not the
      // generic saveMeta path, whose kind snapshot can race a transition).
      expect(conversationRepoUpdateKindMock).toHaveBeenCalledWith(conv.id, 'project')
    })

    it('setConversationKind restores the previous kind and resolves false when persistence fails', async () => {
      const store = useConversationStore.getState()
      const conv = store.createNew('rollback-me', { kind: 'direct' })

      conversationRepoUpdateKindMock.mockRejectedValueOnce(new Error('persist failed'))

      // The boolean is the explicit failure contract: callers must be able to
      // detect the rolled-back kind without re-inspecting store state.
      const persisted = await useConversationStore.getState().setConversationKind(conv.id, 'project')

      expect(persisted).toBe(false)
      // The in-memory kind rolled back to 'direct' so the session matches
      // what a reload will show (the persisted row kept the old kind).
      expect(useConversationStore.getState().conversations.find((c) => c.id === conv.id)?.kind).toBe('direct')
      expect(toastErrorMock).toHaveBeenCalled()
    })

    it('overlapping kind transitions of one conversation persist in call order (no stale rollback)', async () => {
      // Finding: two overlapping transitions persisted out of order — an
      // earlier write failing AFTER a later one already persisted rolled the
      // in-memory kind back to a value SQLite never stored, so the UI
      // disagreed with a reload. Transitions of the same conversation are
      // serialized on a per-conversation chain.
      const store = useConversationStore.getState()
      const conv = store.createNew('race-kind', { kind: 'direct' })

      // First call (direct → project) suspends inside the persist write.
      let releaseFirst: (() => void) | null = null
      conversationRepoUpdateKindMock.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            releaseFirst = () => reject(new Error('first write failed'))
          })
      )
      const first = useConversationStore.getState().setConversationKind(conv.id, 'project')

      // Second call (project → direct) is QUEUED behind the first: it must
      // not touch updateKind until the first write settled.
      const second = useConversationStore.getState().setConversationKind(conv.id, 'direct')
      // Let the first call reach its persist write (async: the meta-persist
      // await resolves first), then prove the second is still queued.
      await vi.waitFor(() => expect(conversationRepoUpdateKindMock).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(conversationRepoUpdateKindMock).toHaveBeenCalledTimes(1)

      // First write fails; the second write then runs and succeeds.
      releaseFirst!()
      const [firstOk, secondOk] = await Promise.all([first, second])

      expect(firstOk).toBe(false)
      expect(secondOk).toBe(true)
      expect(conversationRepoUpdateKindMock).toHaveBeenCalledTimes(2)
      // Call order preserved: project was attempted BEFORE direct.
      expect(conversationRepoUpdateKindMock.mock.calls.map((c) => c[1])).toEqual(['project', 'direct'])
      // In-memory kind matches the last PERSISTED value (direct), and the
      // failed first call could not clobber it back to the pre-race kind.
      expect(useConversationStore.getState().conversations.find((c) => c.id === conv.id)?.kind).toBe('direct')
    })

    it('convertDirectToProject runs folder authorization then upgrades the kind', async () => {
      const store = useConversationStore.getState()
      const conv = store.createNew('convert-me', { kind: 'direct' })

      // vi.resetModules() clears the dynamic-import cache so EACH conversion
      // test re-evaluates '@/store/folder-access.store' with ITS OWN
      // doMock factory: vi.doUnmock alone removes the registration but not
      // the cached module, so a later test would silently reuse the earlier
      // mock's pickDirectory (and never exercise its own expectation).
      vi.resetModules()

      const pickDirectoryMock = vi.fn(() => Promise.resolve(true))
      vi.doMock('@/store/folder-access.store', () => ({
        useFolderAccessStore: {
          getState: () => ({ activeProjectId: 'proj-1', pickDirectory: pickDirectoryMock }),
        },
      }))

      // convertDirectToProject dynamically imports '@/store/folder-access.store'.
      // vi.doMock matches by resolved module id, so mocking the SAME
      // specifier the source uses intercepts the dynamic import.
      const ok = await useConversationStore.getState().convertDirectToProject(conv.id)

      expect(ok).toBe(true)
      expect(pickDirectoryMock).toHaveBeenCalledWith('proj-1')
      expect(useConversationStore.getState().conversations.find((c) => c.id === conv.id)?.kind).toBe('project')
      expect(conversationRepoUpdateKindMock).toHaveBeenCalledWith(conv.id, 'project')

      vi.doUnmock('@/store/folder-access.store')
    })

    it('convertDirectToProject returns false and keeps the kind when persistence fails', async () => {
      const store = useConversationStore.getState()
      const conv = store.createNew('convert-persist-fail', { kind: 'direct' })

      // Fresh module registry: without this, the dynamic import could return
      // the FIRST test's cached folder-access mock and this test's
      // pickDirectoryMock would never be exercised.
      vi.resetModules()

      const pickDirectoryMock = vi.fn(() => Promise.resolve(true))
      vi.doMock('@/store/folder-access.store', () => ({
        useFolderAccessStore: {
          getState: () => ({ activeProjectId: 'proj-1', pickDirectory: pickDirectoryMock }),
        },
      }))
      conversationRepoUpdateKindMock.mockRejectedValueOnce(new Error('persist failed'))

      const ok = await useConversationStore.getState().convertDirectToProject(conv.id)

      // The caller must never see a false success: the kind write failed, so
      // the conversion reports false and the kind stays 'direct'.
      expect(ok).toBe(false)
      expect(useConversationStore.getState().conversations.find((c) => c.id === conv.id)?.kind).toBe('direct')
      expect(toastErrorMock).toHaveBeenCalled()

      vi.doUnmock('@/store/folder-access.store')
    })

    it('convertDirectToProject does not change the kind when folder authorization fails', async () => {
      const store = useConversationStore.getState()
      const conv = store.createNew('convert-cancelled', { kind: 'direct' })

      // Fresh module registry: this test is the reason the reset matters —
      // its mock resolves pickDirectory to FALSE, but a stale cached module
      // from an earlier test (resolving true) would make the conversion
      // pass authorization and update the kind, failing the assertions
      // below for the wrong reason.
      vi.resetModules()

      const pickDirectoryMock = vi.fn(() => Promise.resolve(false))
      vi.doMock('@/store/folder-access.store', () => ({
        useFolderAccessStore: {
          getState: () => ({ activeProjectId: 'proj-1', pickDirectory: pickDirectoryMock }),
        },
      }))

      const ok = await useConversationStore.getState().convertDirectToProject(conv.id)

      expect(ok).toBe(false)
      expect(pickDirectoryMock).toHaveBeenCalledWith('proj-1')
      expect(useConversationStore.getState().conversations.find((c) => c.id === conv.id)?.kind).toBe('direct')
      expect(conversationRepoUpdateKindMock).not.toHaveBeenCalled()

      vi.doUnmock('@/store/folder-access.store')
    })

    it('convertDirectToProject returns true for an already-project conversation (no-op)', async () => {
      const store = useConversationStore.getState()
      const conv = store.createNew('already-project')

      const ok = await useConversationStore.getState().convertDirectToProject(conv.id)
      expect(ok).toBe(true)
      expect(useConversationStore.getState().conversations.find((c) => c.id === conv.id)?.kind).toBeUndefined()
    })

    it('runAgent for a direct conversation sets toolContext.directMode; project leaves it unset', async () => {
      const store = useConversationStore.getState()
      const conv = store.createNew('direct-run', { kind: 'direct' })

      await useConversationStore
        .getState()
        .runAgent(conv.id, 'openai' as any, 'mock-model', 1024, null)

      const config = (globalThis as any).__lastAgentLoopConfig
      expect(config?.toolContext?.directMode).toBe(true)

      const projectConv = store.createNew('project-run')
      await useConversationStore
        .getState()
        .runAgent(projectConv.id, 'openai' as any, 'mock-model', 1024, null)
      const projectConfig = (globalThis as any).__lastAgentLoopConfig
      expect(projectConfig?.toolContext?.directMode).toBeFalsy()
    })
  })
})
