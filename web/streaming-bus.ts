/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Streaming EventBus — an event bus that avoids circular dependencies
 *
 * Carries streaming events between conversation.store (the SQLite variant) and conversation.store
 */

type StreamingEventType =
  | 'thinking:start'
  | 'thinking:delta'
  | 'thinking:complete'
  | 'compression:event'
  | 'tool:start'
  | 'tool:delta'
  | 'tool:complete'
  | 'content:start'
  | 'content:delta'
  | 'content:complete'
  | 'status:change'
  | 'complete'
  | 'error'

type EventCallback = (data: any) => void

class StreamingEventBus {
  private listeners = new Map<StreamingEventType, Set<EventCallback>>()

  /** Subscribe to an event */
  on(event: StreamingEventType, callback: EventCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(callback)

    // Return the unsubscribe function
    return () => this.off(event, callback)
  }

  /** Unsubscribe */
  off(event: StreamingEventType, callback: EventCallback): void {
    this.listeners.get(event)?.delete(callback)
  }

  /** Emit an event */
  emit(event: StreamingEventType, data?: any): void {
    this.listeners.get(event)?.forEach((callback) => {
      try {
        callback(data)
      } catch (error) {
        console.error(`[StreamingBus] Error in ${event} handler:`, error)
      }
    })
  }

  /** Remove all listeners */
  clear(): void {
    this.listeners.clear()
  }

  /** Current listener count for an event (debugging) */
  getListenerCount(event: StreamingEventType): number {
    return this.listeners.get(event)?.size ?? 0
  }
}

// Singleton export
export const streamingBus = new StreamingEventBus()

// Convenience helpers
export const emitThinkingStart = () => streamingBus.emit('thinking:start')
export const emitThinkingDelta = (delta: string) => streamingBus.emit('thinking:delta', delta)
export const emitThinkingComplete = (reasoning: string) =>
  streamingBus.emit('thinking:complete', reasoning)
export const emitCompressionEvent = (event: {
  phase: 'start' | 'complete'
  mode?: 'llm' | 'fallback' | 'skip'
  droppedGroups?: number
  droppedContentChars?: number
  summaryChars?: number
  latencyMs?: number
}) => streamingBus.emit('compression:event', event)
export const emitToolStart = (toolCall: { name: string; args: string; id: string }) =>
  streamingBus.emit('tool:start', toolCall)
export const emitToolDelta = (delta: string) => streamingBus.emit('tool:delta', delta)
export const emitToolComplete = () => streamingBus.emit('tool:complete')
export const emitStatusChange = (status: string) => streamingBus.emit('status:change', status)
export const emitComplete = () => streamingBus.emit('complete')
export const emitError = (error: string) => streamingBus.emit('error', error)
