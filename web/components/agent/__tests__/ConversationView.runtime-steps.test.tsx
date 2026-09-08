import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationView } from '../ConversationView'

type AssistantTurnBubbleProps = {
  turn?: { type: string; messages: Array<{ id: string }> }
  isProcessing?: boolean
  isWaiting?: boolean
  runtimeSteps?: Array<{ id: string; type: string; content?: string; streaming?: boolean }>
}

const {
  useConversationStoreMock,
  useConversationRuntimeStoreMock,
  useSettingsStoreMock,
  assistantTurnBubbleSpy,
  conversationState,
  runtimeState,
} = vi.hoisted(() => {
  const assistantTurnBubbleSpy = vi.fn<(props: AssistantTurnBubbleProps) => void>()

  const conversationState = {
    activeConversationId: 'conv-1',
    conversations: [
      {
        id: 'conv-1',
        messages: [
          {
            id: 'msg-user-1',
            role: 'user',
            content: 'hello',
            timestamp: 1,
            type: 'message',
          },
          {
            id: 'msg-assistant-1',
            role: 'assistant',
            content: 'ok',
            timestamp: 2,
            type: 'message',
            toolCalls: [],
            usage: null,
          },
        ],
        status: 'pending',
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
        contextWindowUsage: null,
        lastContextWindowUsage: null,
      },
    ],
    createNew: vi.fn(),
    updateMessages: vi.fn(),
    deleteAgentLoop: vi.fn(() => true),
    setActive: vi.fn(),
    runAgent: vi.fn(),
    cancelAgent: vi.fn(),
    isConversationRunning: vi.fn(() => true),
    getSuggestedFollowUp: vi.fn(() => ''),
    clearSuggestedFollowUp: vi.fn(),
    mountConversation: vi.fn(),
    unmountConversation: vi.fn(),
    regenerateUserMessage: vi.fn(),
    editAndResendUserMessage: vi.fn(),
    resetConversationState: vi.fn(),
  }

  const runtimeState = {
    runtimes: new Map([
      [
        'conv-1',
        {
          status: 'pending',
          error: null,
          contextWindowUsage: null,
          draftAssistant: {
            reasoning: '',
            content: '',
            toolCalls: [],
            toolResults: {},
            toolCall: null,
            toolArgs: '',
            steps: [
              {
                id: 'compression-1',
                type: 'compression',
                content: '上下文已压缩并生成摘要',
                streaming: false,
              },
            ],
            activeReasoningStepId: null,
            activeContentStepId: null,
            activeToolStepId: null,
            activeCompressionStepId: null,
          },
          streamingContent: '',
          streamingReasoning: '',
          isReasoningStreaming: false,
          isContentStreaming: false,
          currentToolCall: null,
          activeToolCalls: [],
          streamingToolArgs: '',
          streamingToolArgsByCallId: {},
        },
      ],
    ]),
    pendingMessageQueues: new Map(),
    isConversationRunning: vi.fn(() => true),
    getQueueDepth: vi.fn(() => 0),
    getSuggestedFollowUp: vi.fn(() => ''),
    clearSuggestedFollowUp: vi.fn(),
    mountConversation: vi.fn(),
    unmountConversation: vi.fn(),
    resetConversationState: vi.fn(),
  }

  const useConversationStoreMock = ((selector: (state: typeof conversationState) => unknown) =>
    selector(
      conversationState
    )) as unknown as typeof import('@/store/conversation.store').useConversationStore
  ;(useConversationStoreMock as unknown as { getState: () => typeof conversationState }).getState =
    () => conversationState

  const useConversationRuntimeStoreMock = ((selector: (state: typeof runtimeState) => unknown) =>
    selector(runtimeState)) as unknown as typeof import('@/store/conversation-runtime.store').useConversationRuntimeStore
  ;(useConversationRuntimeStoreMock as unknown as { getState: () => typeof runtimeState }).getState =
    () => runtimeState

  const useSettingsStoreMock = (selector?: (state: unknown) => unknown) => {
    const state = {
      providerType: 'openai',
      modelName: 'gpt-5.4',
      maxTokens: 8000,
      hasApiKey: true,
      enableThinking: false,
      thinkingLevel: 'medium' as const,
      setEnableThinking: vi.fn(),
      setThinkingLevel: vi.fn(),
    }
    return selector ? selector(state) : state
  }

  return {
    useConversationStoreMock,
    useConversationRuntimeStoreMock,
    useSettingsStoreMock,
    assistantTurnBubbleSpy,
    conversationState,
    runtimeState,
  }
})

vi.mock('@/store/conversation.store', () => ({
  useConversationStore: useConversationStoreMock,
}))

vi.mock('@/store/conversation-runtime.store', () => ({
  useConversationRuntimeStore: useConversationRuntimeStoreMock,
}))

vi.mock('@/store/agent.store', () => ({
  useAgentStore: () => ({ directoryHandle: null }),
}))

vi.mock('@/store/project.store', () => ({
  useProjectStore: (selector: (state: { activeProjectId: string | null }) => unknown) =>
    selector({ activeProjectId: null }),
}))

vi.mock('@/store/settings.store', () => ({
  useSettingsStore: useSettingsStoreMock,
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
  AssistantTurnBubble: (props: AssistantTurnBubbleProps) => {
    assistantTurnBubbleSpy(props)
    return <div data-testid="assistant-turn-bubble" />
  },
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

describe('ConversationView runtime step placement', () => {
  beforeEach(() => {
    assistantTurnBubbleSpy.mockClear()
    conversationState.conversations[0].status = 'pending'
    const rt = runtimeState.runtimes.get('conv-1')
    if (rt) {
      rt.status = 'pending'
    }
  })

  it('attaches runtime steps to a single bubble while pending between loop iterations', () => {
    render(<ConversationView />)

    const calls = assistantTurnBubbleSpy.mock.calls.map((call) => call[0])
    const callsWithRuntimeSteps = calls.filter((props) => (props.runtimeSteps?.length || 0) > 0)

    expect(calls.length).toBe(1)
    expect(callsWithRuntimeSteps.length).toBe(1)
  })

  it('only marks the last assistant turn as waiting while the agent waits for the model', () => {
    const originalMessages = conversationState.conversations[0].messages
    try {
      // Two assistant turns (separated by user turns) while status is 'pending':
      // the earlier committed turn must NOT show the waiting indicator.
      conversationState.conversations[0].messages = [
        { id: 'msg-user-1', role: 'user', content: 'first', timestamp: 1, type: 'message' },
        { id: 'msg-assistant-1', role: 'assistant', content: 'ok', timestamp: 2, type: 'message', toolCalls: [], usage: null },
        { id: 'msg-user-2', role: 'user', content: 'second', timestamp: 3, type: 'message' },
        { id: 'msg-assistant-2', role: 'assistant', content: 'working', timestamp: 4, type: 'message', toolCalls: [], usage: null },
      ]

      render(<ConversationView />)

      const calls = assistantTurnBubbleSpy.mock.calls.map((call) => call[0])
      const lastCallForTurn = (assistantMsgId: string) =>
        [...calls].reverse().find((props) => props.turn?.messages?.[0]?.id === assistantMsgId)

      const earlierTurn = lastCallForTurn('msg-assistant-1')
      const lastTurn = lastCallForTurn('msg-assistant-2')

      expect(earlierTurn).toBeDefined()
      expect(lastTurn).toBeDefined()
      // Regression: previously isWaiting leaked to every assistant turn,
      // rendering the three-dot bubble (and hiding the summary footer) on
      // historical turns while waiting between loop iterations.
      expect(earlierTurn!.isWaiting).toBe(false)
      expect(earlierTurn!.isProcessing).toBe(false)
      expect(lastTurn!.isWaiting).toBe(true)
      expect(lastTurn!.isProcessing).toBe(true)
    } finally {
      conversationState.conversations[0].messages = originalMessages
    }
  })
})
