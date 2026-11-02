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
import { ScrollToBottomButton } from '@/components/agent/ScrollToBottomButton'
import type { VirtualAtBottomHub } from '@/components/agent/ScrollToBottomButton'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'

const {
  virtuosoSpy,
  virtuosoScrollToIndexSpy,
  virtuosoScrollToSpy,
  atBottomStateChangeHandlers,
} = vi.hoisted(() => ({
  virtuosoSpy: vi.fn(),
  virtuosoScrollToIndexSpy: vi.fn(),
  virtuosoScrollToSpy: vi.fn(),
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
      // Faithful to real Virtuoso: a scroll that lands at the bottom fires
      // atBottomStateChange(true). The click tests rely on this to verify the
      // jump actually REACHES the bottom (state follows Virtuoso's verdict),
      // not merely that a scrollTo call was made.
      scrollTo: (...args: unknown[]) => {
        virtuosoScrollToSpy(...args)
        const handler = atBottomStateChangeHandlers.at(-1)
        if (handler) handler(true)
      },
      scrollIntoView: vi.fn(),
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
    virtuosoScrollToSpy.mockClear()
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

  it('followOutput returns false when the shared ref seeds NOT-at-bottom (PR #142 review)', async () => {
    // Sourcery thread: existing tests only seed isUserAtBottomRef=true. A
    // conversation mounted while the user is NOT at the bottom (e.g. the
    // seed left behind by the previous conversation before the
    // WorkspaceLayout remount) must NOT follow appends — otherwise opening a
    // long conversation yanks the user away from where they were.
    const isUserAtBottomRef = { current: false }
    const { rerender, container } = renderVirtual(55, { isUserAtBottomRef })
    await waitFor(() => {
      expect(container.querySelector('[data-testid="virtuoso-mock"]')).not.toBeNull()
    })
    expect(virtuosoSpy.mock.calls[0][0].followOutput()).toBe(false)

    // Appends stay unfollowed until the funnel flips the state
    rerender(makeVirtualUi(56, { isUserAtBottomRef }))
    expect(virtuosoSpy.mock.calls.at(-1)![0].followOutput()).toBe(false)

    // Virtuoso reports at-bottom again → following re-enables
    const handler = atBottomStateChangeHandlers.at(-1)!
    act(() => handler(true))
    rerender(makeVirtualUi(57, { isUserAtBottomRef }))
    expect(virtuosoSpy.mock.calls.at(-1)![0].followOutput()).toBe('smooth')
  })

  it('button click lands at bottom via Virtuoso scrollTo (footer-inclusive) in virtual mode', async () => {
    const isUserAtBottomRef = { current: false }
    const hub: VirtualAtBottomHub = { listeners: new Set(), lastAtBottom: false }
    const { handleRef, container } = renderWithButton(55, { isUserAtBottomRef, virtualAtBottomHub: hub })
    await waitFor(() => {
      expect(container.querySelector('[data-testid="virtuoso-mock"]')).not.toBeNull()
      expect(handleRef.current).not.toBeNull()
    })

    // The button must be visible (Virtuoso last reported not-at-bottom)
    const button = await waitFor(() => {
      const el = container.querySelector('[data-testid="scroll-to-bottom"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })

    // Drive the click through the REAL button — a broken wiring (hub fan-out,
    // followOutput re-enable, scroll delegation) must fail this test.
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Must route through Virtuoso's footer-inclusive scrollTo, NOT a native
    // scrollTop write and NOT scrollToIndex (which targets the last DATA
    // turn and leaves the footer below the viewport). The mock's scrollTo
    // fires atBottomStateChange(true) like the real library, so the
    // assertions below also prove the jump actually LANDS at the bottom:
    // the list's followOutput state re-enables and the button hides.
    expect(virtuosoScrollToSpy).toHaveBeenCalledWith({
      top: Number.MAX_SAFE_INTEGER,
      behavior: 'smooth',
    })
    expect(virtuosoScrollToIndexSpy).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(isUserAtBottomRef.current).toBe(true)
      expect(container.querySelector('[data-testid="scroll-to-bottom"]')).toBeNull()
    })
  })

  it('button click re-enables followOutput for subsequently appended turns', async () => {
    const isUserAtBottomRef = { current: false }
    const hub: VirtualAtBottomHub = { listeners: new Set(), lastAtBottom: false }
    const { handleRef, rerender, container } = renderWithButton(55, { isUserAtBottomRef, virtualAtBottomHub: hub })
    await waitFor(() => {
      expect(container.querySelector('[data-testid="virtuoso-mock"]')).not.toBeNull()
      expect(handleRef.current).not.toBeNull()
    })

    // Not at bottom → followOutput is off
    expect(virtuosoSpy.mock.calls.at(-1)![0].followOutput()).toBe(false)

    const button = await waitFor(() => {
      const el = container.querySelector('[data-testid="scroll-to-bottom"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // The click must have pushed at-bottom through the funnel so the LIST's
    // followOutput state re-enabled (not just the button's own visibility).
    await waitFor(() => {
      expect(isUserAtBottomRef.current).toBe(true)
    })
    rerender(56)
    expect(virtuosoSpy.mock.calls.at(-1)![0].followOutput()).toBe('smooth')
  })

  it('scrollToLastTurn stays on the native DOM path in plain mode', () => {
    const scrollToSpy = vi.fn()
    const isUserAtBottomRef = { current: false }
    const { handleRef } = renderPlainWithScrollSpy(scrollToSpy, isUserAtBottomRef)
    act(() => handleRef.current!.scrollToLastTurn('smooth'))
    expect(virtuosoScrollToIndexSpy).not.toHaveBeenCalled()
    expect(virtuosoScrollToSpy).not.toHaveBeenCalled()
    // Nonzero geometry: the plain path must target the container's true
    // scrollHeight, not just "any number" (top: 0 would be a no-op).
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1500, behavior: 'smooth' })
  })

  it('button visibility toggles with atBottomStateChange through the listener hub', async () => {
    const isUserAtBottomRef = { current: true }
    const hub: VirtualAtBottomHub = { listeners: new Set(), lastAtBottom: null }
    const { container } = renderWithButton(55, { isUserAtBottomRef, virtualAtBottomHub: hub })
    await waitFor(() => {
      expect(container.querySelector('[data-testid="virtuoso-mock"]')).not.toBeNull()
    })

    // No Virtuoso signal yet → button hidden
    expect(container.querySelector('[data-testid="scroll-to-bottom"]')).toBeNull()

    // Virtuoso fires scrolled-up → the real button becomes visible
    const handler = atBottomStateChangeHandlers.at(-1)!
    act(() => handler(false))
    expect(container.querySelector('[data-testid="scroll-to-bottom"]')).not.toBeNull()
    expect(isUserAtBottomRef.current).toBe(false)

    // Scroll back to bottom → button hides again
    act(() => handler(true))
    expect(container.querySelector('[data-testid="scroll-to-bottom"]')).toBeNull()
    expect(isUserAtBottomRef.current).toBe(true)
  })

  it('interrupted jump re-shows the button and disables followOutput (review round 3)', async () => {
    // Sourcery: the click's optimistic at-bottom (funnel push) marks the list
    // and hub at-bottom before the smooth scroll lands. If the user scrolls
    // up mid-animation, Virtuoso is still not-at-bottom, so NO transition —
    // and thus no atBottomStateChange — fires. The scroll-away resync must
    // restore button visibility and turn followOutput back off.
    const isUserAtBottomRef = { current: false }
    const hub: VirtualAtBottomHub = { listeners: new Set(), lastAtBottom: false }
    const scrollContainerRef = { current: null as HTMLDivElement | null }
    const { handleRef, container, rerender } = renderWithButton(55, {
      isUserAtBottomRef,
      virtualAtBottomHub: hub,
      scrollContainerRef,
    })
    await waitFor(() => {
      expect(container.querySelector('[data-testid="virtuoso-mock"]')).not.toBeNull()
      expect(handleRef.current).not.toBeNull()
    })

    const button = await waitFor(() => {
      const el = container.querySelector('[data-testid="scroll-to-bottom"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })

    // Click → optimistic hide + optimistic funnel push (followOutput on).
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[data-testid="scroll-to-bottom"]')).toBeNull()
    expect(isUserAtBottomRef.current).toBe(true)

    // User scrolls UP mid-jump: no atBottomStateChange fires (Virtuoso never
    // reached bottom), just a scroll event on the scroll container with
    // decreasing scrollTop. The resync must funnel not-at-bottom back through.
    const scroller = container.querySelector('[data-testid="scroll-container"]') as HTMLDivElement
    expect(scroller).not.toBeNull()
    act(() => {
      Object.defineProperty(scroller!, 'scrollTop', { value: 400, configurable: true })
      scroller!.dispatchEvent(new Event('scroll'))
      Object.defineProperty(scroller!, 'scrollTop', { value: 150, configurable: true })
      scroller!.dispatchEvent(new Event('scroll'))
    })

    // Button re-shows and followOutput is disabled again.
    await waitFor(() => {
      expect(container.querySelector('[data-testid="scroll-to-bottom"]')).not.toBeNull()
    })
    expect(isUserAtBottomRef.current).toBe(false)
    rerender(56)
    expect(virtuosoSpy.mock.calls.at(-1)![0].followOutput()).toBe(false)
    expect(hub.lastAtBottom).toBe(false)
  })

  it('detects an interruption on the FIRST user scroll after the click (review round 4)', async () => {
    // Sourcery: the round-3 detector discarded the first scroll event as
    // "calibration". If the user's first scroll arrives before any animation
    // event — and no later event or at-bottom transition follows — the jump
    // stays pending forever, the button stays hidden, and streaming keeps
    // pulling the user down. The baseline is now captured AT CLICK TIME, so
    // a single decreasing scroll event must resync immediately.
    const isUserAtBottomRef = { current: false }
    const hub: VirtualAtBottomHub = { listeners: new Set(), lastAtBottom: false }
    const scrollContainerRef = { current: null as HTMLDivElement | null }
    const { handleRef, container } = renderWithButton(55, {
      isUserAtBottomRef,
      virtualAtBottomHub: hub,
      scrollContainerRef,
    })
    await waitFor(() => {
      expect(container.querySelector('[data-testid="virtuoso-mock"]')).not.toBeNull()
      expect(handleRef.current).not.toBeNull()
    })

    const button = await waitFor(() => {
      const el = container.querySelector('[data-testid="scroll-to-bottom"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })

    const scroller = container.querySelector('[data-testid="scroll-container"]') as HTMLDivElement
    expect(scroller).not.toBeNull()
    // The user is mid-list when they click (scrollTop 500); the click must
    // capture THAT position as the interrupt baseline.
    act(() => {
      Object.defineProperty(scroller, 'scrollTop', { value: 500, configurable: true })
    })
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[data-testid="scroll-to-bottom"]')).toBeNull()

    // Exactly ONE scroll event arrives — the user's first gesture, before
    // any animation scroll event was handled — and it moves UP (500 → 200).
    act(() => {
      Object.defineProperty(scroller, 'scrollTop', { value: 200, configurable: true })
      scroller.dispatchEvent(new Event('scroll'))
    })

    // The interruption must be detected on this first event alone: button
    // re-shows, followOutput is off, the funnel is back at not-at-bottom.
    await waitFor(() => {
      expect(container.querySelector('[data-testid="scroll-to-bottom"]')).not.toBeNull()
    })
    expect(isUserAtBottomRef.current).toBe(false)
    expect(hub.lastAtBottom).toBe(false)
  })

  it('recaptures the interrupt baseline on every click (review round 4)', async () => {
    // Sourcery: the calibration flag and scroll baseline persisted across
    // clicks (they lived in the scroll-listener effect's closure). The
    // baseline must restart from the pre-jump position of EACH jump.
    const isUserAtBottomRef = { current: false }
    const hub: VirtualAtBottomHub = { listeners: new Set(), lastAtBottom: false }
    const scrollContainerRef = { current: null as HTMLDivElement | null }
    const { handleRef, container, rerender } = renderWithButton(55, {
      isUserAtBottomRef,
      virtualAtBottomHub: hub,
      scrollContainerRef,
    })
    await waitFor(() => {
      expect(container.querySelector('[data-testid="virtuoso-mock"]')).not.toBeNull()
      expect(handleRef.current).not.toBeNull()
    })

    const click = async () => {
      const el = await waitFor(() => {
        const b = container.querySelector('[data-testid="scroll-to-bottom"]')
        expect(b).not.toBeNull()
        return b as HTMLElement
      })
      act(() => {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    }
    const scroller = container.querySelector('[data-testid="scroll-container"]') as HTMLDivElement
    const scroll = (top: number) => {
      act(() => {
        Object.defineProperty(scroller, 'scrollTop', { value: top, configurable: true })
        scroller.dispatchEvent(new Event('scroll'))
      })
    }

    // Jump #1 from scrollTop 400: an animation-style scroll DOWN advances the
    // baseline without ending the jump, then the user scrolls up and the
    // resync fires (jump #1 interrupted at scrollTop 250).
    act(() => {
      Object.defineProperty(scroller, 'scrollTop', { value: 400, configurable: true })
    })
    await click()
    scroll(450)
    expect(container.querySelector('[data-testid="scroll-to-bottom"]')).toBeNull()
    scroll(250)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="scroll-to-bottom"]')).not.toBeNull()
    })
    expect(isUserAtBottomRef.current).toBe(false)

    // Jump #2 from the interrupted position (250): the baseline must restart
    // there — NOT inherit jump #1's history. A single scroll down to 300 is
    // the animation (no interrupt), and the very next scroll up to 120 is a
    // genuine interruption detected without any calibration event.
    await click()
    scroll(300)
    expect(container.querySelector('[data-testid="scroll-to-bottom"]')).toBeNull()
    scroll(120)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="scroll-to-bottom"]')).not.toBeNull()
    })
    expect(isUserAtBottomRef.current).toBe(false)
    expect(hub.lastAtBottom).toBe(false)
    rerender(56)
    expect(virtuosoSpy.mock.calls.at(-1)![0].followOutput()).toBe(false)
  })

  it('button replays the hub state it subscribed after (no missed initial signal)', async () => {
    const isUserAtBottomRef = { current: false }
    const hub: VirtualAtBottomHub = { listeners: new Set(), lastAtBottom: false }
    const handleRef = { current: null as ConversationMessagesHandle | null }
    const scrollContainerRef = { current: null as HTMLDivElement | null }
    const noop = vi.fn()
    const messagesEndRef = { current: null as HTMLDivElement | null }
    // Same harness as the mode-switch test below: full prop control so the
    // rerender can flip virtualized→plain→virtualized and genuinely tear
    // down / re-register the hub subscription effect. The container is
    // stubbed FAR from the bottom so plain-mode geometry keeps the button
    // visible across the flip (happy-dom gives the div zero size, which
    // native geometry would otherwise read as at-bottom → hidden).
    const ui = (virtual: boolean) => (
      <div className="overflow-y-auto" data-testid="scroll-container" ref={(el) => {
        scrollContainerRef.current = el
        if (el) {
          Object.defineProperty(el, 'scrollHeight', { value: 1500, configurable: true })
          Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
          Object.defineProperty(el, 'scrollTop', { value: 0, configurable: true })
        }
      }}>
        <ConversationMessages
          ref={handleRef}
          activeMessages={makeMessages(virtual ? 55 : 5)}
          toolResults={new Map()}
          isProcessing={false}
          status="idle"
          onDeleteAgentLoop={noop}
          onEditAndResend={noop}
          onRegenerate={undefined}
          onCancel={noop}
          messagesEndRef={messagesEndRef}
          isUserAtBottomRef={isUserAtBottomRef}
          virtualAtBottomHub={hub}
          conversationId="conv-1"
          mentionAgents={[]}
        />
        <ScrollToBottomButton
          scrollContainerRef={scrollContainerRef}
          messagesEndRef={messagesEndRef}
          isUserAtBottomRef={isUserAtBottomRef}
          convId="conv-1"
          {...(virtual
            ? { isVirtualized: true as const, virtuosoRef: handleRef, virtualAtBottomHub: hub }
            : { isVirtualized: false as const })}
        />
      </div>
    )
    const { container, rerender } = render(ui(true))
    await waitFor(() => {
      expect(container.querySelector('[data-testid="virtuoso-mock"]')).not.toBeNull()
    })

    // Virtuoso reported not-at-bottom, then the subscription remounted
    // (virtualized→plain→virtualized mode flip, or a late effect). The
    // replay on registration must surface the hub's last value WITHOUT any
    // new atBottomStateChange (no handler calls here). Review round 2: the
    // rerender actually flips virtual→plain→virtual so the subscription
    // effect genuinely tears down and re-registers — a replay that only
    // works on same-mode renders cannot pass this.
    rerender(ui(false))
    expect(container.querySelector('[data-testid="scroll-to-bottom"]')).not.toBeNull()
    rerender(ui(true))
    await waitFor(() => {
      expect(container.querySelector('[data-testid="scroll-to-bottom"]')).not.toBeNull()
    })
  })

  it('plain-mode visibility recomputes from geometry on effect setup (mode switch)', async () => {
    // Virtualized → plain transition: the plain effect must derive show from
    // the CURRENT geometry once at setup, not wait for the first scroll
    // event (which would leave the button stale-hidden or stale-shown).
    const isUserAtBottomRef = { current: false }
    const hub: VirtualAtBottomHub = { listeners: new Set(), lastAtBottom: false }
    const handleRef = { current: null as ConversationMessagesHandle | null }
    const scrollContainerRef = { current: null as HTMLDivElement | null }
    // Geometry stubs live in a closure the ref callback reads, so flipping
    // `atBottom` between renders actually changes what handleScroll() sees
    // (the ref callback re-runs on every rerender and would otherwise reset
    // scrollTop back to the far-from-bottom value).
    const geometry = { scrollTop: 0 }
    const noop = vi.fn()
    const messagesEndRef = { current: null as HTMLDivElement | null }
    const ui = (virtual: boolean) => (
      <div
        className="overflow-y-auto"
        data-testid="scroll-container"
        ref={(el) => {
          scrollContainerRef.current = el
          if (el) {
            // Far from bottom: 1500 scrollHeight, 600 clientHeight.
            Object.defineProperty(el, 'scrollHeight', { value: 1500, configurable: true })
            Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
            Object.defineProperty(el, 'scrollTop', { value: geometry.scrollTop, configurable: true })
          }
        }}
      >
        <ConversationMessages
          ref={handleRef}
          activeMessages={makeMessages(virtual ? 55 : 5)}
          toolResults={new Map()}
          isProcessing={false}
          status="idle"
          onDeleteAgentLoop={noop}
          onEditAndResend={noop}
          onRegenerate={undefined}
          onCancel={noop}
          messagesEndRef={messagesEndRef}
          isUserAtBottomRef={isUserAtBottomRef}
          virtualAtBottomHub={hub}
          conversationId="conv-1"
          mentionAgents={[]}
        />
        <ScrollToBottomButton
          scrollContainerRef={scrollContainerRef}
          messagesEndRef={messagesEndRef}
          isUserAtBottomRef={isUserAtBottomRef}
          convId="conv-1"
          {...(virtual
            ? { isVirtualized: true as const, virtuosoRef: handleRef, virtualAtBottomHub: hub }
            : { isVirtualized: false as const })}
        />
      </div>
    )
    const { container, rerender } = render(ui(true))
    await waitFor(() => {
      expect(container.querySelector('[data-testid="virtuoso-mock"]')).not.toBeNull()
    })
    expect(container.querySelector('[data-testid="scroll-to-bottom"]')).not.toBeNull()

    // Mode switch to plain while the user is far from the bottom: the
    // plain-mode setup effect must run handleScroll() once and show the
    // button immediately (previous behavior waited for a scroll event).
    rerender(ui(false))
    expect(container.querySelector('[data-testid="scroll-to-bottom"]')).not.toBeNull()

    // Symmetric case (review round 2): switch to plain while ALREADY at the
    // bottom — setup geometry must HIDE the button, not keep the stale
    // visible state from the virtualized phase. Flip the container geometry
    // to at-bottom first, otherwise the div keeps its 1500/600 far-from-
    // bottom stub and the button legitimately stays visible.
    rerender(ui(true))
    act(() => atBottomStateChangeHandlers.at(-1)?.(true))
    geometry.scrollTop = 900
    rerender(ui(false))
    expect(container.querySelector('[data-testid="scroll-to-bottom"]')).toBeNull()
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
        if (el) {
          // Nonzero deterministic geometry: scrollHeight 1500, clientHeight
          // 600, scrollTop 0 → 900px above bottom → button must show.
          Object.defineProperty(el, 'scrollHeight', { value: 1500, configurable: true })
          Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
          Object.defineProperty(el, 'scrollTop', { value: 0, configurable: true })
          ;(el as unknown as { scrollTo: unknown }).scrollTo = scrollToSpy
        }
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

/**
 * Renders ConversationMessages AND the real ScrollToBottomButton inside the
 * same scroll container, wired exactly as ConversationView wires them (shared
 * isUserAtBottomRef + hub). Used for tests that must drive the actual button
 * instead of calling the imperative handle directly.
 */
function renderWithButton(
  pairs: number,
  options: {
    isUserAtBottomRef?: React.MutableRefObject<boolean>
    virtualAtBottomHub?: VirtualAtBottomHub
    /** Shared ref the button mounts its scroll listeners on (interrupted-jump test). */
    scrollContainerRef?: React.MutableRefObject<HTMLDivElement | null>
  } = {},
) {
  const handleRef = { current: null as ConversationMessagesHandle | null }
  const isUserAtBottomRef = options.isUserAtBottomRef ?? { current: true }
  const scrollContainerRef = options.scrollContainerRef ?? { current: null as HTMLDivElement | null }
  const noop = vi.fn()
  const messagesEndRef = { current: null as HTMLDivElement | null }
  const ui = (count: number) => (
    <div
      className="overflow-y-auto"
      data-testid="scroll-container"
      ref={options.scrollContainerRef ? (el) => { options.scrollContainerRef!.current = el } : undefined}
    >
      <ConversationMessages
        ref={handleRef}
        activeMessages={makeMessages(count)}
        toolResults={new Map()}
        isProcessing={false}
        status="idle"
        onDeleteAgentLoop={noop}
        onEditAndResend={noop}
        onRegenerate={undefined}
        onCancel={noop}
        messagesEndRef={messagesEndRef}
        isUserAtBottomRef={isUserAtBottomRef}
        virtualAtBottomHub={options.virtualAtBottomHub}
        conversationId="conv-1"
        mentionAgents={[]}
      />
      <ScrollToBottomButton
        scrollContainerRef={scrollContainerRef}
        messagesEndRef={messagesEndRef}
        isUserAtBottomRef={isUserAtBottomRef}
        convId="conv-1"
        isVirtualized
        virtuosoRef={handleRef}
        virtualAtBottomHub={options.virtualAtBottomHub!}
      />
    </div>
  )
  const { container, rerender } = render(ui(pairs))
  return {
    container,
    handleRef,
    isUserAtBottomRef,
    scrollContainerRef,
    /** Re-render with a new message count, keeping the SAME button in the tree. */
    rerender: (nextPairs: number) => rerender(ui(nextPairs)),
  }
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
