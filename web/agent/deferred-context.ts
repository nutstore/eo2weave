/** Historical message metadata only. New executions use explicit JSON output. */
export type ContextPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface DeferredContext {
  sourceCallId: string
  sequence: number
  content: ContextPart[]
}
