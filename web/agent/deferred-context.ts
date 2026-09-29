/** Invocation-owned context; never shared between callers or executions. */
export type ContextPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface DeferredContext {
  sourceCallId: string
  sequence: number
  content: ContextPart[]
}

export function createContextCollector(sourceCallId: string) {
  const events: DeferredContext[] = []
  let closed = false
  let bytes = 0
  return {
    emit(content: ContextPart[]) {
      if (closed) return false
      const copy = structuredClone(content)
      bytes += new TextEncoder().encode(JSON.stringify(copy)).byteLength
      if (bytes > 16 * 1024 * 1024) throw new Error('Deferred context exceeds 16 MiB')
      events.push({ sourceCallId, sequence: events.length, content: copy })
      return true
    },
    close(): DeferredContext[] {
      closed = true
      return events.slice()
    },
  }
}
