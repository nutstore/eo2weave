/**
 * AssistantTurnBubble - renders a grouped agent turn (one avatar, multiple steps, summary footer).
 *
 * Rendering model:
 * ┌─────────────────────────────────────────────┐
 * │  [avatar]  │  Step 1: reasoning (streaming)  │
 * │            │  Step 2: content (committed)     │
 * │            │  Step 3: tool_call (streaming)   │
 * │            │  Step 4: compression (committed) │
 * │            │  Step 5: content (streaming)     │
 * │            │  ─── summary footer ───          │
 * └─────────────────────────────────────────────┘
 *
 * A "step" is either:
 * - A **committed message** (persisted, immutable) from `turn.messages`
 * - A **runtime step** (streaming, mutable) from `draftAssistant.steps`
 *
 * During streaming (isProcessing=true on the last turn):
 *   Committed messages + runtime steps are merged into a single timeline
 *   sorted by timestamp. This allows context_summary, tool calls, and
 *   compression cards to appear in chronological order.
 *
 * When not processing:
 *   Only committed messages are rendered (no runtime steps).
 */

import { Fragment, memo, type ReactNode, useContext, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { projectWorkspacePath } from '@/lib/route-paths'
import { Bot, Database, Split, AlertTriangle, Download } from 'lucide-react'
import type { Turn } from './group-messages'
import type {
  DraftAssistantStep,
  Message,
  ToolCall,
} from '@/agent/message-types'
import { ReasoningSection } from './ReasoningSection'
import { ToolCallDisplay } from './ToolCallDisplay'
import { MarkdownContent } from './MarkdownContent'
import { useStreamingMarkdown } from './use-streaming-markdown'
import { CopyButton } from './CopyButton'
import { ShareButton } from './ShareButton'
import { ContextSummaryCard } from './ContextSummaryCard'
import { RunChangesCard } from './RunChangesCard'
import { TextSelectionToolbar } from './TextSelectionToolbar'
import { AssetCompactList } from './AssetCard'
import { useT } from '@/i18n'
import { useConversationStore } from '@/store/conversation.store'
import { ConversationActionContext } from './ConversationActionContext'
import { downloadImage } from './image-utils'
import { Lightbox } from './Lightbox'

// ─── Types ────────────────────────────────────────────────────────────

/** Format token count: 999 → "999", 1234 → "1.2K" */
function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  return (n / 1000).toFixed(n < 10000 ? 2 : 1) + 'K'
}

interface StreamingState {
  reasoning?: boolean
  content?: boolean
}

interface StreamingContent {
  reasoning?: string
  content?: string
}

/** A single item in the unified timeline */
type TimelineItem =
  | { kind: 'committed'; key: string; message: Message }
  | { kind: 'runtime'; key: string; step: DraftAssistantStep }
  | { kind: 'fallback-content'; key: string; content: StreamingContent; streaming: StreamingState }
  | { kind: 'fallback-toolcall'; key: string; toolCall: ToolCall; streamingArgs?: string }

interface AssistantTurnBubbleProps {
  turn: Extract<Turn, { type: 'assistant' }>
  toolResults: Map<string, string>
  /** Whether to render the bot avatar column for this bubble */
  showAvatar?: boolean
  /** Whether agent is still processing this turn */
  isProcessing?: boolean
  /** Whether agent is waiting (pending - request sent, waiting for response) */
  isWaiting?: boolean
  /** Streaming state flags (only for last turn when processing) */
  streamingState?: StreamingState
  /** Streaming content (only for last turn when processing) */
  streamingContent?: StreamingContent
  /** Current tool call being streamed (only for last turn when tool_calling) */
  currentToolCall?: ToolCall | null
  /** Streaming tool arguments (only for last turn when tool_calling) */
  streamingToolArgs?: string | null
  /** Streaming tool args keyed by tool call id */
  streamingToolArgsByCallId?: Record<string, string>
  /** Runtime tool calls captured during this run (for providers that don't emit tool_calls in assistant messages) */
  runtimeToolCalls?: ToolCall[]
  /** Runtime ordered streaming timeline (reasoning/content/tool calls) */
  runtimeSteps?: DraftAssistantStep[]
  /** Conversation ID — needed for ask_user_question to bridge UI answer back to executor */
  conversationId?: string | null
  /** Open the shared FilePreview drawer with a pre-loaded blob */
  onPreviewAsset?: (name: string, blob: Blob) => void
  /** When set, shows an inline hint that the agent stopped due to max iterations */
  iterationLimitReached?: number | null
}

// ─── Timeline builder ─────────────────────────────────────────────────

/**
 * Build a unified timeline from committed messages and runtime steps.
 *
 * Strategy:
 * 1. When NOT processing: just render committed messages in array order.
 * 2. When processing:
 *    a. Collect "already committed" info for dedup.
 *    b. Filter runtime steps: hide steps that duplicate committed content.
 *    c. Merge committed + visible runtime steps, sorted by timestamp.
 *    d. If no runtime steps visible, add fallback streaming content/tool calls.
 */
function buildTimeline(
  committed: Message[],
  runtimeSteps: DraftAssistantStep[],
  runtimeToolCalls: ToolCall[],
  currentToolCall: ToolCall | null,
  streamingContent: StreamingContent | undefined,
  streamingState: StreamingState | undefined,
  isProcessing: boolean,
  turnTimestamp: number,
): TimelineItem[] {
  // ── Non-processing: just committed messages in array order ──
  if (!isProcessing) {
    return committed.map((msg) => ({
      kind: 'committed' as const,
      key: `msg-${msg.id}`,
      message: msg,
    }))
  }

  // ── Processing mode: merge committed + runtime steps ──

  // Collect committed info for dedup
  const committedToolCallIds = new Set(
    committed.flatMap((msg) => msg.toolCalls?.map((tc) => tc.id) || []),
  )
  const latestCommittedTs = committed.reduce(
    (max, msg) => Math.max(max, typeof msg.timestamp === 'number' ? msg.timestamp : 0),
    0,
  )

  // Filter runtime steps
  const visibleSteps: DraftAssistantStep[] = []
  const runtimeToolCallIds = new Set<string>()

  for (const step of runtimeSteps) {
    // Streaming steps are always visible — they represent currently active blocks
    if (step.streaming) {
      visibleSteps.push(step)
      if (step.type === 'tool_call') runtimeToolCallIds.add(step.toolCall.id)
      continue
    }

    // Completed steps: hide if their content is already represented in committed messages
    switch (step.type) {
      case 'tool_call':
        // Hide if this tool call ID already appears in a committed message
        if (!committedToolCallIds.has(step.toolCall.id)) {
          visibleSteps.push(step)
          runtimeToolCallIds.add(step.toolCall.id)
        }
        break
      case 'content':
      case 'reasoning': {
        // Keep only latest in-flight completed reasoning/content.
        //
        // Dedup by CONTENT, not just timestamp: when a turn finishes, the
        // assistant message (carrying the same reasoning/content) is committed
        // while the completed runtime step can still be alive. The step's and
        // the message's clocks come from different code paths, so a pure
        // `stepTs >= latestCommittedTs` check lets the step survive when its
        // timestamp drifted past the message — rendering the same thinking
        // block twice. If the step's text is already committed anywhere in this
        // turn, it is by definition already represented — hide it.
        const stepTs = typeof step.timestamp === 'number' ? step.timestamp : 0
        const alreadyCommitted = committed.some(
          (msg) =>
            (step.type === 'reasoning' ? msg.reasoning : msg.content) === step.content &&
            step.content !== '',
        )
        if (stepTs >= latestCommittedTs && !alreadyCommitted) visibleSteps.push(step)
        break
      }
      case 'compression':
        // Hide if stale: completed compression from a previous iteration
        // (its timestamp is older than the latest committed message)
        {
          const stepTs = typeof step.timestamp === 'number' ? step.timestamp : 0
          if (stepTs >= latestCommittedTs) visibleSteps.push(step)
        }
        break
    }
  }

  // ── Build interleaved timeline sorted by timestamp ──
  type SortableItem = {
    timestamp: number
    subIndex: number
    source: 'committed' | 'runtime'
    sourceIndex: number
    item: TimelineItem
  }
  const sortableItems: SortableItem[] = []

  // Committed messages get even sub-indices for stable ordering at same timestamp
  committed.forEach((msg, idx) => {
    sortableItems.push({
      timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : 0,
      subIndex: idx * 2,
      source: 'committed',
      sourceIndex: idx,
      item: { kind: 'committed', key: `msg-${msg.id}`, message: msg },
    })
  })

  // Runtime steps get odd sub-indices
  visibleSteps.forEach((step, idx) => {
    const ts = typeof step.timestamp === 'number' ? step.timestamp : turnTimestamp + idx + 1
    sortableItems.push({
      timestamp: ts,
      subIndex: idx * 2 + 1,
      source: 'runtime',
      sourceIndex: idx,
      item: { kind: 'runtime', key: `step-${step.id}`, step },
    })
  })

  // Committed messages first (array order), then runtime steps (LLM emission order).
  // The visibleSteps filter already guarantees that visible runtime steps are from
  // after the last committed message, so no timestamp-based interleaving is needed.
  sortableItems.sort((a, b) => {
    if (a.source !== b.source) {
      return a.source === 'committed' ? -1 : 1
    }
    return a.sourceIndex - b.sourceIndex
  })

  const items: TimelineItem[] = sortableItems.map((si) => si.item)

  // ── Fallbacks (only when no runtime steps are visible) ──
  const hasVisibleRuntimeSteps = visibleSteps.length > 0

  // Fallback: draft tool calls not yet in steps or committed
  if (!hasVisibleRuntimeSteps) {
    for (const tc of runtimeToolCalls) {
      if (committedToolCallIds.has(tc.id)) continue
      items.push({
        kind: 'fallback-toolcall',
        key: `draft-tc-${tc.id}`,
        toolCall: tc,
      })
    }
  }

  // Fallback: streaming content blobs
  if (
    !hasVisibleRuntimeSteps &&
    streamingContent &&
    (streamingContent.reasoning || streamingContent.content)
  ) {
    items.push({
      kind: 'fallback-content',
      key: 'fallback-streaming',
      content: streamingContent,
      streaming: streamingState ?? {},
    })
  }

  // Fallback: current tool call not yet in steps/draft
  const allToolCallIds = new Set([
    ...committedToolCallIds,
    ...runtimeToolCallIds,
    ...runtimeToolCalls.map((tc) => tc.id),
  ])
  if (currentToolCall && !allToolCallIds.has(currentToolCall.id)) {
    items.push({
      kind: 'fallback-toolcall',
      key: `current-tc-${currentToolCall.id}`,
      toolCall: currentToolCall,
    })
  }

  return items
}

/**
 * Compute tool call IDs to suppress in committed message rendering.
 * A tool call is suppressed when it's actively executing (streaming, no result)
 * and already shown as a runtime step — avoids "double card" for the same call.
 */
function buildSuppressedIds(
  runtimeSteps: DraftAssistantStep[],
  toolResults: Map<string, string>,
  currentToolCall: ToolCall | null,
): Set<string> {
  const suppressed = new Set<string>()
  for (const step of runtimeSteps) {
    if (step.type !== 'tool_call') continue
    const hasResult = !!(step.result ?? toolResults.get(step.toolCall.id))
    if (step.streaming && !hasResult) {
      suppressed.add(step.toolCall.id)
    }
  }
  if (currentToolCall && !toolResults.get(currentToolCall.id)) {
    suppressed.add(currentToolCall.id)
  }
  return suppressed
}

// ─── Stable empty set for suppressed IDs (avoids new Set() per render) ──
const EMPTY_STRING_SET: Set<string> = new Set()

// ─── Main component ───────────────────────────────────────────────────

export const AssistantTurnBubble = memo(function AssistantTurnBubble({
  turn,
  toolResults,
  showAvatar = true,
  isProcessing,
  isWaiting,
  streamingState,
  streamingContent,
  currentToolCall,
  streamingToolArgs,
  streamingToolArgsByCallId,
  runtimeToolCalls,
  runtimeSteps,
  conversationId,
  onPreviewAsset,
  iterationLimitReached,
}: AssistantTurnBubbleProps) {
  const t = useT()
  const navigate = useRouter()
  const { projectId } = useParams<{ projectId: string }>()
  const conversationActions = useContext(ConversationActionContext)
  const isStreamingReasoning = streamingState?.reasoning ?? false
  const isStreamingContent = streamingState?.content ?? false

  // Lightbox state for image click-to-enlarge
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)

  // Build unified timeline
  const timeline = buildTimeline(
    turn.messages,
    runtimeSteps || [],
    runtimeToolCalls || [],
    currentToolCall ?? null,
    streamingContent,
    streamingState,
    !!isProcessing,
    turn.timestamp,
  )

  // Compute suppressed tool call IDs for committed message rendering
  const suppressedIds = isProcessing
    ? buildSuppressedIds(runtimeSteps || [], toolResults, currentToolCall ?? null)
    : EMPTY_STRING_SET

  // Last message with content for copy button
  const lastMessageWithContent = [...turn.messages].reverse().find((msg) => msg.content)

  // Branch conversation state
  const [isBranching, setIsBranching] = useState(false)
  const handleBranch = async () => {
    if (!conversationId || isBranching) return
    // Use the last message in this turn as the branch point
    const branchPointMessageId = turn.messages[turn.messages.length - 1]?.id
    if (!branchPointMessageId) return
    setIsBranching(true)
    try {
      const branched = await useConversationStore.getState().branchConversation(conversationId, branchPointMessageId)
      // Navigate to the new branched conversation so syncFromRoute triggers workspace switching
      if (projectId && branched) {
        navigate.push(projectWorkspacePath(projectId, branched.id))
      }
    } catch (error) {
      console.error('[AssistantTurnBubble] Failed to branch conversation:', error)
    } finally {
      setIsBranching(false)
    }
  }

  return (
    <div className={showAvatar ? 'flex gap-3' : ''}>
      {showAvatar && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-700">
          <Bot className="h-4 w-4" />
        </div>
      )}

      {/* Steps column */}
      <div className={showAvatar ? 'w-[90%] min-w-0 space-y-2' : 'w-full min-w-0 space-y-2'}>
        {/* Timeline */}
        {timeline.map((item) => (
          <Fragment key={item.key}>
            {renderTimelineItem(
              item,
              toolResults,
              suppressedIds,
              streamingToolArgs ?? null,
              streamingToolArgsByCallId,
              conversationId,
              onPreviewAsset,
              (src: string) => setLightboxSrc(src),
            )}
          </Fragment>
        ))}

        {/* Waiting indicator */}
        {isWaiting && !currentToolCall && !isStreamingReasoning && !isStreamingContent && (
          <div className="inline-block rounded-lg bg-white px-4 py-2 text-base text-neutral-800 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-100 dark:ring-neutral-700">
            <span className="flex items-center gap-1.5">
              <span
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400 dark:bg-neutral-500"
                style={{ animationDelay: '0ms' }}
              />
              <span
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400 dark:bg-neutral-500"
                style={{ animationDelay: '200ms' }}
              />
              <span
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400 dark:bg-neutral-500"
                style={{ animationDelay: '400ms' }}
              />
            </span>
          </div>
        )}


        {/* Iteration limit reached hint (only when not processing) */}
        {!isProcessing && !isWaiting && iterationLimitReached && (
          <div className="flex items-start gap-1.5 rounded-md px-2.5 py-1.5 text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">
              {t('conversation.iterationLimit.reached', { count: iterationLimitReached })}
              <span className="ml-1 text-neutral-350 dark:text-neutral-550">
                {t('conversation.iterationLimit.hint')}
              </span>
            </span>
            {conversationActions?.sendMessage && (
              <button
                type="button"
                onClick={() => conversationActions.sendMessage!('继续')}
                className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800/30 dark:hover:text-neutral-300"
              >
                {t('conversation.iterationLimit.continue')}
              </button>
            )}
          </div>
        )}

        {/* Summary footer (only when not processing) */}
        {!isProcessing && !isWaiting && (
          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <span>
              {new Date(turn.timestamp).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            {turn.totalUsage && (
              <span className="inline-flex items-center gap-1.5">
                <span title={t('conversation.usage.input') || 'input (excl. cache)'}>
                  ↑{formatTokens(turn.totalUsage.accumulatedPromptTokens ?? turn.totalUsage.promptTokens)}
                </span>
                <span title={t('conversation.usage.output') || 'output'}>
                  ↓{formatTokens(turn.totalUsage.accumulatedCompletionTokens ?? turn.totalUsage.completionTokens)}
                </span>
                {(() => {
                  const cache = turn.totalUsage.accumulatedCacheTokens ?? turn.totalUsage.cacheReadTokens
                  return cache ? (
                    <span className="inline-flex items-center gap-0.5" title={t('conversation.usage.cache') || 'cache hit'}>
                      <Database className="h-3 w-3 text-neutral-400" />{formatTokens(cache)}
                    </span>
                  ) : null
                })()}
              </span>
            )}
            {lastMessageWithContent?.content && (
              <CopyButton content={lastMessageWithContent.content} />
            )}
            {lastMessageWithContent?.content && (
              <ShareButton content={lastMessageWithContent.content} messageId={lastMessageWithContent.id} />
            )}
            <button
              type="button"
              onClick={handleBranch}
              disabled={isBranching || !conversationId}
              className={`inline-flex items-center rounded p-1 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-300 disabled:cursor-not-allowed disabled:opacity-50`}
              title={t('conversation.branch') || 'Branch from here'}
              aria-label={t('conversation.branch') || 'Branch from here'}
            >
              <Split className={`h-3.5 w-3.5 ${isBranching ? 'animate-pulse' : ''}`} />
            </button>
          </div>
        )}
      </div>

      {/* Lightbox overlay for click-to-enlarge images */}
      {lightboxSrc && (
        <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}
    </div>
  )
})

// ─── Timeline rendering helpers ───────────────────────────────────────

function renderTimelineItem(
  item: TimelineItem,
  toolResults: Map<string, string>,
  suppressedIds: Set<string>,
  streamingToolArgs: string | null,
  streamingToolArgsByCallId: Record<string, string> | undefined,
  conversationId: string | null | undefined,
  onPreviewAsset?: (name: string, blob: Blob) => void,
  onImageClick?: (src: string) => void,
): ReactNode {
  switch (item.kind) {
    case 'committed':
      return (
        <AssistantStep
          message={item.message}
          toolResults={toolResults}
          showDivider={false}
          suppressExecutingToolCallIds={suppressedIds}
          conversationId={conversationId ?? undefined}
          onPreviewAsset={onPreviewAsset}
          onImageClick={onImageClick}
        />
      )

    case 'runtime':
      return renderRuntimeStep(
        item.step,
        toolResults,
        streamingToolArgs,
        streamingToolArgsByCallId,
        conversationId,
      )

    case 'fallback-content':
      return (
        <StreamingContentSection
          reasoning={item.content.reasoning}
          content={item.content.content}
          isStreamingReasoning={item.streaming.reasoning ?? false}
          isStreamingContent={item.streaming.content ?? false}
          lightweight={false}
          showDivider={false}
        />
      )

    case 'fallback-toolcall':
      return (
        <ToolCallDisplay
          toolCall={item.toolCall}
          isExecuting={true}
          streamingArgs={
            streamingToolArgsByCallId?.[item.toolCall.id] ||
            streamingToolArgs ||
            undefined
          }
          conversationId={conversationId ?? undefined}
        />
      )
  }
}

function renderRuntimeStep(
  step: DraftAssistantStep,
  toolResults: Map<string, string>,
  streamingToolArgs: string | null,
  streamingToolArgsByCallId: Record<string, string> | undefined,
  conversationId: string | null | undefined,
): ReactNode {
  if (step.type === 'reasoning') {
    if (!step.content) return null
    return (
      <StreamingContentSection
        reasoning={step.content}
        reasoningStartedAt={step.timestamp}
        reasoningDurationMs={step.durationMs}
        isStreamingReasoning={step.streaming}
        isStreamingContent={false}
        lightweight={true}
        showDivider={false}
      />
    )
  }

  if (step.type === 'content') {
    if (!step.content) return null
    return (
      <StreamingContentSection
        content={step.content}
        isStreamingReasoning={false}
        isStreamingContent={step.streaming}
        lightweight={true}
        // Content steps always use the incremental-markdown path: the hook
        // keeps the 60fps plain-text fallback while tokens arrive, promotes
        // to a formatted snapshot during quiet windows, and renders the
        // final markdown once the step completes (no flash back to plain).
        renderMarkdownWhileStreaming={true}
        showDivider={false}
      />
    )
  }

  if (step.type === 'compression') {
    return <CompressionStatusCard text={step.content} streaming={step.streaming} />
  }

  // tool_call
  return (
    <ToolCallDisplay
      toolCall={step.toolCall}
      result={step.result ?? toolResults.get(step.toolCall.id)}
      isExecuting={step.streaming && !(step.result ?? toolResults.get(step.toolCall.id))}
      streamingArgs={
        step.streaming
          ? step.args ||
            streamingToolArgsByCallId?.[step.toolCall.id] ||
            streamingToolArgs ||
            undefined
          : undefined
      }
      subagentEvents={step.subagentEvents}
      conversationId={conversationId ?? undefined}
    />
  )
}

// ─── Sub-components ───────────────────────────────────────────────────

/**
 * Renders streaming content section within the turn.
 *
 * `renderMarkdownWhileStreaming` opts the content block into incremental
 * markdown rendering during the live stream: the hook keeps the 60fps
 * plain-text path while tokens arrive, then promotes to a formatted
 * markdown snapshot during quiet windows (see use-streaming-markdown).
 */
const StreamingContentSection = memo(function StreamingContentSection({
  reasoning,
  reasoningStartedAt,
  reasoningDurationMs,
  content,
  isStreamingReasoning,
  isStreamingContent,
  lightweight = false,
  showDivider = true,
  renderMarkdownWhileStreaming = false,
}: {
  reasoning?: string
  reasoningStartedAt?: number
  reasoningDurationMs?: number
  content?: string
  isStreamingReasoning: boolean
  isStreamingContent: boolean
  lightweight?: boolean
  showDivider?: boolean
  /** When true, streamed content renders markdown incrementally (quiet-window promotion). */
  renderMarkdownWhileStreaming?: boolean
}) {
  const streamingMarkdown = useStreamingMarkdown(
    content ?? '',
    isStreamingContent && !!renderMarkdownWhileStreaming,
  )
  return (
    <>
      {showDivider && <div className="border-t border-neutral-100 dark:border-neutral-700" />}

      {/* Reasoning */}
      {reasoning && (
        <ReasoningSection
          reasoning={reasoning}
          streaming={isStreamingReasoning}
          startedAt={reasoningStartedAt}
          durationMs={reasoningDurationMs}
        />
      )}

      {/* Content */}
      {content && (
        <div className="rounded-lg bg-white px-4 py-2 text-base text-neutral-800 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-100 dark:ring-neutral-700">
          {(() => {
            // Incremental markdown during live stream: use the hook's
            // decision (plain 60fps vs markdown snapshot). Non-streaming
            // content always renders markdown directly.
            if (renderMarkdownWhileStreaming) {
              return streamingMarkdown.renderMarkdown ? (
                <div className="prose max-w-prose overflow-x-auto break-words">
                  <MarkdownContent content={streamingMarkdown.content} streaming={isStreamingContent} />
                </div>
              ) : (
                <div className="max-w-prose whitespace-pre-wrap break-words">{content}</div>
              )
            }
            return lightweight ? (
              <div className="max-w-prose whitespace-pre-wrap break-words">{content}</div>
            ) : (
              <div className="prose max-w-prose overflow-x-auto break-words">
                <MarkdownContent content={content} streaming={isStreamingContent} />
              </div>
            )
          })()}
          {/* Cursor when actively streaming content */}
          {isStreamingContent && (
            <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-neutral-400 align-text-bottom" />
          )}
        </div>
      )}
    </>
  )
})

/** Renders one assistant message step inside a turn */
const AssistantStep = memo(function AssistantStep({
  message,
  toolResults,
  showDivider,
  suppressExecutingToolCallIds,
  conversationId,
  onPreviewAsset,
  onImageClick,
}: {
  message: Message
  toolResults: Map<string, string>
  showDivider: boolean
  suppressExecutingToolCallIds?: Set<string>
  conversationId?: string
  onPreviewAsset?: (name: string, blob: Blob) => void
  onImageClick?: (src: string) => void
}) {
  const t = useT()
  const contentRef = useRef<HTMLDivElement>(null)
  const hasReasoning = !!message.reasoning
  const hasContent = !!message.content
  const hasImages = !!(message.images && message.images.length > 0)
  const hasAssets = !!(message.assets && message.assets.length > 0)
  const visibleToolCalls =
    message.toolCalls?.filter((tc) => !suppressExecutingToolCallIds?.has(tc.id)) || []
  const hasToolCalls = visibleToolCalls.length > 0
  const isContextSummary = message.kind === 'context_summary'
  const isRunChanges = message.kind === 'run_changes'

  return (
    <>
      {showDivider && <div className="border-t border-neutral-100 dark:border-neutral-700" />}

      {isRunChanges && message.runChanges && (
        <RunChangesCard snapshotId={message.runChanges.snapshotId} />
      )}

      {!isRunChanges && (hasReasoning || hasContent || hasImages || hasToolCalls || hasAssets) && (
        <div className="space-y-2">
          {hasReasoning && (
            <ReasoningSection reasoning={message.reasoning!} durationMs={message.reasoningDurationMs} />
          )}

          {hasContent && (
            <div
              data-message-id={message.id}
              className={
                isContextSummary
                  ? 'rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-base text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100'
                  : 'rounded-lg bg-white px-4 py-2 text-base text-neutral-800 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-100 dark:ring-neutral-700'
              }
            >
              {isContextSummary && <ContextSummaryCard content={message.content!} />}
              {!isContextSummary && (
                <div ref={contentRef} className="prose max-w-prose overflow-x-auto break-words select-text">
                  <MarkdownContent content={message.content!} />
                  <TextSelectionToolbar containerRef={contentRef} />
                </div>
              )}
            </div>
          )}

          {/* Generated images — inline display */}
          {hasImages && (
            <div className="space-y-3">
              {message.images!.map((img, idx) => (
                <div
                  key={idx}
                  className="group relative overflow-hidden rounded-lg ring-1 ring-neutral-200 dark:ring-neutral-700"
                >
                  <img
                    src={`data:${img.mimeType};base64,${img.data}`}
                    alt={`Generated image ${idx + 1}`}
                    className="block max-w-full h-auto cursor-zoom-in"
                    onClick={() => onImageClick?.(`data:${img.mimeType};base64,${img.data}`)}
                  />
                  {/* Hover overlay with action buttons */}
                  <div className="absolute inset-0 flex items-end justify-end gap-1.5 bg-gradient-to-t from-black/40 via-transparent to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      className="rounded-md bg-white/90 p-1.5 text-neutral-700 shadow-sm backdrop-blur-sm transition-colors hover:bg-white dark:bg-neutral-800/90 dark:text-neutral-200 dark:hover:bg-neutral-700"
                      title={t('conversation.imageGen.downloadImage')}
                      aria-label={t('conversation.imageGen.downloadImage')}
                      onClick={() => downloadImage(img.data, img.mimeType, `image-${idx + 1}`)}
                    >
                      <Download className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {hasToolCalls && (
            <div className="space-y-1">
              {visibleToolCalls.map((tc) => (
                <ToolCallDisplay
                  key={tc.id}
                  toolCall={tc}
                  result={toolResults.get(tc.id)}
                  conversationId={conversationId}
                />
              ))}
            </div>
          )}

          {message.assets && message.assets.length > 0 && <AssetCompactList assets={message.assets} onPreview={onPreviewAsset} />}
        </div>
      )}
    </>
  )
}, (prev, next) => {
  // Fast-path: same references → skip
  if (
    prev.message === next.message &&
    prev.toolResults === next.toolResults &&
    prev.showDivider === next.showDivider &&
    prev.suppressExecutingToolCallIds === next.suppressExecutingToolCallIds &&
    prev.conversationId === next.conversationId
  ) {
    return true
  }

  // Message identity is the primary key — if it's the same message object, no re-render needed
  if (prev.message !== next.message) return false

  if (prev.showDivider !== next.showDivider) return false
  if (prev.conversationId !== next.conversationId) return false
  if (prev.onPreviewAsset !== next.onPreviewAsset) return false

  // Only check tool results for the tool calls this message actually uses
  const toolCalls = prev.message.toolCalls
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      if (prev.toolResults.get(tc.id) !== next.toolResults.get(tc.id)) return false
    }
  }

  // Shallow-compare suppressed set by checking each entry
  const prevSup = prev.suppressExecutingToolCallIds
  const nextSup = next.suppressExecutingToolCallIds
  if (prevSup !== nextSup) {
    if (!prevSup || !nextSup) return false
    if (prevSup.size !== nextSup.size) return false
    for (const id of prevSup) {
      if (!nextSup.has(id)) return false
    }
  }

  return true
})

/** Compression status card — shows progress of context compression */
function CompressionStatusCard({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-300">
      <span>{text}</span>
      {streaming && (
        <span className="ml-1 inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-400 border-t-transparent align-text-bottom" />
      )}
    </div>
  )
}
