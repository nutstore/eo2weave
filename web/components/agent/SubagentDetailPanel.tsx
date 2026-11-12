/** Render live shared traces or saved execution messages using the main conversation renderers. */

import { memo, useEffect, useMemo, useState } from 'react'
import { useT } from '@/i18n'
import { useSubagentTaskStore, selectSubagentTask } from '@/store/subagent-task.store'
import { Loader2 } from 'lucide-react'
import type { DraftAssistantStep, Message } from '@/agent/message-types'
import { getSubagentRepository } from '@/sqlite'
import { ToolCallDisplay } from './ToolCallDisplay'
import { ReasoningSection } from './ReasoningSection'
import { MarkdownContent } from './MarkdownContent'
import { useStreamingMarkdown } from './use-streaming-markdown'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'

// ─── Sub-components (mirrors AssistantTurnBubble's lightweight renderers) ──

function SubagentStreamingContent({
  reasoning,
  reasoningStartedAt,
  reasoningDurationMs,
  content,
  isStreamingReasoning,
  isStreamingContent,
}: {
  reasoning?: string
  reasoningStartedAt?: number
  reasoningDurationMs?: number
  content?: string
  isStreamingReasoning: boolean
  isStreamingContent: boolean
}) {
  const streamingMarkdown = useStreamingMarkdown(content ?? '', isStreamingContent)
  return (
    <>
      {reasoning && (
        <ReasoningSection
          reasoning={reasoning}
          streaming={isStreamingReasoning}
          startedAt={reasoningStartedAt}
          durationMs={reasoningDurationMs}
        />
      )}
      {content && (
        <div className="rounded-lg bg-white px-3 py-1.5 text-sm text-neutral-800 dark:bg-neutral-800 dark:text-neutral-100">
          {isStreamingContent && streamingMarkdown.renderMarkdown ? (
            <div className="prose max-w-prose overflow-x-auto break-words">
              <MarkdownContent content={streamingMarkdown.content} streaming />
            </div>
          ) : (
            <div className="max-w-prose whitespace-pre-wrap break-words">
              {content}
              {isStreamingContent && (
                <span className="ml-0.5 inline-block h-3 w-[2px] animate-pulse motion-reduce:animate-none bg-neutral-400 align-text-bottom" />
              )}
            </div>
          )}
        </div>
      )}
    </>
  )
}

function SubagentCompressionCard({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-300">
      <span>{text}</span>
      {streaming && (
        <span className="ml-1 inline-block h-3 w-3 animate-spin motion-reduce:animate-none rounded-full border-2 border-slate-400 border-t-transparent align-text-bottom" />
      )}
    </div>
  )
}

function renderSubagentStep(
  step: DraftAssistantStep,
  toolResults: Map<string, string>,
  conversationId?: string,
): React.ReactNode {
  if (step.type === 'reasoning') {
    if (!step.content) return null
    return (
      <SubagentStreamingContent
        reasoning={step.content}
        reasoningStartedAt={step.timestamp}
        reasoningDurationMs={step.durationMs}
        isStreamingReasoning={step.streaming}
        isStreamingContent={false}
      />
    )
  }

  if (step.type === 'content') {
    if (!step.content) return null
    return (
      <SubagentStreamingContent
        content={step.content}
        isStreamingReasoning={false}
        isStreamingContent={step.streaming}
      />
    )
  }

  if (step.type === 'compression') {
    return <SubagentCompressionCard text={step.content} streaming={step.streaming} />
  }

  // tool_call — reuse the exact same ToolCallDisplay component as main agent
  return (
    <ToolCallDisplay
      conversationId={conversationId}
      toolCall={step.toolCall}
      result={step.result ?? toolResults.get(step.toolCall.id)}
      isExecuting={step.streaming && !(step.result ?? toolResults.get(step.toolCall.id))}
      streamingArgs={step.streaming ? step.args || undefined : undefined}
    />
  )
}

function buildPersistedSteps(messages: Message[]): {
  steps: DraftAssistantStep[]
  toolResults: Map<string, string>
} {
  const toolResults = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId) {
      toolResults.set(message.toolCallId, message.displayContent ?? message.content ?? '')
    }
  }

  const steps: DraftAssistantStep[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue

    if (message.reasoning) {
      steps.push({
        id: `${message.id}:reasoning`,
        type: 'reasoning',
        content: message.reasoning,
        timestamp: message.timestamp,
        durationMs: message.reasoningDurationMs,
        streaming: false,
      })
    }
    if (message.content) {
      steps.push({
        id: `${message.id}:content`,
        type: 'content',
        content: message.content,
        streaming: false,
      })
    }
    for (const toolCall of message.toolCalls ?? []) {
      steps.push({
        id: `${message.id}:${toolCall.id}`,
        type: 'tool_call',
        toolCall,
        args: toolCall.function.arguments,
        result: toolResults.get(toolCall.id),
        streaming: false,
      })
    }
  }

  return { steps, toolResults }
}

// ─── Main component ─────────────────────────────────────────────────────────

interface SubagentDetailPanelProps {
  agentId: string
  /** conversationId is also the workspace ID used by persisted subagent tasks. */
  conversationId?: string
}

export const SubagentDetailPanel = memo(function SubagentDetailPanel({
  agentId,
  conversationId,
}: SubagentDetailPanelProps) {
  const t = useT()
  const task = useSubagentTaskStore(selectSubagentTask(agentId))
  const projection = task?.conversationId === conversationId ? task : undefined
  const draft = useConversationRuntimeStore(
    (state) => state.subagentDrafts.get(agentId)
  )
  const [persistedMessages, setPersistedMessages] = useState<Message[] | null>(null)
  const [isLoadingPersisted, setIsLoadingPersisted] = useState(false)

  useEffect(() => {
    if (draft || projection || !conversationId) return
    setPersistedMessages(null)

    let cancelled = false
    setIsLoadingPersisted(true)
    void getSubagentRepository()
      .findByWorkspaceId(conversationId)
      .then((tasks) => {
        if (!cancelled) {
          setPersistedMessages(tasks.find((task) => task.agentId === agentId)?.messages ?? [])
        }
      })
      .catch(() => {
        if (!cancelled) setPersistedMessages([])
      })
      .finally(() => {
        if (!cancelled) setIsLoadingPersisted(false)
      })

    return () => { cancelled = true }
  }, [agentId, conversationId, draft, projection])

  const persisted = useMemo(
    () => buildPersistedSteps(projection?.messages ?? persistedMessages ?? []),
    [projection?.messages, persistedMessages]
  )

  const steps = draft?.steps ?? persisted.steps
  const toolResults = draft
    ? new Map(Object.entries(draft.toolResults))
    : persisted.toolResults

  if (!draft && !projection && isLoadingPersisted) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-neutral-400">
        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
        <span>{t('conversation.backgroundTasks.restoring')}</span>
      </div>
    )
  }

  if (!draft && !projection && persistedMessages === null) {
    return (
      <div className="px-3 py-2 text-xs text-neutral-400">
        {t('conversation.backgroundTasks.noTrace')}
      </div>
    )
  }

  if (!draft && projection?.status !== 'running' && projection?.status !== 'pending' && steps.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-neutral-400">
        {t('conversation.backgroundTasks.noTrace')}
      </div>
    )
  }

  if (steps.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-neutral-400">
        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
        <span>{t('conversation.backgroundTasks.waiting')}</span>
      </div>
    )
  }

  return (
    <div className="min-w-0 space-y-1.5 overflow-x-hidden px-1 py-1">
      {steps.map((step) => (
        <div key={step.id}>
          {renderSubagentStep(step, toolResults, conversationId)}
        </div>
      ))}
    </div>
  )
})
