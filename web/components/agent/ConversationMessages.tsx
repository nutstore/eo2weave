/**
 * ConversationMessages — renders the list of message turns,
 * draft assistant bubble.
 *
 * Streaming data (draftAssistant, streamingState, streamingContent, toolResults)
 * is subscribed directly from the runtime store inside this component,
 * so that parent components (ConversationView) do NOT re-render on every
 * streaming token (~60fps). Only this component tree re-renders.
 */

import { memo, useMemo, forwardRef, useImperativeHandle, useCallback, useRef, useState, useEffect, useLayoutEffect } from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { VirtuosoHandle } from 'react-virtuoso'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'
import { useShallow } from 'zustand/react/shallow'
import { MessageBubble } from './MessageBubble'
import { AssistantTurnBubble } from './AssistantTurnBubble'
import type { VirtualAtBottomListener, VirtualAtBottomHub } from '@/components/agent/ScrollToBottomButton'
import { groupMessagesIntoTurns } from './group-messages'
import type { Turn } from './group-messages'
import { QueuedMessageCard } from './QueuedMessageCard'
import { visibleTranscriptMessages } from './queued-message-visibility'
import { Clock } from 'lucide-react'
import { useT } from '@/i18n'
import type { DraftAssistantStep, Message, ToolCall } from '@/agent/message-types'
import type { FileMentionItem } from './FileMentionExtension'
import { VIRTUALIZATION_THRESHOLD } from '@/components/agent/virtualization-constants'

/**
 * Async window sizing of the Virtuoso scroller (px).
 */
const SCROLL_DECCELERATION = 700

/**
 * Skip placeholder churn during very fast scroolling: turn bubbles are
 * expensive to remount, so only engage scroll-seek above this velocity.
 */
const SCROLL_SEEK_VELOCITY = 800

/** Extra rendered runway (px) on both sides of the visible window. */
const INCREASE_VIEWPORT_BY = 900

/**
 * Bounded verification loop for the post-send jump (see the send-follow
 * effect). Each tick re-checks the scroller's real bottom gap and re-jumps
 * if Virtuoso's internal total height was still stale when the previous
 * scrollTo was clamped.
 */
const SEND_JUMP_VERIFY_INTERVAL_MS = 150

/**
 * How long the pinning loop keeps waiting for the next run in the queue after
 * the current run ends. A queued run starts within a fraction of a second and
 * grows its reply in place exactly like a normal one, so the loop must survive
 * the idle hand-off window instead of stopping at the first `isProcessing`
 * false tick.
 */
const QUEUE_HANDOFF_WAIT_MS = 10_000

/**
 * Upper bound for the mount-time bottom pin (see the initial-pin effect below).
 * Generous enough to outlast late layout growth (fonts, code highlighting,
 * mermaid/KaTeX, image decode), but never traps the scroller indefinitely.
 */
const INITIAL_PIN_MAX_WAIT_MS = 4000

/**
 * Keys that scroll the conversation without producing a wheel event. Pressed
 * while the load-follow pin is running they mean "the user is browsing
 * history", the same takeover a wheel signals. Keys pressed inside an input
 * are excluded at the handler.
 */
const SCROLL_INTENT_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '])

/**
 * How the virtualized renderer receives footer content (draft bubble + queued
 * messages): via Virtuoso's `context` prop, NOT a module-level slot.
 *
 * react-virtuoso memoizes its Footer slot wrapper and gives it no props, so it
 * only re-renders when one of its subscribed stream values changes. The
 * `context` stream is one of them — each parent render publishes a fresh
 * footer node through `context`, and the slot re-renders reactively. A plain
 * module variable read at render time stays frozen until an unrelated list
 * change happens to re-render the slot (this is exactly the bug where queued
 * messages and the streaming draft bubble stopped appearing on long
 * conversations).
 *
 * The Footer component's identity stays module-stable, which is what the
 * `components` object requires; only the CONTENT flows reactively.
 */

type TurnCtx = {
  /** Committed tool results only — runtime (in-flight) results live in `streaming`. */
  toolResults: Map<string, string>
  isProcessing: boolean
  totalTurns: number
  /** Set once per run when the iteration limit is hit; shown on the last turn AFTER the run ends. */
  iterationLimitReached: number | null
  conversationId?: string | null
  onPreviewAsset?: (name: string, blob: Blob) => void
}

type TurnStreamingCtx = {
  /** Merged tool results (committed + runtime) for the in-flight turn. */
  toolResults: Map<string, string>
  runtimeProps: ReturnType<typeof getRuntimeProps>
  streamingContent: { reasoning: string; content: string } | undefined
  iterationLimitReached: number | null
}

type TurnRendererProps = {
  turn: Turn
  turnIndex: number
  /**
   * Stable context shared by EVERY turn. Its reference only changes at
   * commit/process boundaries — never per streaming token — so `memo` on
   * TurnRenderer keeps committed turns from re-rendering while streaming.
   */
  ctx: TurnCtx
  /**
   * Streaming context, passed ONLY to the in-flight (last) turn while an agent
   * run is active. `undefined` (a stable reference) for every other turn.
   */
  streaming?: TurnStreamingCtx
  onDeleteAgentLoop: (messageId: string) => void
  onEditAndResend: (userMessageId: string, newContent: string) => void
  onRegenerate: ((userMessageId: string) => void) | undefined
  onCancel: () => void
  mentionAgents: { id: string; name?: string }[]
  onSearchFiles?: (query: string) => Promise<FileMentionItem[]>
}

/**
 * Render a single message turn (user bubble or assistant turn).
 * Shared by the plain renderer and the virtualized renderer so both stay
 * visually and behaviorally identical.
 */
const TurnRenderer = memo(function TurnRenderer({
  turn,
  turnIndex,
  ctx,
  streaming,
  onDeleteAgentLoop,
  onEditAndResend,
  onRegenerate,
  onCancel,
  mentionAgents,
  onSearchFiles,
}: TurnRendererProps) {
  const isLast = ctx.isProcessing && turnIndex === ctx.totalTurns - 1
  // Only the in-flight turn consumes streaming props; AssistantTurnBubble's
  // buildTimeline early-returns committed messages when isProcessing is false,
  // so `undefined` is equivalent for every other turn — and keeps this memo
  // from breaking on every token.
  const rp = streaming?.runtimeProps
  return turn.type === 'user' ? (
    <div data-turn-index={turnIndex}>
      <MessageBubble
        message={turn.message}
        conversationId={ctx.conversationId ?? undefined}
        onDeleteAgentLoop={onDeleteAgentLoop}
        onEditAndResend={onEditAndResend}
        onRegenerate={onRegenerate}
        onCancel={onCancel}
        disableDeleteActions={ctx.isProcessing}
        isProcessing={ctx.isProcessing}
        mentionAgents={mentionAgents}
        onSearchFiles={onSearchFiles}
        onPreviewAsset={ctx.onPreviewAsset}
      />
    </div>
  ) : (
    <AssistantTurnBubble
      turn={turn}
      toolResults={isLast && streaming ? streaming.toolResults : ctx.toolResults}
      isProcessing={isLast}
      // Waiting indicator only makes sense on the in-flight (last) turn.
      // runtimeProps are built globally (active=true) for streaming data, so
      // without this gate EVERY committed assistant turn would also render
      // the three-dot waiting bubble while the agent waits for the model.
      isWaiting={isLast ? (rp?.isWaiting ?? false) : false}
      streamingState={isLast ? rp?.streamingState : undefined}
      streamingContent={isLast ? streaming?.streamingContent : undefined}
      currentToolCall={isLast ? rp?.currentToolCall : undefined}
      streamingToolArgs={isLast ? rp?.streamingToolArgs : undefined}
      streamingToolArgsByCallId={isLast ? rp?.streamingToolArgsByCallId : undefined}
      runtimeToolCalls={isLast ? rp?.runtimeToolCalls : undefined}
      runtimeSteps={isLast ? rp?.runtimeSteps : undefined}
      conversationId={ctx.conversationId}
      onPreviewAsset={ctx.onPreviewAsset}
      iterationLimitReached={turnIndex === ctx.totalTurns - 1 ? ctx.iterationLimitReached : null}
    />
  )
})

/** Footer (draft bubble + queued messages) — shared by both render paths. */
type ConversationFooterProps = {
  shouldRenderDraftAssistant: boolean
  draftRuntimeProps: ReturnType<typeof getRuntimeProps>
  toolResults: Map<string, string>
  conversationId?: string | null
  isProcessing: boolean
  queuedMessages: { text: string; assets?: unknown[]; enqueuedAt: number }[]
  mentionAgents: { id: string; name?: string }[]
  onSearchFiles?: (query: string) => Promise<FileMentionItem[]>
  /** Open the shared FilePreview drawer with a pre-loaded blob (queued attachments) */
  onPreviewAsset?: (name: string, blob: Blob) => void
  messagesEndRef: React.RefObject<HTMLDivElement>
  t: ReturnType<typeof useT>
}

function ConversationFooterInner({
  shouldRenderDraftAssistant,
  draftRuntimeProps,
  toolResults,
  conversationId,
  isProcessing,
  queuedMessages,
  mentionAgents,
  onSearchFiles,
  onPreviewAsset,
  messagesEndRef,
  t,
}: ConversationFooterProps) {
  return (
    <>
      {/* Draft assistant turn */}
      {shouldRenderDraftAssistant && (
        <AssistantTurnBubble
          key="draft-assistant"
          turn={{ type: 'assistant', messages: [], timestamp: Date.now(), totalUsage: null }}
          toolResults={toolResults}
          showAvatar
          isProcessing={true}
          conversationId={conversationId}
          {...draftRuntimeProps}
        />
      )}

      {/* Queued messages — shown while agent is processing */}
      {isProcessing && queuedMessages.length > 0 && (
        <div className="space-y-2">
          {/* Queue divider */}
          <div className="flex items-center gap-2 text-xs text-primary-500 dark:text-primary-400">
            <Clock className="h-3 w-3 shrink-0" />
            <span>{t('conversation.queue.divider', { count: queuedMessages.length })}</span>
            <div className="h-px flex-1 bg-primary-200 dark:bg-primary-800" />
          </div>
          {/* Queued message cards — the card owns a pending prompt's actions */}
          {queuedMessages.map((msg, idx) => (
            <QueuedMessageCard
              key={`queued-${idx}-${msg.enqueuedAt}`}
              conversationId={conversationId ?? ''}
              index={idx}
              total={queuedMessages.length}
              text={msg.text}
              assets={msg.assets as never}
              mentionAgents={mentionAgents}
              onSearchFiles={onSearchFiles}
              onPreviewAsset={onPreviewAsset}
              onUpdate={(i, patch) => {
                if (conversationId) {
                  useConversationRuntimeStore.getState().updateQueuedMessage(conversationId, i, patch)
                }
              }}
              onRemove={(i) => {
                if (conversationId) {
                  useConversationRuntimeStore.getState().removeQueuedMessage(conversationId, i)
                }
              }}
              onMoveUp={(i) => {
                if (conversationId) {
                  useConversationRuntimeStore.getState().moveQueuedMessage(conversationId, i, i - 1)
                }
              }}
              onMoveDown={(i) => {
                if (conversationId) {
                  useConversationRuntimeStore.getState().moveQueuedMessage(conversationId, i, i + 1)
                }
              }}
            />
          ))}
        </div>
      )}

      <div ref={messagesEndRef} />
    </>
  )
}

const ConversationFooter = memo(ConversationFooterInner)

type ConversationMessagesProps = {
  activeMessages: Message[]
  /** Incremented when a user send is committed or queued. */
  sendScrollRequest?: number
  /** Tool results from committed messages only (not runtime) */
  toolResults: Map<string, string>
  isProcessing: boolean
  status: string
  onDeleteAgentLoop: (messageId: string) => void
  onEditAndResend: (userMessageId: string, newContent: string) => void
  onRegenerate: ((userMessageId: string) => void) | undefined
  onCancel: () => void
  messagesEndRef: React.RefObject<HTMLDivElement>
  /** Shared ref tracking whether the user is scrolled to the bottom (seed for virtualized followOutput) */
  isUserAtBottomRef?: React.MutableRefObject<boolean>
  /** Conversation ID for bridging ask_user_question UI back to executor */
  conversationId?: string | null
  /** Agent candidates for @ mention in edit mode */
  mentionAgents: { id: string; name?: string }[]
  /** Async file search callback for # file mention in edit mode */
  onSearchFiles?: (query: string) => Promise<FileMentionItem[]>
  /** Open the shared FilePreview drawer with a pre-loaded blob */
  onPreviewAsset?: (name: string, blob: Blob) => void
  /**
   * Issue #141: registry of Virtuoso at-bottom listeners. When provided, every
   * `atBottomStateChange` is fanned out to the registered listeners (the
   * scroll-to-bottom button subscribes through ConversationView) so the
   * button's visibility tracks Virtuoso instead of native DOM geometry.
   */
  virtualAtBottomHub?: VirtualAtBottomHub | null
}

export interface ConversationMessagesHandle {
  getUserNavItems: () => Array<{ turnIndex: number; preview: string; number: number }>
  scrollToTurnIndex: (index: number, align?: 'start' | 'center' | 'end') => void
  /**
   * Issue #141: jump to the latest turn. Virtualized mode routes through
   * Virtuoso's scrollTo (top: Number.MAX_SAFE_INTEGER), which clamps against
   * the scroller's real scrollHeight — footer content included — and works
   * under windowed rendering, where scrollToIndex({ index: 'LAST' }) would
   * align to the last DATA turn and leave footer content below the viewport;
   * plain mode scrolls the native container.
   */
  scrollToLastTurn: (behavior?: 'smooth' | 'auto') => void
  /**
   * Issue #141 (review round 2): explicit at-bottom notification for the
   * scroll-to-bottom button's virtual-mode click. Routes through the same
   * funnel as atBottomStateChange so the button's optimistic hide also
   * re-enables the list's followOutput state (a bare ref write does not).
   * Reserved for CONFIRMED at-bottom values — Virtuoso-verdict resyncs.
   */
  notifyVirtualAtBottom: (atBottom: boolean) => void
  /**
   * PR #142 review round 5 (Sourcery, Medium): followOutput-only preview for
   * the jump START. Writes the shared ref and the list's followOutput state
   * so the next appended turn is followed immediately (responsiveness), but
   * deliberately does NOT touch the hub or its listeners: the hub keeps the
   * last Virtuoso-CONFIRMED position until atBottomStateChange(true) reports
   * the landing. A jump that stops short or a mid-jump virtualized↔plain
   * switch therefore replays not-at-bottom (button re-shows, followOutput
   * off) instead of the never-confirmed optimistic value.
   */
  previewVirtualAtBottom: (atBottom: boolean) => void
}

/** Build runtime props for an AssistantTurnBubble. Returns undefined values when not active. */
function getRuntimeProps(
  active: boolean,
  isWaiting: boolean,
  draftAssistant: {
    toolCalls: ToolCall[]
    steps: DraftAssistantStep[]
    toolResults: Record<string, string>
    reasoning: string
    content: string
  } | null,
  streamingState: {
    currentToolCall: ToolCall | null
    streamingToolArgs: string
    streamingToolArgsByCallId: Record<string, string>
    activeToolCalls: ToolCall[]
  } | null,
  streamingStateDerived: { reasoning: boolean; content: boolean } | undefined,
  streamingContent: { reasoning: string; content: string } | undefined,
  status: string,
) {
  return {
    isWaiting: active ? isWaiting : false,
    streamingState: active ? streamingStateDerived : undefined,
    streamingContent: active ? streamingContent : undefined,
    currentToolCall: active && status === 'tool_calling' ? streamingState?.currentToolCall : undefined,
    streamingToolArgs: active && status === 'tool_calling' ? streamingState?.streamingToolArgs : undefined,
    streamingToolArgsByCallId: active ? streamingState?.streamingToolArgsByCallId : undefined,
    runtimeToolCalls: active ? draftAssistant?.toolCalls : undefined,
    runtimeSteps: active ? draftAssistant?.steps : undefined,
  }
}

export const ConversationMessages = memo(forwardRef(function ConversationMessages({
  activeMessages,
  sendScrollRequest,
  toolResults: committedToolResults,
  isProcessing,
  status,
  onDeleteAgentLoop,
  onEditAndResend,
  onRegenerate,
  onCancel,
  messagesEndRef,
  isUserAtBottomRef,
  conversationId,
  mentionAgents,
  onSearchFiles,
  onPreviewAsset,
  virtualAtBottomHub,
}: ConversationMessagesProps, ref: React.Ref<ConversationMessagesHandle | null>) {
  const t = useT()

  // ── Issue #141: publish Virtuoso's at-bottom state to subscribers ──
  // ConversationView passes the listener hub; handleVirtualAtBottomChange
  // (below) invokes its listeners on every `atBottomStateChange` so
  // ScrollToBottomButton's visibility follows Virtuoso — native scrollHeight
  // geometry is meaningless under windowed rendering.

  // ── Subscribe to streaming data directly from runtime store ──
  // This component is the ONLY place that reads streaming data at high frequency.
  // Parent components do NOT receive these props and will NOT re-render on tokens.
  const streamingData = useConversationRuntimeStore(
    useShallow((s) => {
      if (!conversationId) return null
      const rt = s.runtimes.get(conversationId)
      if (!rt) return null
      return {
        draftAssistant: rt.draftAssistant,
        streamingContent: rt.streamingContent,
        streamingReasoning: rt.streamingReasoning,
        isReasoningStreaming: rt.isReasoningStreaming,
        isContentStreaming: rt.isContentStreaming,
        currentToolCall: rt.currentToolCall,
        activeToolCalls: rt.activeToolCalls || [],
        streamingToolArgs: rt.streamingToolArgs,
        streamingToolArgsByCallId: rt.streamingToolArgsByCallId || {},
        iterationLimitReached: rt.iterationLimitReached ?? null,
      }
    }),
  )

  // Derive the same shapes that used to come from props
  const activeDraftAssistant = streamingData ? {
    toolCalls: streamingData.draftAssistant?.toolCalls || [],
    steps: streamingData.draftAssistant?.steps || [],
    toolResults: streamingData.draftAssistant?.toolResults || {},
    reasoning: streamingData.draftAssistant?.reasoning || '',
    content: streamingData.draftAssistant?.content || '',
  } : null

  const activeStreamingState = streamingData ? {
    currentToolCall: streamingData.currentToolCall,
    streamingToolArgs: streamingData.streamingToolArgs,
    streamingToolArgsByCallId: streamingData.streamingToolArgsByCallId,
    activeToolCalls: streamingData.activeToolCalls,
  } : null

  const isWaitingForModel =
    status === 'pending' ||
    (status === 'tool_calling' &&
      !activeStreamingState?.currentToolCall &&
      (activeStreamingState?.activeToolCalls?.length || 0) === 0)

  // ── Merge tool results: committed + runtime ──
  // This MUST be subscribed here (not in parent) because runtime toolResults
  // change at high frequency during multi-tool agent loops.
  const toolResults = useMemo(() => {
    const merged = new Map(committedToolResults)
    const runtimeResults = activeDraftAssistant?.toolResults || {}
    for (const [toolCallId, result] of Object.entries(runtimeResults)) {
      if (!merged.has(toolCallId)) merged.set(toolCallId, result)
    }
    return merged
  }, [committedToolResults, activeDraftAssistant?.toolResults])

  const streamingState = useMemo(
    () =>
      !streamingData || !isProcessing
        ? undefined
        : {
            reasoning: streamingData.isReasoningStreaming,
            content: streamingData.isContentStreaming,
          },
    [streamingData?.isReasoningStreaming, streamingData?.isContentStreaming, isProcessing],
  )

  const streamingContentMessage = useMemo(() => {
    if (!streamingData || !streamingData.draftAssistant || !isProcessing) return undefined
    const reasoning = streamingData.draftAssistant.reasoning || streamingData.streamingReasoning
    const content = streamingData.draftAssistant.content || streamingData.streamingContent
    if (!reasoning && !content) return undefined
    let lastAssistant: Message | undefined
    // Reverse scan WITHOUT copying the array — this memo recomputes on every
    // streaming token, so an O(N) spread+reverse here is per-token work.
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      if (activeMessages[i].role === 'assistant') {
        lastAssistant = activeMessages[i]
        break
      }
    }
    if (
      lastAssistant &&
      (lastAssistant.reasoning || '') === (reasoning || '') &&
      (lastAssistant.content || '') === (content || '')
    ) return undefined
    return { reasoning, content }
  }, [
    streamingData?.streamingReasoning,
    streamingData?.streamingContent,
    streamingData?.draftAssistant?.reasoning,
    streamingData?.draftAssistant?.content,
    activeMessages,
    isProcessing,
  ])

  // ── Queued messages (visible while agent is processing) ──
  const queuedMessages = useConversationRuntimeStore(
    useShallow((s) => {
      if (!conversationId) return []
      return s.pendingMessageQueues.get(conversationId) ?? []
    }),
  )
  // An app-tool prompt is persisted into the transcript at enqueue time, so
  // rendering its bubble next to the queue card shows the same prompt twice.
  // The CARD is the surface that stays: it carries the queue-specific
  // edit/remove/move actions, while the bubble's own edit/delete actions are
  // disabled during a run. Entries without a persisted record (UI sends) are
  // memory-only and own no transcript bubble. Cards render only while a run is
  // processing, so the bubble must come back otherwise (idle / errored run).
  const turns = useMemo(
    () => groupMessagesIntoTurns(visibleTranscriptMessages(activeMessages, queuedMessages, isProcessing)),
    [activeMessages, queuedMessages, isProcessing],
  )
  const lastTurn = turns[turns.length - 1]

  // ── Virtualization (only above VIRTUALIZATION_THRESHOLD messages) ──
  const shouldVirtualize = activeMessages.length > VIRTUALIZATION_THRESHOLD
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null)
  // Virtuoso's own at-bottom tracking (drives followOutput). Seeded from the
  // shared isUserAtBottomRef maintained by ConversationView/ScrollToBottomButton
  // so the very first streaming turn respects the current scroll position.
  // Keep Virtuoso's measured bottom as the single source of truth for the
  // virtualized path; outer vertical padding would offset its measurements.
  const [isUserAtBottom, setIsUserAtBottom] = useState(() => isUserAtBottomRef?.current ?? true)
  /**
   * Single funnel for every virtualized at-bottom transition:
   * - writes the shared isUserAtBottomRef (the cross-component seed),
   * - records the value on the hub so late subscriber effects can replay it,
   * - pushes the value to registered listeners (ScrollToBottomButton's
   *   visibility), so the button can never disagree with Virtuoso.
   * `setIsUserAtBottom` stays as state writer so followOutput re-reads a
   * fresh value per data append.
   */
  const handleVirtualAtBottomChange = useCallback<VirtualAtBottomListener>((atBottom: boolean) => {
    if (isUserAtBottomRef) isUserAtBottomRef.current = atBottom
    setIsUserAtBottom(atBottom)
    if (virtualAtBottomHub) virtualAtBottomHub.lastAtBottom = atBottom
    for (const listener of virtualAtBottomHub?.listeners ?? []) {
      listener(atBottom)
    }
  }, [isUserAtBottomRef, virtualAtBottomHub])
  const rootRef = useRef<HTMLDivElement | null>(null)
  // Resolve the scroll parent synchronously during the layout phase, BEFORE the
  // browser paints. Virtuoso mounts on the very first commit for large
  // conversations — the plain renderer must never paint a full (expensive) list
  // frame just to resolve the container. (useEffect would paint one full frame
  // first; that frame is precisely the jank we are virtualizing away.)
  useLayoutEffect(() => {
    if (!shouldVirtualize || scrollParent) return
    // The scroll container lives in ConversationView. Resolve it lazily from
    // our own position in the DOM (nearest overflow-y-auto ancestor) so this
    // component has no coupling to how the parent lays out.
    const el = rootRef.current
    if (!el) return
    const parent = el.closest('[class*="overflow-y-auto"]') as HTMLElement | null
    if (parent) setScrollParent(parent)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot resolution; scrollParent intentionally omitted
  }, [shouldVirtualize, conversationId])
  const virtuosoRef = useRef<VirtuosoHandle | null>(null)

  // The send jump is DELAYED until the runtime picks the send up (loading
  // draft bubble / queued card rendered in the footer) and VERIFIED against
  // real scroller geometry afterwards. Jumping once at commit time lands on a
  // geometry that is stale by one render: the footer's loading bubble mounts
  // but Virtuoso's ResizeObserver measurement of it lands asynchronously, so
  // scrollTo(MAX) is clamped against the OLD total height — leaving a ~32px
  // gap that Virtuoso then reports as not-at-bottom, killing followOutput
  // (observed live: gap stayed 32 with no scroll events). The verify loop
  // re-jumps until the browser-measured gap is settled; it aborts on any user
  // scroll intent so a manual scroll-away always wins.
  const handledSendScrollRef = useRef(0)
  const stopSendVerifyRef = useRef<(() => void) | null>(null)
  const isProcessingRef = useRef(isProcessing)
  useEffect(() => {
    isProcessingRef.current = isProcessing
  }, [isProcessing])
  // Queue length is read from inside the interval callback, which cannot
  // depend on render state without re-arming the loop on every enqueue.
  const queuedCountRef = useRef(queuedMessages.length)
  useEffect(() => {
    queuedCountRef.current = queuedMessages.length
  }, [queuedMessages.length])
  // Explicit re-arms (the scroll-to-bottom button during a run). A counter, not
  // a boolean: every click must restart the loop, not just the first one.
  const [pinRearmRequest, setPinRearmRequest] = useState(0)
  const handledPinRearmRef = useRef(0)
  // Unmount safety: read the stopper through the ref at unmount time (it may
  // have been installed long after this effect ran).
  useEffect(() => () => stopSendVerifyRef.current?.(), [])
  useLayoutEffect(() => {
    const fromSend = !!sendScrollRequest && sendScrollRequest !== handledSendScrollRef.current
    const fromExplicitRearm = pinRearmRequest !== handledPinRearmRef.current
    if (!fromSend && !fromExplicitRearm) return
    if (!isProcessing || !shouldVirtualize || !scrollParent) return
    if (fromSend) handledSendScrollRef.current = sendScrollRequest ?? 0
    handledPinRearmRef.current = pinRearmRequest
    // A previous send's verify loop may still be alive (its deadline not yet
    // reached): stop it so two loops never drive the scroller at once.
    stopSendVerifyRef.current?.()
    if (isUserAtBottomRef) isUserAtBottomRef.current = true
    setIsUserAtBottom(true)
    const jump = () => virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' })
    jump()
    // Two live-observed failure modes, one guard loop:
    // 1. The first scrollTo is clamped against a stale total height (the
    //    footer bubble's ResizeObserver measurement lands a frame later),
    //    leaving a ~32px gap that reads as not-at-bottom.
    // 2. Streaming grows the LAST ITEM in place — followOutput never fires
    //    (it only reacts to items being added), so the reply's growth reopens
    //    the gap and Virtuoso kills follow for the rest of the run.
    // So after a send we keep pinning to the true bottom for the whole run.
    // It yields to wheel/vertical touch gestures and to any upward scroll
    // (scrollbar drag, PgUp) — manual scroll-away always wins. Tapping the
    // composer deliberately does NOT abort it: a tap is not a scroll gesture,
    // and queued sends must keep following.
    let cancelled = false
    // Baseline the position BEFORE the first jump, so an upward scroll that
    // lands before the first tick still reads as user movement.
    let lastTop = scrollParent.scrollTop
    let lastProcessingAt = Date.now()
    let timer = 0
    const stop = () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('wheel', abort, true)
      window.removeEventListener('touchmove', abort, true)
      if (stopSendVerifyRef.current === stop) stopSendVerifyRef.current = null
    }
    // An aborted loop must release its timer and global listeners too —
    // otherwise they keep waking every interval until the next send/unmount.
    const abort = () => stop()
    timer = window.setInterval(() => {
      if (cancelled) return
      // Any upward movement we did not cause is the user taking over.
      if (scrollParent.scrollTop < lastTop - 4) { stop(); return }
      const gap = scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight
      if (gap <= 1) {
        if (!isProcessingRef.current) stop()
        return
      }
      // Run over but not settled: stop chasing, the user may be reading —
      // unless a queued run is about to take over, which grows its reply in
      // place and needs the very same pinning.
      if (!isProcessingRef.current) {
        if (queuedCountRef.current > 0 && Date.now() - lastProcessingAt < QUEUE_HANDOFF_WAIT_MS) return
        stop()
        return
      }
      lastProcessingAt = Date.now()
      jump()
      lastTop = scrollParent.scrollTop
      if (isUserAtBottomRef) isUserAtBottomRef.current = true
      setIsUserAtBottom(true)
    }, SEND_JUMP_VERIFY_INTERVAL_MS)
    stopSendVerifyRef.current = stop
    window.addEventListener('wheel', abort, { capture: true, passive: true })
    window.addEventListener('touchmove', abort, { capture: true, passive: true })
  }, [sendScrollRequest, pinRearmRequest, isProcessing, shouldVirtualize, scrollParent, isUserAtBottomRef])

  // ── Load-follow bottom pin on mount (virtualized conversations) ──
  // `initialTopMostItemIndex` aligns the LAST turn's TOP with the viewport
  // top, so a conversation whose latest turn is taller than the viewport
  // (long reply, tool cards) opens ABOVE the real bottom — Virtuoso then
  // reports not-at-bottom and followOutput never engages for the next run.
  // The plain renderer needs no help here: useConversationLogic's append
  // effect already scrolls on the DB-load 0→N transition and settles
  // against late height growth.
  // The pin is a WINDOW, not a one-shot: very large conversations deliver
  // their turns in several batches, and each batch re-opens the gap after
  // the previous pin finished (observed live: a 60k-px conversation arrived
  // in waves and stranded the view 28k px above the bottom). The window
  // restarts on every turn-count growth and retires once loading has been
  // quiet for INITIAL_PIN_MAX_WAIT_MS with the view at the true bottom.
  // Explicit input INSIDE the conversation — wheel, vertical touch, a
  // scrollbar drag or a scroll key — stops the window for good; Virtuoso's
  // own position corrections produce no input events and must not be mistaken
  // for user scrolling. The button takes over from there. While a run is
  // already streaming when the conversation mounts, defer to the send guard
  // loop instead: it has no deadline, handles in-place growth and queue
  // hand-off, and jumps Virtuoso-safely.
  const initialPinStopRef = useRef<(() => void) | null>(null)
  const pinAbortedRef = useRef(false)
  const followTurnsCountRef = useRef<number | null>(null)
  // User-intent takeover, scoped to THIS conversation's scroller and kept
  // alive for the whole mount. Scoping matters in both directions: wheeling
  // the sidebar is not browsing intent and must not cancel the pin, while a
  // scrollbar drag or a scroll key is. The flag outlives the pin window on
  // purpose — a later batch must not restart the pin for a user who already
  // scrolled away.
  useEffect(() => {
    if (!scrollParent) return
    const abortPin = () => {
      pinAbortedRef.current = true
      initialPinStopRef.current?.()
    }
    const onGesture = (event: Event) => {
      if (!scrollParent.contains(event.target as Node | null)) return
      abortPin()
    }
    const onPointerDown = (event: Event) => {
      // A scrollbar drag targets the scrolling element itself; clicking a
      // message is not browsing intent.
      if (event.target !== scrollParent) return
      abortPin()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!SCROLL_INTENT_KEYS.has(event.key)) return
      const target = event.target as HTMLElement | null
      // Typing (or moving the caret) in the composer is not browsing.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      abortPin()
    }
    scrollParent.addEventListener('wheel', onGesture, { capture: true, passive: true })
    scrollParent.addEventListener('touchmove', onGesture, { capture: true, passive: true })
    scrollParent.addEventListener('pointerdown', onPointerDown, { capture: true })
    window.addEventListener('keydown', onKeyDown)
    return () => {
      scrollParent.removeEventListener('wheel', onGesture, true)
      scrollParent.removeEventListener('touchmove', onGesture, true)
      scrollParent.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [scrollParent])
  useEffect(() => {
    if (!shouldVirtualize) {
      // Leaving virtualization (threshold drop, deletions) drops the recorded
      // batch count: re-entering is a fresh load, not a resume that would
      // compare against a stale, larger count and skip the pin entirely.
      followTurnsCountRef.current = null
      return
    }
    if (!scrollParent) return
    if (followTurnsCountRef.current !== null) {
      // Resume ONLY for a fresh batch of turns. A user takeover is terminal;
      // re-evaluations without growth are no-ops. If a run started (guard
      // loop owns the scroller), never fight it.
      if (pinAbortedRef.current) return
      if (turns.length <= followTurnsCountRef.current) return
      if (isProcessingRef.current) {
        followTurnsCountRef.current = turns.length
        return
      }
    } else if (isProcessingRef.current) {
      // A run is already streaming on first evaluation: arm the send guard
      // loop (unless it is already alive) and step aside — two loops must
      // never drive the scroller at once, and the loop below would hit its
      // deadline mid-stream.
      if (!stopSendVerifyRef.current) {
        setPinRearmRequest((request) => request + 1)
      }
      followTurnsCountRef.current = turns.length
      return
    }
    // NOTE: deliberately NO at-bottom seed check. WorkspaceLayout remounts
    // this component per conversation (key={convId}), so isUserAtBottomRef
    // is always freshly seeded true; a false value here can only be
    // Virtuoso's first misaligned verdict after initialTopMostItemIndex
    // (observed live: the false lands before this effect evaluates and
    // permanently suppressed the pin) — exactly the state this loop
    // corrects.
    followTurnsCountRef.current = turns.length
    const jump = () => {
      // Same Virtuoso scrollTo(MAX) primitive as the button (issue #141),
      // but invoked during mount rather than after a user click. Virtuoso may
      // reposition the list after this jump while initial layout settles.
      if (virtuosoRef.current) {
        virtuosoRef.current.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'auto' })
      } else {
        scrollParent.scrollTop = scrollParent.scrollHeight
      }
    }
    let cancelled = false
    let lastHeight = -1
    let lastChangeAt = Date.now()
    const stop = () => {
      cancelled = true
      if (initialPinStopRef.current === stop) initialPinStopRef.current = null
    }
    const tick = () => {
      if (cancelled) return
      // Explicit user intent landed since the last frame — stop BEFORE the
      // next jump instead of pulling the view back under them.
      if (pinAbortedRef.current) { stop(); return }
      // The send guard loop took over (user sent mid-window) — it owns the
      // scroller now; two loops must never drive it at once.
      if (stopSendVerifyRef.current) { stop(); return }
      const now = Date.now()
      const grew = scrollParent.scrollHeight !== lastHeight
      if (grew) {
        lastHeight = scrollParent.scrollHeight
        lastChangeAt = now
      } else if (now - lastChangeAt > INITIAL_PIN_MAX_WAIT_MS) {
        // Height has been quiet for the whole grace period: loading is
        // done — hand control back to Virtuoso/the user. Do not exit just
        // because a jump landed: initial layout can reposition it afterwards.
        stop()
        return
      }
      // Virtuoso can programmatically correct the position *upward* after
      // our jump (observed live: 60926 → 60460 with unchanged height).
      // Geometry alone cannot distinguish that from a user scroll. Only
      // explicit input events abort the load-follow window.
      const gap = scrollParent.scrollHeight - scrollParent.scrollTop - scrollParent.clientHeight
      if (gap > 1) {
        jump()
        // Same re-seed the send guard loop does every tick: Virtuoso may
        // broadcast not-at-bottom mid-flight (its measurement lags the jump);
        // keep followOutput armed so the next appended turn is followed as
        // soon as we land.
        if (isUserAtBottomRef) isUserAtBottomRef.current = true
        setIsUserAtBottom(true)
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    initialPinStopRef.current = stop
    return stop
  }, [shouldVirtualize, scrollParent, turns.length, isUserAtBottomRef])

  // ── Expose navigation handle to parent ──
  useImperativeHandle(ref, useCallback(() => ({
    getUserNavItems: () => {
      const items: Array<{ turnIndex: number; preview: string; number: number }> = []
      let num = 0
      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i]
        if (turn.type === 'user') {
          num++
          const content = turn.message.content || ''
          items.push({
            turnIndex: i,
            preview: content.length > 36 ? content.slice(0, 36) + '…' : content,
            number: num,
          })
        }
      }
      return items
    },
    scrollToTurnIndex: (index: number, align: 'start' | 'center' | 'end' = 'start') => {
      // Virtualized path: off-window turns are not in the DOM, so delegate to
      // Virtuoso's scrollToIndex (which routes through the customScrollParent).
      if (shouldVirtualize && virtuosoRef.current) {
        virtuosoRef.current.scrollToIndex({ index, align: align === 'center' ? 'center' : align === 'end' ? 'end' : 'start' })
        return
      }
      const el = document.querySelector(`[data-turn-index="${index}"]`)
      if (!el) return
      // Find the scroll container (nearest overflow-y-auto ancestor)
      const container = el.closest('[class*="overflow-y-auto"]') as HTMLElement | null
      if (container) {
        const targetTop = (el as HTMLElement).offsetTop
        container.scrollTo({ top: targetTop, behavior: 'smooth' })
      }
    },
    // Issue #141 (review round 2): "go to latest" must land on the true
    // bottom of the scroller, which INCLUDES the Virtuoso footer (draft
    // bubble / queued messages). scrollToIndex({ index: 'LAST', align: 'end'
    // }) aligns to the last DATA turn and leaves footer content below the
    // viewport. VirtuosoHandle has no scrollToEnd, but scrollTo clamps top
    // against the scroller's real scrollHeight (footer included) — even with
    // a customScrollParent, whose offset it compensates for.
    scrollToLastTurn: (behavior: 'smooth' | 'auto' = 'smooth') => {
      if (shouldVirtualize && virtuosoRef.current) {
        virtuosoRef.current.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior })
        // An explicit return to the bottom DURING a run must resume the pinning
        // loop: an earlier scroll-away aborted it, and followOutput never reacts
        // to in-place streaming growth, so the reply would drift away again.
        if (isProcessing) setPinRearmRequest((request) => request + 1)
        return
      }
      // Plain renderer: the scroll container is the nearest overflow-y-auto
      // ancestor of our own root (same resolution rule as the layout effect).
      const container = rootRef.current?.closest('[class*="overflow-y-auto"]') as HTMLElement | null
      if (container) {
        container.scrollTo({ top: container.scrollHeight, behavior })
      }
    },
    // Issue #141 (review round 2): the button's click must re-enable
    // followOutput, which reads this component's `isUserAtBottom` STATE —
    // not just the shared ref. notifyVirtualAtBottom routes through the
    // single funnel so ref, state, hub replay value and listeners all
    // update together; it is reserved for CONFIRMED at-bottom values
    // (Virtuoso-verdict resyncs). The jump START uses previewVirtualAtBottom
    // instead: it re-enables the follow path WITHOUT writing the optimistic
    // value into the hub (review round 5 — see its doc comment).
    notifyVirtualAtBottom: (atBottom: boolean) => {
      handleVirtualAtBottomChange(atBottom)
    },
    previewVirtualAtBottom: (atBottom: boolean) => {
      if (isUserAtBottomRef) isUserAtBottomRef.current = atBottom
      setIsUserAtBottom(atBottom)
    },
  }), [turns, shouldVirtualize, isProcessing, handleVirtualAtBottomChange]))

  const shouldRenderDraftAssistant = isProcessing && (!lastTurn || lastTurn.type !== 'assistant')
  const shouldAttachRuntimeToDraft = shouldRenderDraftAssistant

  // ── Turn render contexts ──
  // stableCtx is shared by EVERY turn and must never change per streaming
  // token — its reference identity is what keeps TurnRenderer's memo (and
  // everything below it) effective during streaming. Per-token streaming
  // data lives in streamingTurnCtx, which is passed ONLY to the in-flight
  // (last) turn; every other turn receives `undefined`.
  const iterationLimitReached = streamingData?.iterationLimitReached ?? null
  const stableCtx = useMemo<TurnCtx>(() => ({
    toolResults: committedToolResults,
    isProcessing,
    totalTurns: turns.length,
    iterationLimitReached,
    conversationId,
    onPreviewAsset,
  }), [committedToolResults, isProcessing, turns.length, iterationLimitReached, conversationId, onPreviewAsset])

  const streamingTurnCtx = useMemo<TurnStreamingCtx | undefined>(() => {
    if (!isProcessing) return undefined
    return {
      toolResults,
      runtimeProps: getRuntimeProps(
        true, isWaitingForModel, activeDraftAssistant, activeStreamingState,
        streamingState, streamingContentMessage, status,
      ),
      streamingContent: streamingContentMessage,
      iterationLimitReached,
    }
  }, [
    isProcessing, toolResults, isWaitingForModel, activeDraftAssistant,
    activeStreamingState, streamingState, streamingContentMessage,
    iterationLimitReached, status,
  ])

  const sharedTurnProps = {
    onDeleteAgentLoop,
    onEditAndResend,
    onRegenerate,
    onCancel,
    mentionAgents,
    onSearchFiles,
  }

  const draftRuntimeProps = getRuntimeProps(
    shouldAttachRuntimeToDraft, isWaitingForModel, activeDraftAssistant,
    activeStreamingState, streamingState, streamingContentMessage, status,
  )

  const footer = (
    <ConversationFooter
      shouldRenderDraftAssistant={shouldRenderDraftAssistant}
      draftRuntimeProps={draftRuntimeProps}
      toolResults={toolResults}
      conversationId={conversationId}
      isProcessing={isProcessing}
      queuedMessages={queuedMessages}
      mentionAgents={mentionAgents}
      onSearchFiles={onSearchFiles}
      onPreviewAsset={onPreviewAsset}
      messagesEndRef={messagesEndRef}
      t={t}
    />
  )

  // ── Short conversations (or before the scroll parent resolves): plain renderer ──
  // The cumulative usage bar is NOT rendered here anymore: it lives in
  // ConversationView, OUTSIDE the scroll container, so it stays pinned (and is
  // identical for both render paths — sticky-in-flow broke under Virtuoso).
  if (!shouldVirtualize || !scrollParent) {
    const lastTurnIndex = turns.length - 1
    return (
      <div ref={rootRef} className="min-h-0 px-2 py-3 sm:px-4 sm:py-4">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-3 sm:px-0">
          {turns.map((turn, idx) => (
            <TurnRenderer
              key={turn.type === 'user' ? turn.message.id : turn.messages[0].id}
              turn={turn}
              turnIndex={idx}
              ctx={stableCtx}
              streaming={idx === lastTurnIndex ? streamingTurnCtx : undefined}
              {...sharedTurnProps}
            />
          ))}
          {footer}
        </div>
      </div>
    )
  }

  // ── Long conversations: virtualized renderer ──
  const scrollSeekConfiguration = {
    enter: (velocity: number) => Math.abs(velocity) > SCROLL_SEEK_VELOCITY,
    exit: (velocity: number) => Math.abs(velocity) < SCROLL_DECCELERATION,
  }
  const lastTurnIndex = turns.length - 1

  return (
    <div ref={rootRef} className="min-h-0 px-2 sm:px-4">
      <div className="mx-auto w-full max-w-3xl">
        <Virtuoso
          ref={virtuosoRef}
          customScrollParent={scrollParent ?? undefined}
          data={turns}
          context={{ footerNode: footer }}
          computeItemKey={(_index, turn) => (turn.type === 'user' ? turn.message.id : turn.messages[0].id)}
          initialTopMostItemIndex={Math.max(0, turns.length - 1)}
          followOutput={() => (isUserAtBottom ? 'smooth' : false)}
          atBottomStateChange={handleVirtualAtBottomChange}
          increaseViewportBy={INCREASE_VIEWPORT_BY}
          scrollSeekConfiguration={scrollSeekConfiguration}
          components={{
            Header: VirtuosoHeader,
            Footer: VirtuosoFooter,
            ScrollSeekPlaceholder: TurnPlaceholder,
          }}
          itemContent={(index, turn) => (
            <TurnRenderer
              turn={turn}
              turnIndex={index}
              ctx={stableCtx}
              streaming={index === lastTurnIndex ? streamingTurnCtx : undefined}
              {...sharedTurnProps}
            />
          )}
        />
        {/* NOTE: no footer JSX after the list on this path — the draft bubble /
            queued messages / messagesEnd div must live INSIDE Virtuoso's Footer
            slot so the scroller's scrollHeight includes them (followOutput and
            messagesEndRef both depend on that). */}
      </div>
    </div>
  )
}))

/**
 * Renders the draft bubble / queued messages as the Virtuoso list footer.
 * Content arrives through Virtuoso's `context` prop so the memoized Footer
 * slot re-renders whenever ConversationMessages publishes a new footer node.
 */
function VirtuosoHeader() {
  return <div className="h-3 sm:h-4" />
}

function VirtuosoFooter({ context }: { context?: { footerNode: React.ReactNode } }) {
  return <>{context?.footerNode ?? null}<div className="h-3 sm:h-4" /></>
}

/** Lightweight placeholder shown for off-window turns during fast scrolling. */
function TurnPlaceholder({ height }: { height: number }) {
  return <div style={{ height }} className="animate-pulse rounded-xl bg-neutral-100 dark:bg-neutral-800/60" />
}
