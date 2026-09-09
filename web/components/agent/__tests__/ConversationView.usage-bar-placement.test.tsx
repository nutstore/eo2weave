/**
 * ConversationView usage-bar placement regression tests.
 *
 * The cumulative token usage bar used to be `sticky top-0` INSIDE the message
 * scroller. That broke when virtual scrolling landed (commit 45baeb7): under
 * Virtuoso the bar was rendered as the list Header, and a sticky element only
 * pins within its own parent box — a header exactly as tall as the bar has no
 * sticky range, so the bar scrolled away with the content.
 *
 * Contract under test: ConversationView owns the bar and mounts it OUTSIDE the
 * scroll container (as a fixed row above it), so it stays pinned for BOTH the
 * plain and the virtualized renderer, and it never renders for an empty
 * conversation.
 */
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConversationView } from '../ConversationView'
import type { Message } from '@/agent/message-types'

const { conversationState, useConversationStoreMock } = vi.hoisted(() => {
  const conversationState = {
    activeConversationId: 'conv-1',
    conversations: [
      {
        id: 'conv-1',
        messages: [] as unknown[],
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
  const hook = ((selector: (storeState: typeof conversationState) => unknown) =>
    selector(conversationState)) as unknown as
    typeof import('@/store/conversation.store').useConversationStore
  ;(hook as unknown as { getState: () => typeof conversationState }).getState = () => conversationState

  return { conversationState, useConversationStoreMock: hook }
})

vi.mock('@/store/conversation.store', () => ({
  useConversationStore: useConversationStoreMock,
}))

vi.mock('@/store/conversation-runtime.store', () => ({
  useConversationRuntimeStore: (selector?: (state: unknown) => unknown) => {
    const state = {
      runtimes: new Map(),
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
    return selector ? selector(state) : state
  },
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
      agents: Array<{ id: string; name?: string }>
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
  useAssetStore: (selector?: (state: Record<string, never>) => unknown) =>
    selector ? selector({}) : {},
}))

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
}))

vi.mock('../MessageBubble', () => ({
  MessageBubble: ({ message }: { message: Message }) => (
    <div data-testid="message-bubble" data-message-id={message.id} />
  ),
}))

vi.mock('../AssistantTurnBubble', () => ({
  AssistantTurnBubble: () => <div data-testid="assistant-turn-bubble" />,
}))

vi.mock('../AgentRichInput', () => ({
  AgentRichInput: () => <div data-testid="agent-rich-input" />,
}))

vi.mock('../QueuedMessageCard', () => ({
  QueuedMessageCard: () => <div data-testid="queued-card" />,
}))

/**
 * Usage bar is mocked but NOT removed: these tests assert PLACEMENT
 * (outside the scroller, before it in DOM order), not aggregation math.
 */
vi.mock('../ConversationUsageBar', () => ({
  ConversationUsageBar: () => <div data-testid="usage-bar" />,
}))

vi.mock('@creatorweave/ui', () => ({
  BrandSwitch: () => null,
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../FlowCanvasPanel', () => ({
  FlowCanvasPanel: () => <div data-testid="flow-canvas-panel" />,
}))

vi.mock('../AssetsPopover', () => ({
  AssetsPopover: () => <div data-testid="assets-popover" />,
}))

vi.mock('../ProcessesPopover', () => ({
  ProcessesPopover: () => <div data-testid="processes-popover" />,
}))

vi.mock('../ScrollToBottomButton', () => ({
  ScrollToBottomButton: () => <div data-testid="scroll-to-bottom" />,
}))

vi.mock('../MessageNavBar', () => ({
  MessageNavBar: () => <div data-testid="message-nav-bar" />,
}))

/** Two-turn conversation: usage exists once an assistant message carries usage. */
function setMessages(messages: unknown[]) {
  conversationState.conversations[0].messages = messages
}

describe('ConversationView usage bar placement', () => {
  it('renders the usage bar OUTSIDE the scroll container, above it', () => {
    setMessages([
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
    ])

    const { container } = render(<ConversationView />)

    const usageBar = container.querySelector('[data-testid="usage-bar"]')
    const scroller = container.querySelector('.overflow-y-auto')
    expect(usageBar).not.toBeNull()
    expect(scroller).not.toBeNull()

    // Must NOT be a descendant of the scroll container — a sticky element only
    // pins within its parent box, which is exactly how the Virtuoso header
    // regression happened (45baeb7).
    expect(scroller!.contains(usageBar as Node)).toBe(false)

    // Must come BEFORE the scroller (fixed row above the message area).
    const barIsBeforeScroller = (usageBar!.compareDocumentPosition(scroller as Node) &
      Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    expect(barIsBeforeScroller).toBe(true)
  })

  it('renders the usage bar for long (virtualized) conversations too', () => {
    // 60 pairs = 120 messages — above the 100-message virtualization threshold.
    const messages: unknown[] = []
    for (let i = 0; i < 60; i++) {
      messages.push({ id: `u-${i}`, role: 'user', content: `q ${i}`, timestamp: i * 10, type: 'message' })
      messages.push({
        id: `a-${i}`,
        role: 'assistant',
        content: `done ${i}`,
        timestamp: i * 10 + 1,
        type: 'message',
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })
    }
    setMessages(messages)

    const { container } = render(<ConversationView />)

    // Same placement contract as short conversations — the bar must be pinned
    // regardless of which renderer ConversationMessages picked.
    const usageBar = container.querySelector('[data-testid="usage-bar"]')
    const scroller = container.querySelector('.overflow-y-auto')
    expect(usageBar).not.toBeNull()
    expect(scroller!.contains(usageBar as Node)).toBe(false)
    const barIsBeforeScroller = (usageBar!.compareDocumentPosition(scroller as Node) &
      Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    expect(barIsBeforeScroller).toBe(true)

    // Sanity: the long-conversation path really is the virtualized one here.
    // (Real react-virtuoso renders zero items without layout measurement in
    // happy-dom, so assert on its scroller marker instead of message nodes.)
    expect(container.querySelector('[data-virtuoso-scroller]')).not.toBeNull()
  })

  it('does not render the usage bar for an empty conversation', () => {
    setMessages([])
    const { container } = render(<ConversationView />)
    expect(container.querySelector('[data-testid="usage-bar"]')).toBeNull()
  })
})
