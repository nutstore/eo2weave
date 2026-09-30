export type ContextPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface DeferredContext {
  sourceCallId: string
  sequence: number
  content: ContextPart[]
}

const MAX_DEFERRED_BYTES = 16 * 1024 * 1024

/** Collects context emitted during one tool invocation; emissions after close() are ignored. */
export function createContextCollector(sourceCallId: string) {
  const events: DeferredContext[] = []
  const encoder = new TextEncoder()
  let closed = false
  let bytes = 0
  return {
    emit(content: ContextPart[]): DeferredContext | null {
      if (closed) return null
      const copy = structuredClone(content)
      bytes += encoder.encode(JSON.stringify(copy)).byteLength
      if (bytes > MAX_DEFERRED_BYTES) throw new Error('Deferred context exceeds 16 MiB')
      const event = { sourceCallId, sequence: events.length, content: copy }
      events.push(event)
      return event
    },
    close(): DeferredContext[] {
      closed = true
      return events.slice()
    },
  }
}
