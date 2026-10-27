import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ConversationView } from '../ConversationView'

vi.mock('@/hooks/useProjectAgentsInit', () => ({ useProjectAgentsInit: vi.fn() }))

const { useConversationStoreMock } = vi.hoisted(() => {
  const state = {
    activeConversationId: 'conv-1',
    conversations: [
      {
        id: 'conv-1',
        messages: [],
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
  const hook = ((selector: (storeState: typeof state) => unknown) => selector(state)) as unknown as
    typeof import('@/store/conversation.store').useConversationStore
  ;(hook as unknown as { getState: () => typeof state }).getState = () => state

  return {
    useConversationStoreMock: hook,
  }
})

vi.mock('@/store/conversation.store', () => ({
  useConversationStore: useConversationStoreMock,
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
      maxTokens: 8000,
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
  useT: () => (key: string) => {
    const map: Record<string, string> = {
      'conversation.empty.title': 'Start a new conversation',
      'conversation.empty.description': 'I can help you with code, data analysis, documentation, and more.',
      'conversation.usage.highRisk': 'high-risk',
      'conversation.usage.nearLimit': 'near-limit',
      'conversation.usage.comfortable': 'comfortable',
      'conversation.toast.noApiKey': 'no-api-key',
      'conversation.toast.deletedTurn': 'deleted',
      'conversation.input.placeholder': 'placeholder',
      'conversation.input.send': 'send',
      'conversation.input.stop': 'stop',
    }
    return map[key] ?? key
  },
}))

vi.mock('../MessageBubble', () => ({
  MessageBubble: () => <div data-testid="message-bubble" />,
}))

vi.mock('../AssistantTurnBubble', () => ({
  AssistantTurnBubble: () => <div data-testid="assistant-turn-bubble" />,
}))

vi.mock('../AgentRichInput', () => ({
  AgentRichInput: ({ leadingAccessory }: { leadingAccessory?: ReactNode }) => (
    <div data-testid="agent-rich-input">{leadingAccessory}</div>
  ),
}))

vi.mock('@creatorweave/ui', () => ({
  BrandSwitch: () => <button type="button">switch</button>,
  TooltipProvider: ({ children }: any) => <>{children}</>,
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <>{children}</>,
}))

describe('ConversationView empty state', () => {
  it('does not render workflow templates in empty state', () => {
    render(<ConversationView />)

    expect(screen.getByText('Start a new conversation')).toBeInTheDocument()
    expect(screen.queryByText('or select a workflow template')).not.toBeInTheDocument()
    expect(screen.queryByText('Novel Daily')).not.toBeInTheDocument()
  })

  it('places the vision capability indicator inside the message input', () => {
    render(<ConversationView />)

    const input = screen.getByTestId('agent-rich-input')
    const indicator = screen.getByRole('button', { name: 'agent.vision.supported' })
    expect(input.parentElement).toContainElement(indicator)
  })
})
