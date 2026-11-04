import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConversationView } from '../ConversationView'

vi.mock('@/hooks/useProjectAgentsInit', () => ({ useProjectAgentsInit: vi.fn() }))

const {
  useConversationStoreMock,
  useConversationRuntimeStoreMock,
  conversationState,
} = vi.hoisted(() => {
  const conversationState = {
    activeConversationId: 'conv-1',
    conversations: [
      {
        id: 'conv-1',
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: 'hi',
            timestamp: 1,
            type: 'message',
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'done',
            timestamp: 2,
            type: 'message',
            toolCalls: [],
            usage: {
              promptTokens: 27,
              completionTokens: 163,
              totalTokens: 190,
            },
          },
        ],
        status: 'idle',
        draftAssistant: null,
        streamingContent: '',
        streamingReasoning: '',
        isReasoningStreaming: false,
        isContentStreaming: false,
        currentToolCall: null,
        activeToolCalls: [],
        streamingToolArgs: '',
        streamingToolArgsByCallId: {},
        error: null,
        contextWindowUsage: {
          usedTokens: 4200,
          maxTokens: 198000,
          reserveTokens: 2000,
          usagePercent: 2.1,
          modelMaxTokens: 200000,
        },
        lastContextWindowUsage: {
          usedTokens: 4200,
          maxTokens: 198000,
          reserveTokens: 2000,
          usagePercent: 2.1,
          modelMaxTokens: 200000,
        },
      },
    ],
    createNew: vi.fn(),
    updateMessages: vi.fn(),
    deleteAgentLoop: vi.fn(() => true),
    setActive: vi.fn(),
    runAgent: vi.fn(),
    cancelAgent: vi.fn(),
    regenerateUserMessage: vi.fn(),
    editAndResendUserMessage: vi.fn(),
  }

  const runtimeState = {
    runtimes: new Map([
      [
        'conv-1',
        {
          status: 'idle',
          error: null,
          contextWindowUsage: {
            usedTokens: 832,
            maxTokens: 198000,
            reserveTokens: 2000,
            usagePercent: 0.42,
            modelMaxTokens: 200000,
          },
        },
      ],
    ]),
    pendingMessageQueues: new Map(),
    isConversationRunning: vi.fn(() => false),
    getSuggestedFollowUp: vi.fn(() => ''),
    clearSuggestedFollowUp: vi.fn(),
    mountConversation: vi.fn(),
    unmountConversation: vi.fn(),
    getQueueDepth: vi.fn(() => 0),
    removeQueuedMessage: vi.fn(),
    updateQueuedMessage: vi.fn(),
    moveQueuedMessage: vi.fn(),
    getQueuedMessage: vi.fn(() => undefined),
    resetConversationState: vi.fn(),
  }

  const useConversationStoreMock = ((selector: (state: typeof conversationState) => unknown) =>
    selector(conversationState)) as unknown as typeof import('@/store/conversation.store').useConversationStore
  ;(useConversationStoreMock as unknown as { getState: () => typeof conversationState }).getState =
    () => conversationState

  const useConversationRuntimeStoreMock = ((selector: (state: typeof runtimeState) => unknown) =>
    selector(runtimeState)) as unknown as typeof import('@/store/conversation-runtime.store').useConversationRuntimeStore
  ;(useConversationRuntimeStoreMock as unknown as { getState: () => typeof runtimeState }).getState =
    () => runtimeState
  // conversation.store.sqlite.ts subscribes to mount-count changes at import time
  ;(useConversationRuntimeStoreMock as unknown as { subscribe: ReturnType<typeof vi.fn> }).subscribe =
    vi.fn()

  return {
    useConversationStoreMock,
    useConversationRuntimeStoreMock,
    conversationState,
  }
})

vi.mock('@/store/conversation.store', () => ({
  useConversationStore: useConversationStoreMock,
}))

vi.mock('@/store/conversation-runtime.store', () => ({
  useConversationRuntimeStore: useConversationRuntimeStoreMock,
}))

vi.mock('@/store/agent.store', () => ({
  useAgentStore: (selector?: (state: { directoryHandle: null }) => unknown) => {
    const state = { directoryHandle: null }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/store/project.store', () => ({
  useProjectStore: (selector: (state: { activeProjectId: string | null }) => unknown) =>
    selector({ activeProjectId: null }),
}))

vi.mock('@/store/settings.store', () => ({
  useSettingsStore: (selector?: (state: unknown) => unknown) => {
    const state = {
      providerType: 'openai',
      modelName: 'gpt-5.4',
      maxTokens: 2000,
      hasApiKey: true,
      enableThinking: false,
      thinkingLevel: 'medium' as const,
      setEnableThinking: vi.fn(),
      setThinkingLevel: vi.fn(),
    }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/store/workspace-preferences.store', () => ({
  useWorkspacePreferencesStore: (selector?: (state: unknown) => unknown) => {
    const state = {
      agentMode: 'act' as const,
      setAgentMode: vi.fn(),
    }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/store/agents.store', () => ({
  useAgentsStore: (
    selector: (state: {
      isLoading: boolean
      isInitialized: boolean
      agents: Array<{ id: string; name: string }>
      activeAgentId: string
      setActiveAgent: (id: string) => Promise<void>
      createAgent: (id: string) => Promise<{ id: string; name: string } | null>
      deleteAgent: (id: string) => Promise<void>
    }) => unknown
  ) =>
    selector({
      isLoading: false,
      isInitialized: true,
      agents: [{ id: 'default', name: 'Default' }],
      activeAgentId: 'default',
      setActiveAgent: vi.fn(async () => undefined),
      createAgent: vi.fn(async () => null),
      deleteAgent: vi.fn(async () => undefined),
    }),
}))

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
}))

vi.mock('../MessageBubble', () => ({
  MessageBubble: () => <div data-testid="message-bubble" />,
}))

vi.mock('../AssistantTurnBubble', () => ({
  AssistantTurnBubble: () => <div data-testid="assistant-turn-bubble" />,
}))

vi.mock('../AgentRichInput', () => ({
  AgentRichInput: () => <div data-testid="agent-rich-input" />,
}))

vi.mock('@creatorweave/ui', () => ({
  BrandSwitch: () => null,
  TooltipProvider: ({ children }: any) => <>{children}</>,
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <>{children}</>,
}))

describe('ConversationView context usage source', () => {
  it('prefers latest assistant prompt usage after the run is idle instead of stale runtime usage', () => {
    render(<ConversationView />)

    expect(
      screen.getByText((_, element) => element?.textContent === '190/200.0k')
    ).toBeInTheDocument()
    expect(screen.queryByText('832')).not.toBeInTheDocument()
  })

  it('does not show stale runtime usage for a new conversation before any assistant usage exists', () => {
    conversationState.conversations[0].messages = [
      {
        id: 'user-only-1',
        role: 'user',
        content: 'hi',
        timestamp: 3,
        type: 'message',
      },
    ]
    ;(conversationState.conversations[0] as { lastContextWindowUsage: unknown }).lastContextWindowUsage = null
    ;(conversationState.conversations[0] as { contextWindowUsage: unknown }).contextWindowUsage = null

    render(<ConversationView />)

    expect(screen.queryByText((_, element) => element?.textContent === '832/200.0k')).not.toBeInTheDocument()
    expect(screen.queryByText((_, element) => element?.textContent === '27/200.0k')).not.toBeInTheDocument()
  })

  it('includes cache read tokens in settled assistant usage', () => {
    conversationState.conversations[0].messages = [
      {
        id: 'user-cache-1',
        role: 'user',
        content: 'hi',
        timestamp: 4,
        type: 'message',
      },
      {
        id: 'assistant-cache-1',
        role: 'assistant',
        content: 'done',
        timestamp: 5,
        type: 'message',
        toolCalls: [],
        usage: {
          promptTokens: 27,
          completionTokens: 163,
          totalTokens: 190,
          cacheReadTokens: 40,
        } as never,
      },
    ]
    conversationState.conversations[0].lastContextWindowUsage = {
      usedTokens: 190,
      maxTokens: 198000,
      reserveTokens: 2000,
      usagePercent: 0.1,
      modelMaxTokens: 200000,
    }

    render(<ConversationView />)

    expect(
      screen.getByText((_, element) => element?.textContent === '230/200.0k')
    ).toBeInTheDocument()
  })
})
