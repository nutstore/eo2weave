import { createSchemaValidator, assertSchemaValue, type JsonSchema } from './webmcp-schema'

export type InspectResult = { status: 'ready' } | { status: 'blocked'; message: string }
export interface WorkflowContext {
  input: unknown
  state: Record<string, unknown>
  signal: AbortSignal
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

/** Prepare contracts once per registration; every call owns its input and state. */
export function createWorkflow(steps: WorkflowStep[]) {
  if (!steps.length) throw new Error('Workflow must contain at least one step')
  const contracts = steps.map((step, index) => ({
    input: createSchemaValidator(step.inputSchema, `Step ${index + 1} inputSchema`),
    output: createSchemaValidator(step.outputSchema, `Step ${index + 1} outputSchema`),
  }))
  return async (input: unknown, signal: AbortSignal): Promise<WorkflowResult> => {
    const context: WorkflowContext = { input, state: {}, signal }
    for (const [index, step] of steps.entries()) {
      signal.throwIfAborted()
      assertSchemaValue(contracts[index].input, context.input, `Step ${index + 1} input`)
      const inspection = await step.inspect(context)
      signal.throwIfAborted()
      if (inspection?.status === 'blocked' && typeof inspection.message === 'string' && inspection.message.trim()) {
        return { status: 'blocked', step: index + 1, description: step.description, message: inspection.message }
      }
      if (inspection?.status !== 'ready') throw new Error(`Step ${index + 1}: inspect must return ready or blocked with a message`)
      const result = (await step.run(context)) ?? null
      signal.throwIfAborted()
      assertSchemaValue(contracts[index].output, result, `Step ${index + 1} output`)
      context.input = result
    }
    return { status: 'completed', result: context.input }
  }
}
