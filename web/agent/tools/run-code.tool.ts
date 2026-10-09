import { TOOL_BINDINGS_SETUP } from '@creatorweave/shared/code-tool-bindings'
import { executeCode } from '@/runtime/quickjs/client'
import { DEFAULT_LIMITS, type JsonValue } from '@creatorweave/quickjs-runtime'
import { toolErrorJson, toolOkJson, isToolEnvelopeV2 } from '@/agent/tools/tool-envelope'
import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from '@/agent/tools/tool-types'
import type { ContextPart, DeferredContext } from '@/agent/deferred-context'

export const RUN_CODE_TOOL = 'run_code'

const MAX_TRACE_CHARS = 2 * 1024 * 1024
const MAX_LOG_BYTES = 64 * 1024

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
      'Return JSON data or use console.log. Intermediate tool results stay out of model context; images and explicit deferred context are attached automatically.',
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

export interface CodeToolTrace {
  id: string
  name: string
  args: Record<string, unknown>
  status: 'running' | 'completed' | 'failed' | 'canceled'
  result: string
}

/** Drops UI-only call traces (`meta`) from a run_code envelope before it reaches the model. */
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
  const tools = context.codeTools
  if (!tools)
    return toolErrorJson(RUN_CODE_TOOL, 'UNAVAILABLE', 'Tool invocation context is unavailable')
  // Arguments are schema-validated by invokeTool before reaching the executor.
  const code = args.code as string
  const traces: CodeToolTrace[] = []
  const deferred = new Map<number, DeferredContext[]>()
  const logs: string[] = []
  let logBytes = 0
  let traceChars = 0
  const traceText = (value: string) => {
    const remaining = Math.max(0, MAX_TRACE_CHARS - traceChars)
    traceChars += value.length
    return value.length <= remaining
      ? value
      : value.slice(0, remaining) + '\n[Execution trace truncated]'
  }
  let closed = false
  const signal = context.abortSignal ?? new AbortController().signal
  const result = await executeCode(
    {
      code,
      filename: 'run_code.js',
      limits: DEFAULT_LIMITS,
      setup: TOOL_BINDINGS_SETUP,
    },
    {
      globals: { toolNames: tools.names },
      functions: {
        invokeTool: async ([name, value], callSignal) => {
          if (closed || typeof name !== 'string') throw new Error(`Tool unavailable: ${name}`)
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('Tool arguments must be an object')
          const sequence = traces.length
          const trace: CodeToolTrace = {
            id: `${context.currentToolCallId}:${sequence + 1}`,
            name,
            args: value,
            status: 'running',
            result: '',
          }
          traces.push(trace)
          try {
            const outcome = await tools.invoke({
              toolName: name,
              toolCallId: trace.id,
              args: value,
              signal: callSignal,
              onContext: (event) => {
                if (!closed) deferred.set(sequence, [...(deferred.get(sequence) ?? []), event])
              },
            })
            if (closed) throw new Error('Execution already ended')
            trace.result = traceText(outcome.raw)
            trace.status = outcome.isError ? 'failed' : 'completed'
            if (outcome.isError) {
              const parsed = outcome.presentation.details.parsed
              const detail =
                isToolEnvelopeV2(parsed) && !parsed.ok
                  ? parsed.error
                  : { code: 'TOOL_FAILED', message: outcome.presentation.content }
              throw Object.assign(new Error(detail.message), { ...detail, toolName: name })
            }
            // Attach nested images to the run_code result so the model can see them.
            const parsed = outcome.presentation.details.parsed as
              | { contentParts?: ContextPart[] }
              | undefined
            if (parsed?.contentParts?.some((part) => part.type === 'image')) {
              const events = deferred.get(sequence) ?? []
              events.push({ sourceCallId: trace.id, sequence: events.length, content: parsed.contentParts })
              deferred.set(sequence, events)
            }
            return outcome.value as JsonValue
          } catch (error) {
            if (!closed) {
              trace.status = 'failed'
              if (!trace.result)
                trace.result = JSON.stringify({
                  error: error instanceof Error ? error.message : String(error),
                })
            }
            throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
              toolName: name,
            })
          }
        },
        writeLog: async ([value]) => {
          if (closed) return null
          const text = String(value)
          logBytes += new TextEncoder().encode(text).byteLength
          if (logBytes <= MAX_LOG_BYTES) logs.push(text)
          else if (logs.at(-1) !== '[Logs truncated]') logs.push('[Logs truncated]')
          return null
        },
      },
    },
    signal
  )
  closed = true
  for (const trace of traces)
    if (trace.status === 'running') {
      trace.status = 'canceled'
      trace.result = 'Execution ended before completion; side effects may have occurred'
    }
  const contexts = [...deferred.entries()].sort(([a], [b]) => a - b).flatMap(([, events]) => events)
  for (const event of contexts) context.deferContext?.(event.content)
  // `meta.calls` is the UI trace; stripRunCodeTrace removes it from model context.
  const meta = { calls: traces }
  return result.ok
    ? toolOkJson(RUN_CODE_TOOL, { value: result.value, logs }, { meta })
    : toolErrorJson(RUN_CODE_TOOL, result.error.code, result.error.message, {
        details: { logs },
        meta,
      })
}

export const runCodePromptDoc: ToolPromptDoc = {
  category: 'execution',
  lines: [
    '- `run_code(purpose, code)` — Combine tools using async JavaScript; direct tool calls remain available.',
  ],
}
