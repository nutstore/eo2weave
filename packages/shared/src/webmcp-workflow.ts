import type { Node } from '@creatorweave/behavior-tree'
import type { JsonSchema } from './webmcp-schema'

export interface WorkflowContext {
  input: unknown
  state: Record<string, unknown>
  target: { tabId: number; url: string } | null
}
export interface WorkflowDefinition {
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  tree: WorkflowNode
  result(context: WorkflowContext): unknown | Promise<unknown>
}
/** Serialized tool sources may omit the wait interval (defaults to zero). */
export type WorkflowNode = (
  | Extract<Node<WorkflowContext>, { type: 'action' | 'condition' }>
  | { type: 'wait'; inspect(context: WorkflowContext): boolean | Promise<boolean>; intervalMs?: number; timeoutMs?: number }
  | { type: 'sequence' | 'selector'; children: readonly WorkflowNode[] }
) & { description?: string }
export type WorkflowResult =
  | { status: 'success'; result: unknown }
  | { status: 'failure' }
