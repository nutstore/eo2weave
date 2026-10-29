/**
 * Tests for the GATEWAY_INSUFFICIENT_CREDIT branch of
 * ConversationErrorBanner: the Recharge entry (https://ai.jianguoyun.com/)
 * replaces the generic retry when the LLM Gateway reports credit
 * exhaustion (429 + code "insufficient_credit", retriable: false).
 *
 * Mirrors ConversationView.gateway-relogin.test.tsx.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { ConversationView } from '../ConversationView'
import { getNutstoreAIConsoleURL } from '@/lib/jianguoyun-ai-console'

const {
  useConversationStoreMock,
  runtimeEntry,
} = vi.hoisted(() => {
  const conversationState = {
    activeConversationId: 'conv-1',
    conversations: [
      {
        id: 'conv-1',
        messages: [
          {
            id: 'user-failed-1',
            role: 'user',
            content: 'hello',
            timestamp: 1,
            type: 'message',
          },
          {
            id: 'assistant-failed-1',
            role: 'assistant',
            content: '',
            timestamp: 2,
            type: 'message',
            toolCalls: [],
          },
        ],
        status: 'error',
        draftAssistant: null,
        streamingContent: '',
        streamingReasoning: '',
        isReasoningStreaming: false,
        isContentStreaming: false,
        currentToolCall: null,
        activeToolCalls: [],
        streamingToolArgs: '',
        streamingToolArgsByCallId: {},
        error: '[GATEWAY_INSUFFICIENT_CREDIT] Nutstore AI credit balance is exhausted — top up to continue',
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
    isConversationRunning: vi.fn(() => false),
    getSuggestedFollowUp: vi.fn(() => ''),
    clearSuggestedFollowUp: vi.fn(),
    mountConversation: vi.fn(),
    unmountConversation: vi.fn(),
    regenerateUserMessage: vi.fn(),
    editAndResendUserMessage: vi.fn(),
    resetConversationState: vi.fn(),
  }

  const useConversationStoreMock = ((selector: (state: typeof conversationState) => unknown) =>
    selector(conversationState)) as unknown as typeof import('@/store/conversation.store').useConversationStore
  ;(useConversationStoreMock as unknown as { getState: () => typeof conversationState }).getState =
    () => conversationState

  const runtimeEntry = {
    status: 'error' as string,
    error: '[GATEWAY_INSUFFICIENT_CREDIT] Nutstore AI credit balance is exhausted — top up to continue',
    activeRunId: null,
    draftAssistant: null,
    contextWindowUsage: null,
  }

  return { useConversationStoreMock, conversationState, runtimeEntry }
})

vi.mock('@/store/conversation.store', () => ({
  useConversationStore: useConversationStoreMock,
}))

vi.mock('@/store/gateway-relogin.store', () => {
  const store = {
    phase: 'idle' as string,
    authState: null,
    error: null,
    start: vi.fn(),
    reset: vi.fn(),
  }
  const useGatewayReloginStore = ((selector?: (s: typeof store) => unknown) =>
    selector ? selector(store) : store) as unknown as typeof import('@/store/gateway-relogin.store').useGatewayReloginStore
  ;(useGatewayReloginStore as unknown as { getState: () => typeof store }).getState = () => store
  return { useGatewayReloginStore }
})

vi.mock('@/store/conversation-runtime.store', () => {
  const runtimeState = {
    runtimes: new Map([['conv-1', runtimeEntry]]),
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
  const useConversationRuntimeStore = Object.assign(
    (selector?: (state: typeof runtimeState) => unknown) =>
      selector ? selector(runtimeState) : runtimeState,
    { getState: () => runtimeState, subscribe: vi.fn() }
  )
  return { useConversationRuntimeStore }
})

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

const settingsState = {
  providerType: 'llm-gateway',
  modelName: 'deepseek-v4.1-flash',
  maxTokens: 8000,
  hasApiKey: true,
  enableThinking: false,
  thinkingLevel: 'medium' as const,
  setEnableThinking: vi.fn(),
  setThinkingLevel: vi.fn(),
}

vi.mock('@/store/settings.store', () => ({
  useSettingsStore: (selector?: (state: typeof settingsState) => unknown) => {
    return selector ? selector(settingsState) : settingsState
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

vi.mock('@/store/asset.store', () => ({
  useAssetStore: (selector: (state: { pendingAssets: unknown[] }) => unknown) =>
    selector({ pendingAssets: [] }),
}))

vi.mock('@/store/extension.store', () => ({
  useExtensionStore: Object.assign(
    (selector?: (state: Record<string, unknown>) => unknown) => {
      const state = {}
      return selector ? selector(state) : state
    },
    { getState: () => ({}) }
  ),
}))

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
  useLocale: () => ['en-US'],
}))

vi.mock('../MessageBubble', () => ({
  MessageBubble: () => <div data-testid="message-bubble" />,
}))

vi.mock('../AssistantTurnBubble', () => ({
  AssistantTurnBubble: () => <div data-testid="assistant-turn-bubble" />,
}))

vi.mock('../AgentRichInput', () => ({
  AgentRichInput: ({ leadingAccessory }: { leadingAccessory?: React.ReactNode }) => (
    <div data-testid="agent-rich-input">{leadingAccessory}</div>
  ),
}))

vi.mock('@creatorweave/ui', () => ({
  BrandSwitch: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const CREDIT_ERROR = '[GATEWAY_INSUFFICIENT_CREDIT] Nutstore AI credit balance is exhausted — top up to continue'

describe('ConversationErrorBanner GATEWAY_INSUFFICIENT_CREDIT', () => {
  let windowOpen: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    runtimeEntry.status = 'error'
    runtimeEntry.error = CREDIT_ERROR
    windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
  })

  it('shows the Recharge button and NO generic retry button', () => {
    render(<ConversationView />)

    expect(screen.getByRole('button', { name: /conversation\.error\.gatewayRecharge/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /conversation\.error\.retry/ })).not.toBeInTheDocument()
  })

  it('opens the Nutstore AI console when the button is clicked', () => {
    render(<ConversationView />)

    fireEvent.click(screen.getByRole('button', { name: /conversation\.error\.gatewayRecharge/ }))
    expect(windowOpen).toHaveBeenCalledTimes(1)
    // The console host follows the deployment's configured gateway base URL
    // (a demo deployment must not send the user to production).
    expect(windowOpen).toHaveBeenCalledWith(
      getNutstoreAIConsoleURL(),
      '_blank',
      'noopener,noreferrer'
    )
  })
})
