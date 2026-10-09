import { TOOL_BINDINGS_SETUP } from '@creatorweave/shared/code-tool-bindings'
import {
  CODE_OUTPUT_SETUP, CODE_OUTPUT_MAX_BYTES, CODE_OUTPUT_MAX_ITEMS,
  isOutputPart, type OutputPart, type CodeRunResult,
} from '@creatorweave/shared/code-output'
import { DEFAULT_LIMITS, jsonText, type JsonValue } from '@creatorweave/quickjs-runtime'
import { executeCode } from '@/runtime/quickjs/client'
import { isToolEnvelopeV2 } from '@/agent/tools/tool-envelope'
import type { InvocationOutcome } from '@/services/tool-invocation'

export interface CodeToolTrace {
  id: string
  name: string
  args: Record<string, unknown>
  status: 'running' | 'completed' | 'failed' | 'canceled'
  result: string
}

export interface CodeToolCapabilities {
  names: string[]
  invoke(call: {
    toolName: string; toolCallId: string; args: Record<string, unknown>; signal: AbortSignal
  }): Promise<InvocationOutcome>
}

/** Executes tools and constructs JSON output without owning any conversation. */
export async function executeToolCode(
  code: string, tools: CodeToolCapabilities, signal: AbortSignal, callId: string,
): Promise<{ result: CodeRunResult; calls: CodeToolTrace[] }> {
  const calls: CodeToolTrace[] = []
  const output: OutputPart[] = []
  let outputBytes = 0
  let traceChars = 0
  let closed = false
  const execution = await executeCode({
    code, filename: 'run_code.js', limits: DEFAULT_LIMITS,
    setup: TOOL_BINDINGS_SETUP + CODE_OUTPUT_SETUP,
  }, {
    globals: { toolNames: tools.names },
    onEvent: value => {
      if (closed) return
      if (!isOutputPart(value)) throw new Error('Invalid execution output')
      const part: OutputPart = value.type === 'text'
        ? { type: 'text', text: value.text }
        : { type: 'image', data: value.data, mimeType: value.mimeType }
      const bytes = new TextEncoder().encode(jsonText(part, CODE_OUTPUT_MAX_BYTES)).byteLength
      if (output.length >= CODE_OUTPUT_MAX_ITEMS || outputBytes + bytes > CODE_OUTPUT_MAX_BYTES)
        throw Object.assign(new Error('Execution output limit exceeded'), { code: 'JS_OUTPUT_LIMIT' })
      outputBytes += bytes
      output.push(part)
    },
    functions: {
      // The output setup replaces the shared workflow's console binding.
      writeLog: async () => null,
      invokeTool: async ([name, value], callSignal) => {
        if (closed || typeof name !== 'string' || !tools.names.includes(name))
          throw new Error(`Tool unavailable: ${name}`)
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Tool arguments must be an object')
        const trace: CodeToolTrace = {
          id: `${callId}:${calls.length + 1}`, name, args: value,
          status: 'running', result: '',
        }
        calls.push(trace)
        try {
          const outcome = await tools.invoke({ toolName: name, toolCallId: trace.id, args: value, signal: callSignal })
          if (closed) throw new Error('Execution already ended')
          const remaining = Math.max(0, 2 * 1024 * 1024 - traceChars)
          trace.result = outcome.raw.length <= remaining ? outcome.raw : outcome.raw.slice(0, remaining) + '\n[Execution trace truncated]'
          traceChars += outcome.raw.length
          trace.status = outcome.isError ? 'failed' : 'completed'
          if (outcome.isError) {
            const parsed = outcome.presentation.details.parsed
            const detail = isToolEnvelopeV2(parsed) && !parsed.ok
              ? parsed.error : { code: 'TOOL_FAILED', message: outcome.presentation.content }
            throw Object.assign(new Error(detail.message), detail, { toolName: name })
          }
          return outcome.value as JsonValue
        } catch (error) {
          if (!closed) {
            trace.status = 'failed'
            if (!trace.result) trace.result = JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
          }
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { toolName: name })
        }
      },
    },
  }, signal)
  closed = true
  for (const call of calls) if (call.status === 'running') {
    call.status = 'canceled'
    call.result = 'Execution ended before completion; side effects may have occurred'
  }
  let result: CodeRunResult = execution.ok
    ? { ok: true, value: execution.value, output }
    : { ok: false, error: execution.error, output }
  try {
    jsonText(result, DEFAULT_LIMITS.maxTransferBytes)
  } catch {
    result = { ok: false, error: { code: 'JS_RESULT_LIMIT', message: 'Execution result exceeds JSON transfer limit' }, output }
  }
  return { result, calls }
}
