import { executeCode } from '@/runtime/quickjs/client'
import { DEFAULT_LIMITS, type JsonValue } from '@/runtime/quickjs/types'
import { toolErrorJson, toolOkJson, isToolEnvelopeV2 } from '@/agent/tools/tool-envelope'
import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from '@/agent/tools/tool-types'
import type { DeferredContext } from '@/agent/deferred-context'

export const runCodeDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'run_code',
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
          description: 'A concise explanation of this execution, in the user’s language.',
        },
        code: { type: 'string', description: 'Async JavaScript function body.' },
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

export const runCodeExecutor: ToolExecutor = async (args, context) => {
  if (
    typeof args.purpose !== 'string' ||
    !args.purpose.trim() ||
    typeof args.code !== 'string' ||
    !args.code.trim()
  ) {
    return toolErrorJson('run_code', 'INVALID_INPUT', 'purpose and code must be nonempty strings')
  }
  const tools = context.codeTools
  if (!tools)
    return toolErrorJson('run_code', 'UNAVAILABLE', 'Tool invocation context is unavailable')
  const traces: CodeToolTrace[] = []
  const deferred = new Map<number, DeferredContext[]>()
  const logs: string[] = []
  let logBytes = 0
  let traceChars = 0
  const traceText = (value: string) => {
    const remaining = Math.max(0, 2 * 1024 * 1024 - traceChars)
    traceChars += value.length
    return value.length <= remaining
      ? value
      : value.slice(0, remaining) + '\n[Execution trace truncated]'
  }
  let closed = false
  const signal = context.abortSignal ?? new AbortController().signal
  const result = await executeCode(
    {
      code: args.code,
      filename: 'run_code.js',
      limits: DEFAULT_LIMITS,
      setup: `
      globalThis.tools = Object.freeze(Object.fromEntries(toolNames.map(name => [name, args => invokeTool(name, args)])));
      const formatLog = value => { if (typeof value === 'string') return value; try { return JSON.stringify(value) ?? String(value); } catch { return String(value); } };
      globalThis.console = Object.freeze(Object.fromEntries(['log', 'info', 'warn', 'error'].map(name => [name, (...args) => { void writeLog(args.map(formatLog).join(' ')); }])));
    `,
    },
    {
      globals: { toolNames: tools.names },
      functions: {
        invokeTool: async ([name, value], callSignal) => {
          if (closed || typeof name !== 'string' || !tools.names.includes(name))
            throw new Error(`Tool unavailable: ${name}`)
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
            const parts = outcome.presentation.details.parsed as
              | { contentParts?: import('@/agent/deferred-context').ContextPart[] }
              | undefined
            if (parts?.contentParts?.some((part) => part.type === 'image')) {
              deferred.set(sequence, [
                ...outcome.deferred,
                {
                  sourceCallId: trace.id,
                  sequence: outcome.deferred.length,
                  content: parts.contentParts,
                },
              ])
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
          if (logBytes <= 64 * 1024) logs.push(text)
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
  const meta = { calls: traces, deferred: contexts }
  return result.ok
    ? toolOkJson('run_code', { value: result.value, logs }, { meta })
    : toolErrorJson('run_code', result.error.code, result.error.message, {
        meta: { ...meta, logs },
      })
}

export const runCodePromptDoc: ToolPromptDoc = {
  category: 'execution',
  lines: [
    '- `run_code(purpose, code)` — Combine tools using async JavaScript; direct tool calls remain available.',
  ],
}
