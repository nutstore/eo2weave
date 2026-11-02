/**
 * ConversationMessages virtualization tests.
 *
 * react-virtuoso is mocked with a pass-through renderer so we can verify OUR
 * wiring (threshold switching, prop plumbing, nav delegation) without
 * depending on Virtuoso's real DOM measurement inside happy-dom.
 */

import { render, waitFor, act } from '@testing-library/react'
import { forwardRef, useImperativeHandle, memo } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@/agent/message-types'
import { ConversationMessages } from '../ConversationMessages'
import type { ConversationMessagesHandle } from '../ConversationMessages'
import type { VirtualAtBottomHub } from '../ScrollToBottomButton'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'

const {
  virtuosoSpy,
  virtuosoScrollToIndexSpy,
  atBottomStateChangeHandlers,
} = vi.hoisted(() => ({
  virtuosoSpy: vi.fn(),
  virtuosoScrollToIndexSpy: vi.fn(),
  // Records every atBottomStateChange callback Virtuoso receives, so tests
  // can fire real transitions (issue #141 scenarios) through OUR wiring.
  atBottomStateChangeHandlers: [] as Array<(atBottom: boolean) => void>,
}))

/**
 * Module-stable memoized Footer slot, mirroring the real library: react-virtuoso
 * defines its Footer ONCE at module scope and wraps it in React.memo, so a new
 * parent render does NOT remount it — it only re-renders when its `context`
 * prop changes. The memo wrapper must be CACHED per component identity: creating
 * `memo(Footer)` inside the mock's render would mint a fresh element type every
 * render, forcing a remount and hiding frozen-footer bugs.
 */
const footerSlotCache = new WeakMap<
  (props: { context?: unknown }) => React.ReactNode,
  React.ComponentType<{ context?: unknown }>
>()
function getFooterSlot(Footer: (props: { context?: unknown }) => React.ReactNode) {
  let slot = footerSlotCache.get(Footer)
  if (!slot) {
    slot = memo(Footer)
    footerSlotCache.set(Footer, slot)
  }
  return slot
}

vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef(function VirtuosoMock(props: Record<string, unknown>, ref) {
    virtuosoSpy(props)
    useImperativeHandle(ref, () => ({
      scrollToIndex: virtuosoScrollToIndexSpy,
      scrollIntoView: vi.fn(),
      scrollTo: vi.fn(),
      scrollBy: vi.fn(),
    }))
    if (typeof props.atBottomStateChange === 'function') {
      atBottomStateChangeHandlers.push(props.atBottomStateChange as (atBottom: boolean) => void)
    }
    const data = (props.data ?? []) as unknown[]
    const itemContent = props.itemContent as (index: number, item: unknown) => React.ReactNode
    const computeItemKey = props.computeItemKey as (index: number, item: unknown) => string
    const components = (props.components ?? {}) as {
      Header?: () => React.ReactNode
      // Mirrors the real library: the Footer slot receives `context` as a prop
      // (see contextPropIfNotDomElement in react-virtuoso's List.tsx).
      Footer?: (props: { context?: unknown }) => React.ReactNode
    }
    const FooterSlot = components.Footer ? getFooterSlot(components.Footer) : null
    return (
      <div data-testid="virtuoso-mock">
        {components.Header ? <components.Header /> : null}
        {data.map((item, index) => (
          <div key={computeItemKey(index, item)} data-virtuoso-index={index}>
            {itemContent(index, item)}
          </div>
        ))}
        {FooterSlot ? <FooterSlot context={props.context} /> : null}
      </div>
    )
  }),
}))

vi.mock('@/store/conversation-runtime.store', () => {
  const state = {
    runtimes: new Map(),
    pendingMessageQueues: new Map(),
  }
  const useConversationRuntimeStore = (selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state
  ;(useConversationRuntimeStore as unknown as { getState: () => typeof state }).getState = () => state
  return { useConversationRuntimeStore }
})

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
}))

vi.mock('../MessageBubble', () => ({
  MessageBubble: ({ message }: { message: Message }) => (
    <div data-testid="message-bubble" data-message-id={message.id} />
  ),
}))

vi.mock('../AssistantTurnBubble', () => ({
  AssistantTurnBubble: () => <div data-testid="assistant-turn" />,
}))

/**
 * Spy on the real ConversationUsageBar instead of mocking it: the bar is now
 * owned by ConversationView (outside the scroller), so mocking it away here
 * would silently detach these tests from the layout we actually ship.
 */
const usageBarSpy = vi.fn()
vi.mock('../ConversationUsageBar', () => ({
  ConversationUsageBar: (props: { messages: Message[] }) => {
    usageBarSpy(props)
    return <div data-testid="usage-bar" />
  },
}))

vi.mock('../QueuedMessageCard', () => ({
  QueuedMessageCard: () => <div data-testid="queued-card" />,
}))

/** Interleaved user/assistant pairs → 2 messages per pair. */
function makeMessages(pairs: number): Message[] {
  const messages: Message[] = []
  for (let i = 0; i < pairs; i++) {
    messages.push({
      id: `u-${i}`,
      role: 'user',
      content: `user question ${i}`,
      timestamp: i * 10,
    } as Message)
    messages.push({
      id: `a-${i}`,
      role: 'assistant',
      content: `answer ${i}`,
      timestamp: i * 10 + 1,
    } as Message)
  }
  return messages
}

function renderMessages(messages: Message[], options: { isUserAtBottomRef?: React.MutableRefObject<boolean> } = {}) {
  const handleRef = { current: null as ConversationMessagesHandle | null }
  const messagesEndRef = { current: null as HTMLDivElement | null }
  const noop = vi.fn()
  render(
    <div className="overflow-y-auto" data-testid="scroll-container">
      <ConversationMessages
        ref={handleRef}
        activeMessages={messages}
        toolResults={new Map()}
        isProcessing={false}
        status="idle"
        onDeleteAgentLoop={noop}
        onEditAndResend={noop}
        onRegenerate={undefined}
        onCancel={noop}
        messagesEndRef={messagesEndRef}
        isUserAtBottomRef={options.isUserAtBottomRef ?? { current: true }}
        conversationId="conv-1"
        mentionAgents={[]}
      />
    </div>,
  )
  return { handleRef }
}

describe('ConversationMessages virtualization', () => {
  beforeEach(() => {
    virtuosoSpy.mockClear()
    virtuosoScrollToIndexSpy.mockClear()
    usageBarSpy.mockClear()
    atBottomStateChangeHandlers.length = 0
  })

  it('renders short conversations with the plain renderer (no Virtuoso)', () => {
    // 45 pairs → 90 messages, below the 100-message threshold
    const { container } = renderConversation(makeMessages(45))
    expect(container.querySelector('[data-testid="virtuoso-mock"]')).toBeNull()
    expect(container.querySelectorAll('[data-testid="message-bubble"]')).toHaveLength(45)
    expect(container.querySelectorAll('[data-testid="assistant-turn"]')).toHaveLength(45)
    // data-turn-index is only stamped on user turns (MessageNavBar contract)
    expect(container.querySelectorAll('[data-turn-index]')).toHaveLength(45)
    // The usage bar is NOT inside the message list anymore — ConversationView
    // renders it outside the scroller (sticky-in-Virtuoso-header regressed it).
    expect(container.querySelector('[data-testid="usage-bar"]')).toBeNull()
    expect(usageBarSpy).not.toHaveBeenCalled()
    expect(virtuosoSpy).not.toHaveBeenCalled()
  })

  it('renders long conversations through Virtuoso without a list header (usage bar moved out)', async () => {
    // 55 pairs → 110 messages, above the threshold
    const { container } = renderConversation(makeMessages(55))
    await waitFor(() => {
      expect(container.querySelector('[data-testid="virtuoso-mock"]')).not.toBeNull()
    })
    // All turns handed to Virtuoso as data
    expect(virtuosoSpy.mock.calls[0][0].data).toHaveLength(110)
    // No Header slot: the usage bar must NOT be inside the virtualized list
    const components = virtuosoSpy.mock.calls[0][0].components as { Header?: unknown }
    expect(components.Header).toBeUndefined()
    expect(container.querySelector('[data-testid="usage-bar"]')).toBeNull()
    expect(usageBarSpy).not.toHaveBeenCalled()
    expect(container.querySelectorAll('[data-testid="message-bubble"]')).toHaveLength(55)
    // followOutput / atBottomStateChange wired
    expect(typeof virtuosoSpy.mock.calls[0][0].followOutput).toBe('function')
    expect(typeof virtuosoSpy.mock.calls[0][0].atBottomStateChange).toBe('function')
  })

  it('never paints a full plain-list frame for large conversations', () => {
    // Regression guard for the mount guard: the resolution effect is a
    // useLayoutEffect, so within a single committed tree Virtuoso must always
    // be present once the threshold is crossed — the expensive plain list is
    // never committed as a visible frame.
    const { container } = renderConversation(makeMessages(55))
    expect(container.querySelector('[data-testid="virtuoso-mock"]')).not.toBeNull()
    // And the full plain list is NOT in the DOM beside it
    expect(container.querySelectorAll('[data-testid="message-bubble"]')).toHaveLength(55)
  })

  it('resolves the customScrollParent from the nearest overflow ancestor', async () => {
    const { container } = renderConversation(makeMessages(55))
    const scrollContainer = container.querySelector('[data-testid="scroll-container"]')
    await waitFor(() => {
      expect(virtuosoSpy).toHaveBeenCalled()
    })
    // Mount guard: Virtuoso is never mounted before the parent resolves, so
    // every observed call must already carry the resolved scroll container
    // (RTL's act() flushes the resolution effect synchronously, so the
    // transient plain-render frame is not observable here).
    for (const call of virtuosoSpy.mock.calls) {
      expect(call[0].customScrollParent).toBe(scrollContainer)
    }
  })

  it('delegates scrollToTurnIndex to Virtuoso in virtualized mode', async () => {
    const { handleRef } = renderMessages(makeMessages(55))
    await waitFor(() => {
      expect(handleRef.current).not.toBeNull()
      expect(virtuosoSpy).toHaveBeenCalled()
    })
    handleRef.current!.scrollToTurnIndex(7)
    expect(virtuosoScrollToIndexSpy).toHaveBeenCalledWith({ index: 7, align: 'start' })
  })

  it('keeps scrollToTurnIndex on the DOM path in plain mode', () => {
    const { handleRef } = renderMessages(makeMessages(5))
    handleRef.current!.scrollToTurnIndex(1)
    expect(virtuosoScrollToIndexSpy).not.toHaveBeenCalled()
    // DOM query path ran without throwing (no matching node inside jsdom-free
    // container is fine — the important part is it did NOT touch virtuoso)
  })

  it('delivers queued messages to the Virtuoso footer reactively via the context prop', () => {
    // Regression: the footer used to be bridged through a module-level variable
    // that Virtuoso's memoized Footer slot never re-read, so queued messages
    // (and the streaming draft bubble) did not appear on long conversations.
    // The footer content must flow through Virtuoso's `context` prop.
    const runtimeState = useConversationRuntimeStore.getState()
    runtimeState.pendingMessageQueues.delete('conv-1')

    const messagesEndRef = { current: null as HTMLDivElement | null }
    const noop = vi.fn()
    const uiProps = {
      // activeMessages is passed FRESH inside ui() below: a new array reference
      // is what makes memo(ConversationMessages) re-render, standing in for the
      // real zustand subscription push that happens in the app.
      toolResults: new Map(),
      isProcessing: true,
      status: 'tool_calling',
      onDeleteAgentLoop: noop,
      onEditAndResend: noop,
      onRegenerate: undefined,
      onCancel: noop,
      messagesEndRef,
      conversationId: 'conv-1',
      mentionAgents: [],
    }
    const ui = () => (
      <div className="overflow-y-auto" data-testid="scroll-container">
        <ConversationMessages {...uiProps} activeMessages={makeMessages(55)} />
      </div>
    )

    // Deliberately rerender with the SAME element key: a remount would rebuild
    // even a frozen Footer slot and defeat this regression test.
    const { rerender, container } = render(ui())
    // Agent processing, but queue still empty → no cards
    expect(container.querySelectorAll('[data-testid="queued-card"]')).toHaveLength(0)

    // Enqueue while processing → the NEXT render must surface the card inside
    // the footer slot (previously it stayed invisible until an unrelated list
    // change happened to re-render the frozen Footer slot).
    runtimeState.pendingMessageQueues.set('conv-1', [
      { text: 'queued hello', agentOverrideId: null, enqueuedAt: 1 },
    ])
    rerender(ui())

    expect(container.querySelectorAll('[data-testid="queued-card"]')).toHaveLength(1)

    runtimeState.pendingMessageQueues.delete('conv-1')
  })

  // ── Issue #141: scroll-to-bottom under virtual scrolling ──

  it('follows new messages when the user is at the bottom (followOutput)', async () => {
    // Simulate the streaming flow: conversation starts at-bottom, then a new
    // turn is appended. followOutput must return 'smooth' while at-bottom and
    // the seed must come from the shared ref.
    const isUserAtBottomRef = { current: true }
    const { rerender, container } = renderVirtual(55, { isUserAtBottomRef })
    await waitFor(() => {
      expect(container.querySelector('[data-testid="virtuoso-mock"]')).not.toBeNull()
    })
    expect(virtuosoSpy.mock.calls[0][0].followOutput()).toBe('smooth')

    // New turn arrives while still at-bottom → follow stays on
    rerender(makeVirtualUi(56, { isUserAtBottomRef }))
    expect(virtuosoSpy.mock.calls.at(-1)![0].followOutput()).toBe('smooth')
  })

  it('stops following new messages when the user scrolled up', async () => {
    const isUserAtBottomRef = { current: true }
    const { rerender, container } = renderVirtual(55, { isUserAtBottomRef })
    await waitFor(() => {
      expect(container.querySelector('[data-testid="virtuoso-mock"]')).not.toBeNull()
    })

    // User scrolls up → Virtuoso fires atBottomStateChange(false) through OUR
    // funnel, which must mirror into the shared ref that followOutput reads.
    const handler = atBottomStateChangeHandlers.at(-1)!
    act(() => handler(false))

    rerender(makeVirtualUi(56, { isUserAtBottomRef }))
    expect(virtuosoSpy.mock.calls.at(-1)![0].followOutput()).toBe(false)
    expect(isUserAtBottomRef.current).toBe(false)
  })

  it('button click lands at bottom via Virtuoso scrollToIndex in virtual mode', async () => {
    const isUserAtBottomRef = { current: false }
    const { handleRef, container } = renderVirtual(55, { isUserAtBottomRef })
    await waitFor(() => {
      expect(container.querySelector('[data-testid="virtuoso-mock"]')).not.toBeNull()
      expect(handleRef.current).not.toBeNull()
    })

    // The scroll-to-bottom button clicks through the imperative handle's
    // scrollToLastTurn — the exact entry point ScrollToBottomButton uses.
    act(() => handleRef.current!.scrollToLastTurn('smooth'))

    // Must route through Virtuoso (index 'LAST'), NOT a native scrollTop write
    expect(virtuosoScrollToIndexSpy).toHaveBeenCalledWith({
      index: 'LAST',
      align: 'end',
      behavior: 'smooth',
    })
  })

  it('scrollToLastTurn stays on the native DOM path in plain mode', () => {
    const scrollToSpy = vi.fn()
    const isUserAtBottomRef = { current: false }
    const { handleRef } = renderPlainWithScrollSpy(scrollToSpy, isUserAtBottomRef)
    act(() => handleRef.current!.scrollToLastTurn('smooth'))
    expect(virtuosoScrollToIndexSpy).not.toHaveBeenCalled()
    expect(scrollToSpy).toHaveBeenCalledWith({ top: expect.any(Number), behavior: 'smooth' })
  })

  it('button visibility toggles with atBottomStateChange through the listener hub', async () => {
    const isUserAtBottomRef = { current: true }
    const hub: VirtualAtBottomHub = { listeners: new Set() }
    const received: boolean[] = []
    hub.listeners.add((atBottom) => received.push(atBottom))

    const { container } = renderVirtual(55, { isUserAtBottomRef, virtualAtBottomHub: hub })
    await waitFor(() => {
      expect(container.querySelector('[data-testid="virtuoso-mock"]')).not.toBeNull()
    })

    // Virtuoso fires scrolled-up → every hub listener receives false
    const handler = atBottomStateChangeHandlers.at(-1)!
    act(() => handler(false))
    expect(received).toEqual([false])
    expect(isUserAtBottomRef.current).toBe(false)

    // Scroll back to bottom → true fans out
    act(() => handler(true))
    expect(received).toEqual([false, true])
    expect(isUserAtBottomRef.current).toBe(true)
  })
})

/** Render a virtualized conversation with configurable props (issue #141 tests). */
function makeVirtualUi(
  pairs: number,
  options: { isUserAtBottomRef?: React.MutableRefObject<boolean>; virtualAtBottomHub?: VirtualAtBottomHub; handleRef?: { current: ConversationMessagesHandle | null } } = {},
) {
  const noop = vi.fn()
  const messagesEndRef = { current: null as HTMLDivElement | null }
  return (
    <div className="overflow-y-auto" data-testid="scroll-container">
      <ConversationMessages
        ref={options.handleRef ?? undefined}
        activeMessages={makeMessages(pairs)}
        toolResults={new Map()}
        isProcessing={false}
        status="idle"
        onDeleteAgentLoop={noop}
        onEditAndResend={noop}
        onRegenerate={undefined}
        onCancel={noop}
        messagesEndRef={messagesEndRef}
        isUserAtBottomRef={options.isUserAtBottomRef ?? { current: true }}
        virtualAtBottomHub={options.virtualAtBottomHub}
        conversationId="conv-1"
        mentionAgents={[]}
      />
    </div>
  )
}

function renderVirtual(
  pairs: number,
  options: { isUserAtBottomRef?: React.MutableRefObject<boolean>; virtualAtBottomHub?: VirtualAtBottomHub } = {},
) {
  const handleRef = { current: null as ConversationMessagesHandle | null }
  const opts = { ...options, handleRef }
  const { container, rerender } = render(makeVirtualUi(pairs, opts))
  return {
    container,
    handleRef,
    rerender: (ui: React.ReactElement) => rerender(ui),
  }
}

/** Plain renderer (< threshold) with a spy scroll container for the DOM path. */
function renderPlainWithScrollSpy(
  scrollToSpy: ReturnType<typeof vi.fn>,
  isUserAtBottomRef: React.MutableRefObject<boolean>,
) {
  const handleRef = { current: null as ConversationMessagesHandle | null }
  const noop = vi.fn()
  const messagesEndRef = { current: null as HTMLDivElement | null }
  const { container } = render(
    <div
      className="overflow-y-auto"
      data-testid="scroll-container"
      ref={(el) => {
        if (el) (el as unknown as { scrollTo: unknown }).scrollTo = scrollToSpy
      }}
    >
      <ConversationMessages
        ref={handleRef}
        activeMessages={makeMessages(5)}
        toolResults={new Map()}
        isProcessing={false}
        status="idle"
        onDeleteAgentLoop={noop}
        onEditAndResend={noop}
        onRegenerate={undefined}
        onCancel={noop}
        messagesEndRef={messagesEndRef}
        isUserAtBottomRef={isUserAtBottomRef}
        conversationId="conv-1"
        mentionAgents={[]}
      />
    </div>,
  )
  return { handleRef, container }
}

/** Helper so tests can also reach the rendered container. */
function renderConversation(messages: Message[]) {
  const handleRef = { current: null as ConversationMessagesHandle | null }
  const messagesEndRef = { current: null as HTMLDivElement | null }
  const noop = vi.fn()
  const { container } = render(
    <div className="overflow-y-auto" data-testid="scroll-container">
      <ConversationMessages
        ref={handleRef}
        activeMessages={messages}
        toolResults={new Map()}
        isProcessing={false}
        status="idle"
        onDeleteAgentLoop={noop}
        onEditAndResend={noop}
        onRegenerate={undefined}
        onCancel={noop}
        messagesEndRef={messagesEndRef}
        conversationId="conv-1"
        mentionAgents={[]}
      />
    </div>,
  )
  return { container, handleRef }
}
