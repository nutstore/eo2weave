import { executeToolCode } from '@/services/code-execution'
import { toolErrorJson, toolOkJson } from './tool-envelope'
import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'

export type { CodeToolTrace } from '@/services/code-execution'
export const RUN_CODE_TOOL = 'run_code'

export const runCodeDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: RUN_CODE_TOOL,
    description: [
      'Execute an async JavaScript function body to combine available tools and process their results.',
      'purpose and code are required. Top-level await and return work; TypeScript and imports do not.',
      'Call await tools.name(args) or await tools["tool-name"](args), using the same argument schemas as direct tools.',
      'Direct tools remain available. run_code cannot call itself.',
      'Successful tools return envelope data, otherwise parsed JSON or text. Failed tools reject with code and toolName.',
      'Return JSON data. text(value), image(imageBlock) and console.log append explicit output to this execution result. Intermediate images are not forwarded automatically. Use output.forward(child.output) to forward a child result deliberately.',
      'Await all work that must complete; unfinished calls are canceled on exit and may already have side effects. No DOM, fetch, timers or persistent globals.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        purpose: {
          type: 'string',
          minLength: 1,
          description: 'A concise explanation of this execution, in the user’s language.',
        },
        code: { type: 'string', minLength: 1, description: 'Async JavaScript function body.' },
      },
      required: ['purpose', 'code'],
    },
  },
}

/** Drops UI-only traces from the model-facing result. */
export function stripRunCodeTrace(raw: string): string {
  try {
    const response = JSON.parse(raw)
    delete response.meta
    return JSON.stringify(response)
  } catch {
    return raw
  }
}

export const runCodeExecutor: ToolExecutor = async (args, context) => {
  if (!context.codeTools)
    return toolErrorJson(RUN_CODE_TOOL, 'UNAVAILABLE', 'Tool invocation context is unavailable')
  const { result, calls } = await executeToolCode(
    args.code as string, context.codeTools,
    context.abortSignal ?? new AbortController().signal, context.currentToolCallId ?? 'run_code',
  )
  // Script failure is a portable result, including any output emitted before failure.
  return toolOkJson(RUN_CODE_TOOL, result, { meta: { calls } })
}

export const runCodePromptDoc: ToolPromptDoc = {
  category: 'execution',
  lines: ['- `run_code(purpose, code)` — Combine tools with async JavaScript. Explicitly emit images using `image(result)` or `image(result.image)`; return JSON and use `text(value)` or `console.log` for text output.'],
}
