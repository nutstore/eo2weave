import { produce } from 'immer'
import type { AgentEvent as PiAgentEvent, AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessageEvent as PiAssistantMessageEvent, ToolResultMessage as PiToolResultMessage } from '@earendil-works/pi-ai'
import type { AgentCallbacks } from './types'
import type { Message, ToolCall } from '../message-types'

export interface PiLoopMessageState {
  allMessages: Message[]
}

export interface ProcessPiLoopEventsInput {
  loop: AsyncIterable<PiAgentEvent>
  initialMessages: Message[]
  /**
   * Optional shared message state synchronized with external message injections
   * (e.g. context summary emitted during convertToLlm).
   */
  messageState?: PiLoopMessageState
  callbacks?: AgentCallbacks
  maxIterations: number
  applyAssistantUpdate: (
    event: PiAssistantMessageEvent,
    callbacks?: AgentCallbacks,
    onToolCallStart?: (toolCall: ToolCall) => void,
    toolCallIdByIndex?: Map<number, string>
  ) => void
  mapPiToInternal: (message: PiAgentMessage) => Message | null
  extractTextContent: (content: unknown) => string | null
  /**
   * Optional soft-interrupt hook. Called after each `tool_execution_end`
   * event. When it returns `true`, the loop yields after the corresponding
   * tool-result message has been committed, so the caller can dequeue and
   * process the next user message (Codex/Claude Code-style "interrupt at
   * tool boundary" behavior).
   *
   * Pending tool completions in `pendingToolCompletions` are still flushed
   * via the cleanup loop at the bottom, so `onToolCallComplete` callbacks
   * always fire even on yield.
   */
  shouldYield?: () => boolean
}

export interface ProcessPiLoopEventsResult {
  allMessages: Message[]
  reachedMaxIterations: boolean
}

export async function processPiLoopEvents(
  input: ProcessPiLoopEventsInput
): Promise<ProcessPiLoopEventsResult> {
  let allMessages = input.messageState?.allMessages || input.initialMessages
  let assistantMessageCount = 0
  let reachedMaxIterations = false
  let assistantMessageStarted = false

  const getAllMessages = (): Message[] => input.messageState?.allMessages || allMessages
  const setAllMessages = (messages: Message[]): void => {
    allMessages = messages
    if (input.messageState) {
      input.messageState.allMessages = messages
    }
  }

  const emittedToolCallSignatures = new Map<string, string>()
  const toolCallIdByIndex = new Map<number, string>()
  const toolCallArgsById = new Map<string, Record<string, unknown>>()
  const pendingToolCompletions = new Map<string, { toolCall: ToolCall; resultText: string }>()
  const toolCallIdsToYieldAfter = new Set<string>()

  const emitToolCallStartIfChanged = (toolCall: ToolCall) => {
    const signature = `${toolCall.function.name}:${toolCall.function.arguments}`
    const previous = emittedToolCallSignatures.get(toolCall.id)
    if (previous === signature) return
    emittedToolCallSignatures.set(toolCall.id, signature)
    input.callbacks?.onToolCallStart?.(toolCall)
  }

  for await (const event of input.loop) {
    const typedEvent = event as PiAgentEvent
    if (typedEvent.type === 'message_start' && typedEvent.message.role === 'assistant') {
      assistantMessageStarted = true
      input.callbacks?.onMessageStart?.()
    }

    if (typedEvent.type === 'message_update') {
      if (!assistantMessageStarted) {
        assistantMessageStarted = true
        input.callbacks?.onMessageStart?.()
      }
      input.applyAssistantUpdate(
        typedEvent.assistantMessageEvent,
        input.callbacks,
        (toolCall) => {
          emitToolCallStartIfChanged(toolCall)
        },
        toolCallIdByIndex
      )
    }

    if (typedEvent.type === 'tool_execution_start') {
      const args = (typedEvent.args || {}) as Record<string, unknown>
      toolCallArgsById.set(typedEvent.toolCallId, args)
      emitToolCallStartIfChanged({
        id: typedEvent.toolCallId,
        type: 'function',
        function: {
          name: typedEvent.toolName,
          arguments: JSON.stringify(args),
        },
      })
    }

    if (typedEvent.type === 'tool_execution_end') {
      const details = (typedEvent.result as PiToolResultMessage)?.details as { displayContent?: string } | undefined
      const resultText = details?.displayContent ?? input.extractTextContent((typedEvent.result as PiToolResultMessage)?.content) ?? ''
      pendingToolCompletions.set(typedEvent.toolCallId, {
        toolCall: {
          id: typedEvent.toolCallId,
          type: 'function',
          function: {
            name: typedEvent.toolName,
            arguments: JSON.stringify(toolCallArgsById.get(typedEvent.toolCallId) || {}),
          },
        },
        resultText,
      })

      // The pi-agent loop emits the persisted tool-result message after this
      // event. Defer the interrupt until that message is appended below;
      // otherwise ensureToolCallResults would replace this successful result
      // with a synthetic "interrupted" result in the next turn's context.
      if (input.shouldYield?.()) {
        toolCallIdsToYieldAfter.add(typedEvent.toolCallId)
      }
    }

    if (typedEvent.type === 'message_end') {
      // Detect error assistant messages from the LLM provider (e.g. HTTP 404, 429, 500).
      // pi-agent-core finishes the loop normally for these, but we need to propagate
      // the error so the UI shows it instead of silently completing with an empty message.
      const rawMessage = typedEvent.message as unknown as Record<string, unknown>
      if (
        rawMessage?.role === 'assistant' &&
        (rawMessage as any).stopReason === 'error' &&
        typeof (rawMessage as any).errorMessage === 'string'
      ) {
        throw new Error((rawMessage as any).errorMessage)
      }

      const mapped = input.mapPiToInternal(typedEvent.message)
      if (!mapped || mapped.role === 'user') continue
      if (mapped.role === 'assistant') {
        assistantMessageStarted = false
      }
      if (mapped.role === 'assistant') {
        assistantMessageCount++
        const hasIterationLimit = input.maxIterations > 0
        if (hasIterationLimit && assistantMessageCount > input.maxIterations) {
          console.warn('[#LoopStop] max_iterations_reached', {
            assistantMessageCount,
            maxIterations: input.maxIterations,
          })
          reachedMaxIterations = true
          break
        }
      }
      const nextMessages = produce(getAllMessages(), (draft) => {
        draft.push(mapped)
      })
      setAllMessages(nextMessages)
      input.callbacks?.onMessagesUpdated?.(nextMessages)
      if (mapped.role === 'tool' && mapped.toolCallId) {
        const pending = pendingToolCompletions.get(mapped.toolCallId)
        if (pending) {
          input.callbacks?.onToolCallComplete?.(pending.toolCall, pending.resultText)
          pendingToolCompletions.delete(mapped.toolCallId)
        }
        if (toolCallIdsToYieldAfter.delete(mapped.toolCallId)) {
          break
        }
      }
    }
  }

  for (const pending of pendingToolCompletions.values()) {
    input.callbacks?.onToolCallComplete?.(pending.toolCall, pending.resultText)
  }

  return { allMessages: getAllMessages(), reachedMaxIterations }
}
