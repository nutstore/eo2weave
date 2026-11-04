/**
 * Tests for the GATEWAY_CREDENTIALS_EXPIRED branch of ConversationErrorBanner
 * (issue #75): the Re-login entry replaces the generic "继续" retry, and
 * clicking it starts the gateway-relogin flow.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationView } from '../ConversationView'

const {
  useConversationStoreMock,
  conversationState,
  startReloginMock,
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
        error: '[GATEWAY_CREDENTIALS_EXPIRED] Nutstore AI login has expired. Please log in again.',
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

  const startReloginMock = vi.fn()

  const useConversationStoreMock = ((selector: (state: typeof conversationState) => unknown) =>
    selector(conversationState)) as unknown as typeof import('@/store/conversation.store').useConversationStore
  ;(useConversationStoreMock as unknown as { getState: () => typeof conversationState }).getState =
    () => conversationState

  const runtimeEntry = {
    status: 'error' as string,
    error: '[GATEWAY_CREDENTIALS_EXPIRED] Nutstore AI login has expired. Please log in again.',
    activeRunId: null,
    draftAssistant: null,
    contextWindowUsage: null,
  }

  return { useConversationStoreMock, conversationState, startReloginMock, runtimeEntry }
})

vi.mock('@/store/conversation.store', () => ({
  useConversationStore: useConversationStoreMock,
}))

vi.mock('@/store/gateway-relogin.store', () => {
  const store = {
    phase: 'idle' as string,
    authState: null,
    error: null,
    start: startReloginMock,
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
  hasApiKey: false,
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

const EXPIRED_ERROR = '[GATEWAY_CREDENTIALS_EXPIRED] Nutstore AI login has expired. Please log in again.'

describe('ConversationErrorBanner GATEWAY_CREDENTIALS_EXPIRED', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeEntry.status = 'error'
    runtimeEntry.error = EXPIRED_ERROR
    startReloginMock.mockResolvedValue(true)
  })

  it('offers retry for a restored empty turn without a runtime error', () => {
    runtimeEntry.status = 'idle'
    runtimeEntry.error = ''
    const conversation = conversationState.conversations[0]
    const previousError = conversation.error
    const message = conversation.messages[1]
    Object.assign(message, { kind: 'empty' })
    conversation.error = ''
    try {
      render(<ConversationView />)
      expect(screen.getByRole('button', { name: /conversation\.error\.retry/ })).toBeInTheDocument()
    } finally {
      delete (message as { kind?: string }).kind
      conversation.error = previousError
    }
  })

  it('shows the Re-login button and NO generic retry button', () => {
    render(<ConversationView />)

    expect(screen.getByRole('button', { name: /conversation\.error\.gatewayRelogin/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /conversation\.error\.retry/ })).not.toBeInTheDocument()
  })

  it('starts the relogin flow when the button is clicked (no auto-replay callback)', () => {
    render(<ConversationView />)

    fireEvent.click(screen.getByRole('button', { name: /conversation\.error\.gatewayRelogin/ }))
    expect(startReloginMock).toHaveBeenCalledTimes(1)
    // The failed turn is NOT auto-replayed (it may already have executed
    // side-effecting tools); the user re-sends manually after login.
    expect(startReloginMock).toHaveBeenCalledWith()
  })

  it('never regenerates the failed turn after a successful login', async () => {
    runtimeEntry.error = '[GATEWAY_CREDENTIALS_EXPIRED] Nutstore AI login has expired.'
    conversationState.conversations[0].messages = [
      { id: 'user-failed-1', role: 'user', content: 'hello', timestamp: 1, type: 'message' },
    ]

    render(<ConversationView />)
    fireEvent.click(screen.getByRole('button', { name: /conversation\.error\.gatewayRelogin/ }))

    expect(conversationState.regenerateUserMessage).not.toHaveBeenCalled()
  })

  it('keeps the generic retry card for a non-gateway HTTP error', () => {
    runtimeEntry.error = 'HTTP 502: upstream unavailable'

    render(<ConversationView />)

    expect(screen.queryByRole('button', { name: /conversation\.error\.gatewayRelogin/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /conversation\.error\.retry/ })).toBeInTheDocument()
  })

  it('keeps the generic retry card for a transient gateway error (no prefix)', () => {
    runtimeEntry.error = 'HTTP 401: gateway token expired'

    render(<ConversationView />)

    expect(screen.queryByRole('button', { name: /conversation\.error\.gatewayRelogin/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /conversation\.error\.retry/ })).toBeInTheDocument()
  })
})

// GATEWAY_CREDENTIALS_MISSING (#172 finding 3): a CONFIRMED absent gateway
// credential gets the same actionable login card instead of a raw 401.
const MISSING_ERROR = '[GATEWAY_CREDENTIALS_MISSING] Not logged in to Nutstore AI. Please log in first.'

describe('ConversationErrorBanner GATEWAY_CREDENTIALS_MISSING', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeEntry.status = 'error'
    runtimeEntry.error = MISSING_ERROR
    startReloginMock.mockResolvedValue(true)
  })

  it('shows the login card (not a raw 401 retry card) for a confirmed-missing credential', () => {
    render(<ConversationView />)

    expect(screen.getByRole('button', { name: /conversation\.error\.gatewayRelogin/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /conversation\.error\.retry/ })).not.toBeInTheDocument()
  })

  it('starts the relogin flow when the login button is clicked', () => {
    render(<ConversationView />)

    fireEvent.click(screen.getByRole('button', { name: /conversation\.error\.gatewayRelogin/ }))
    expect(startReloginMock).toHaveBeenCalledTimes(1)
  })
})
vi.mock('@/hooks/useProjectAgentsInit', () => ({ useProjectAgentsInit: vi.fn() }))
