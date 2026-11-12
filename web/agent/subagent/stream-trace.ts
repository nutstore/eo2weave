import type { Message } from '@/agent/message-types'
import {
  applyDraftAssistantEvent,
  createEmptyDraftAssistant,
  type DraftAssistantEvent,
} from '@/store/draft-assistant'

/** Projects uncommitted stream events into the same message trace as committed loop snapshots. */
export class SubagentStreamTrace {
  private holder = { draftAssistant: createEmptyDraftAssistant() }
  private committed: Message[]
  private messageIndex = 0
  private messageTimestamp = Date.now()

  constructor(
    messages: Message[],
    private executionId: string
  ) {
    this.committed = structuredClone(messages)
  }

  apply(event: DraftAssistantEvent): void {
    if (event.type === 'message_start') {
      this.messageIndex += 1
      this.messageTimestamp = Date.now()
    }
    applyDraftAssistantEvent(this.holder, structuredClone(event))
  }

  replaceMessages(messages: Message[]): void {
    const previousAssistantIds = new Set(
      this.committed.filter((message) => message.role === 'assistant').map((message) => message.id)
    )
    if (
      messages.some(
        (message) => message.role === 'assistant' && !previousAssistantIds.has(message.id)
      )
    ) {
      // message_end has committed the current text. Tool progress can still arrive
      // afterwards, so retain the shared reducer's tool state until its result commits.
      this.holder.draftAssistant.content = ''
      this.holder.draftAssistant.reasoning = ''
    }
    this.committed = structuredClone(messages)
  }

  messages(): Message[] {
    const draft = this.holder.draftAssistant
    const committedCalls = new Set(
      this.committed.flatMap((message) => message.toolCalls?.map((call) => call.id) ?? [])
    )
    const committedResults = new Set(
      this.committed
        .filter((message) => message.role === 'tool')
        .map((message) => message.toolCallId)
    )
    const toolCalls = draft.toolCalls.map((call) => {
      const step = [...draft.steps]
        .reverse()
        .find((candidate) => candidate.type === 'tool_call' && candidate.toolCall.id === call.id)
      const args = step?.type === 'tool_call' && step.args ? step.args : call.function.arguments
      return { ...call, function: { ...call.function, arguments: args } }
    })
    const pendingCalls = toolCalls.filter((call) => !committedCalls.has(call.id))
    const messages = [...this.committed]
    if (draft.content || draft.reasoning || pendingCalls.length) {
      messages.push({
        id: `subagent-stream:${this.executionId}:${this.messageIndex}`,
        role: 'assistant',
        content: draft.content || null,
        ...(draft.reasoning ? { reasoning: draft.reasoning } : {}),
        ...(pendingCalls.length ? { toolCalls: pendingCalls } : {}),
        timestamp: this.messageTimestamp,
      })
    }
    for (const call of toolCalls) {
      if (
        !committedResults.has(call.id) &&
        Object.prototype.hasOwnProperty.call(draft.toolResults, call.id)
      ) {
        messages.push({
          id: `subagent-stream:${this.executionId}:tool:${call.id}`,
          role: 'tool',
          toolCallId: call.id,
          content: draft.toolResults[call.id],
          timestamp: this.messageTimestamp,
        })
      }
    }
    return messages
  }
}
