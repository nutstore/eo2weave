/** Page-side workflow contract. Each invocation owns its state. */
export type InspectResult = { status: 'ready' } | { status: 'blocked'; message: string }
export interface WorkflowContext {
  args: Record<string, unknown>
  state: Record<string, unknown>
  signal: AbortSignal
}
export interface WorkflowStep {
  description: string
  inspect(context: WorkflowContext): InspectResult | Promise<InspectResult>
  run(context: WorkflowContext): unknown | Promise<unknown>
}
export type WorkflowResult =
  | { status: 'completed'; result: unknown }
  | { status: 'blocked'; step: number; description: string; message: string }

export async function runWorkflow(
  steps: WorkflowStep[], args: Record<string, unknown>, signal: AbortSignal,
): Promise<WorkflowResult> {
  const context: WorkflowContext = { args, state: {}, signal }
  let result: unknown = null
  for (const [index, step] of steps.entries()) {
    signal.throwIfAborted()
    const inspection = await step.inspect(context)
    signal.throwIfAborted()
    if (inspection?.status === 'blocked' && typeof inspection.message === 'string' && inspection.message.trim()) {
      return { status: 'blocked', step: index + 1, description: step.description, message: inspection.message }
    }
    if (inspection?.status !== 'ready') throw new Error(`Step ${index + 1}: inspect must return ready or blocked with a message`)
    result = await step.run(context)
    signal.throwIfAborted()
  }
  return { status: 'completed', result: result ?? null }
}
