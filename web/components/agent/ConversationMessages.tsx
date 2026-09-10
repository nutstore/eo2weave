/**
 * ConversationMessages — renders the list of message turns,
 * draft assistant bubble.
 *
 * Streaming data (draftAssistant, streamingState, streamingContent, toolResults)
 * is subscribed directly from the runtime store inside this component,
 * so that parent components (ConversationView) do NOT re-render on every
 * streaming token (~60fps). Only this component tree re-renders.
 */

import { memo, useMemo, forwardRef, useImperativeHandle, useCallback, useRef, useState, useLayoutEffect } from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { VirtuosoHandle } from 'react-virtuoso'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'
import { useShallow } from 'zustand/react/shallow'
import { MessageBubble } from './MessageBubble'
import { AssistantTurnBubble } from './AssistantTurnBubble'
import { groupMessagesIntoTurns } from './group-messages'
import type { Turn } from './group-messages'
import { QueuedMessageCard } from './QueuedMessageCard'
import { Clock } from 'lucide-react'
import { useT } from '@/i18n'
import type { DraftAssistantStep, Message, ToolCall } from '@/agent/message-types'
import type { FileMentionItem } from './FileMentionExtension'

/**
 * Threshold (in messages) above which the conversation switches to virtualized
 * rendering. Counted in raw messages rather than turns because agent
 * conversations are message-dense (a single user turn can fan out into dozens
 * of tool/assistant messages inside the agent loop).
 */
const VIRTUALIZATION_THRESHOLD = 100

/** Async window sizing of the Virtuoso scroller (px). */
const SCROLL_DECCELERATION = 700

/**
 * Skip placeholder churn during very fast scroolling: turn bubbles are
 * expensive to remount, so only engage scroll-seek above this velocity.
 */
const SCROLL_SEEK_VELOCITY = 800

/** Extra rendered runway (px) on both sides of the visible window. */
const INCREASE_VIEWPORT_BY = 900

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

type TurnRendererProps = {
  turn: Turn
  turnIndex: number
  /** Shared streaming/toolResults context for this render pass. */
  ctx: {
    toolResults: Map<string, string>
    isProcessing: boolean
    status: string
    isWaitingForModel: boolean
    runtimeProps: ReturnType<typeof getRuntimeProps>
    streamingContent: { reasoning: string; content: string } | undefined
    totalTurns: number
    iterationLimitReached: number | null
    conversationId?: string | null
    onPreviewAsset?: (name: string, blob: Blob) => void
  }
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
  onDeleteAgentLoop,
  onEditAndResend,
  onRegenerate,
  onCancel,
  mentionAgents,
  onSearchFiles,
}: TurnRendererProps) {
  const isLast = ctx.isProcessing && turnIndex === ctx.totalTurns - 1
  return turn.type === 'user' ? (
    <div data-turn-index={turnIndex}>
      <MessageBubble
        message={turn.message}
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
      toolResults={ctx.toolResults}
      isProcessing={isLast}
      // Waiting indicator only makes sense on the in-flight (last) turn.
      // runtimeProps are built globally (active=true) for streaming data, so
      // without this gate EVERY committed assistant turn would also render
      // the three-dot waiting bubble while the agent waits for the model.
      isWaiting={isLast ? ctx.runtimeProps.isWaiting : false}
      streamingState={ctx.runtimeProps.streamingState}
      streamingContent={ctx.streamingContent}
      currentToolCall={ctx.runtimeProps.currentToolCall}
      streamingToolArgs={ctx.runtimeProps.streamingToolArgs}
      streamingToolArgsByCallId={ctx.runtimeProps.streamingToolArgsByCallId}
      runtimeToolCalls={ctx.runtimeProps.runtimeToolCalls}
      runtimeSteps={ctx.runtimeProps.runtimeSteps}
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
          {/* Queued message cards */}
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
}

export interface ConversationMessagesHandle {
  getUserNavItems: () => Array<{ turnIndex: number; preview: string; number: number }>
  scrollToTurnIndex: (index: number, align?: 'start' | 'center' | 'end') => void
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
}: ConversationMessagesProps, ref: React.Ref<ConversationMessagesHandle | null>) {
  const t = useT()

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
    const lastAssistant = [...activeMessages].reverse().find((m) => m.role === 'assistant')
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

  const turns = useMemo(() => groupMessagesIntoTurns(activeMessages), [activeMessages])
  const lastTurn = turns[turns.length - 1]

  // ── Virtualization (only above VIRTUALIZATION_THRESHOLD messages) ──
  const shouldVirtualize = activeMessages.length > VIRTUALIZATION_THRESHOLD
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null)
  // Virtuoso's own at-bottom tracking (drives followOutput). Seeded from the
  // shared isUserAtBottomRef maintained by ConversationView/ScrollToBottomButton
  // so the very first streaming turn respects the current scroll position.
  const [isUserAtBottom, setIsUserAtBottom] = useState(() => isUserAtBottomRef?.current ?? true)
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
  }), [turns, shouldVirtualize]))

  const shouldRenderDraftAssistant = isProcessing && (!lastTurn || lastTurn.type !== 'assistant')
  const shouldAttachRuntimeToDraft = shouldRenderDraftAssistant

  // ── Shared per-render context for turn rendering (both paths) ──
  const renderCtx = useMemo(() => ({
    toolResults,
    isProcessing,
    status,
    isWaitingForModel,
    runtimeProps: getRuntimeProps(
      true, isWaitingForModel, activeDraftAssistant, activeStreamingState,
      streamingState, streamingContentMessage, status,
    ),
    streamingContent: streamingContentMessage,
    totalTurns: turns.length,
    iterationLimitReached: streamingData?.iterationLimitReached ?? null,
    conversationId,
    onPreviewAsset,
  }), [
    toolResults, isProcessing, status, isWaitingForModel, activeDraftAssistant,
    activeStreamingState, streamingState, streamingContentMessage, turns.length,
    streamingData?.iterationLimitReached, conversationId, onPreviewAsset,
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
      messagesEndRef={messagesEndRef}
      t={t}
    />
  )

  // ── Short conversations (or before the scroll parent resolves): plain renderer ──
  // The cumulative usage bar is NOT rendered here anymore: it lives in
  // ConversationView, OUTSIDE the scroll container, so it stays pinned (and is
  // identical for both render paths — sticky-in-flow broke under Virtuoso).
  if (!shouldVirtualize || !scrollParent) {
    return (
      <div ref={rootRef} className="min-h-0 px-2 py-3 sm:px-4 sm:py-4">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-3 sm:px-0">
          {turns.map((turn, idx) => (
            <TurnRenderer
              key={turn.type === 'user' ? turn.message.id : turn.messages[0].id}
              turn={turn}
              turnIndex={idx}
              ctx={renderCtx}
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

  return (
    <div className="min-h-0 px-2 py-3 sm:px-4 sm:py-4">
      <div className="mx-auto w-full max-w-3xl">
        <Virtuoso
          ref={virtuosoRef}
          customScrollParent={scrollParent ?? undefined}
          data={turns}
          context={{ footerNode: footer }}
          computeItemKey={(_index, turn) => (turn.type === 'user' ? turn.message.id : turn.messages[0].id)}
          initialTopMostItemIndex={Math.max(0, turns.length - 1)}
          followOutput={() => (isUserAtBottom ? 'smooth' : false)}
          atBottomStateChange={setIsUserAtBottom}
          increaseViewportBy={INCREASE_VIEWPORT_BY}
          scrollSeekConfiguration={scrollSeekConfiguration}
          components={{
            Footer: VirtuosoFooter,
            ScrollSeekPlaceholder: TurnPlaceholder,
          }}
          itemContent={(index, turn) => (
            <TurnRenderer
              turn={turn}
              turnIndex={index}
              ctx={renderCtx}
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
function VirtuosoFooter({ context }: { context?: { footerNode: React.ReactNode } }) {
  return <>{context?.footerNode ?? null}</>
}

/** Lightweight placeholder shown for off-window turns during fast scrolling. */
function TurnPlaceholder({ height }: { height: number }) {
  return <div style={{ height }} className="animate-pulse rounded-xl bg-neutral-100 dark:bg-neutral-800/60" />
}
