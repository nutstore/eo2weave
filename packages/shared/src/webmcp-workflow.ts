import type { JsonSchema } from './webmcp-schema'

export type InspectResult = { status: 'ready' } | { status: 'blocked'; message: string }
export interface WorkflowContext {
  input: unknown
  state: Record<string, unknown>
  target: { tabId: number; url: string } | null
}
export interface WorkflowStep {
  description: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  inspect(context: WorkflowContext): InspectResult | Promise<InspectResult>
  run(context: WorkflowContext): unknown | Promise<unknown>
}
export type WorkflowResult =
  | { status: 'completed'; result: unknown }
  | { status: 'blocked'; step: number; description: string; message: string }
