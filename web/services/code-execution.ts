import { TOOL_BINDINGS_SETUP } from '@creatorweave/shared/code-tool-bindings'
import {
  CODE_OUTPUT_SETUP, CODE_OUTPUT_MAX_BYTES, CODE_OUTPUT_MAX_ITEMS,
  isOutputPart, type OutputPart, type CodeRunResult,
} from '@creatorweave/shared/code-output'
import { DEFAULT_LIMITS, jsonText, type JsonValue, type RuntimeBindings } from '@creatorweave/quickjs-runtime'
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

/**
 * Blocking subagent orchestration exposed to the guest as `agent(prompt, opts)`.
 *
 * Distinct from `tools.spawn_subagent`, which only queues work and returns a
 * receipt: this one resolves with the child's final content so scripts can
 * branch on it. Replay (when a run key was supplied) is handled host-side.
 */
export interface CodeAgentHost {
  run(prompt: string, options?: JsonValue, signal?: AbortSignal): Promise<JsonValue>
}

/** Appended after CODE_OUTPUT_SETUP so the guest keeps its console binding. */
const AGENT_BINDING_SETUP = `
globalThis.agent = (prompt, options) => agentCall(prompt, options == null ? {} : options);
`

/**
 * Determinism guard, applied only to replayable runs: a replay must feed
 * identical agent() inputs, so the guest passes time and randomness explicitly.
 *
 * Values are REPLACED rather than proxied — a Proxy leaves the original object
 * reachable through Reflect/Object.getOwnPropertyDescriptor, which made the
 * guard a one-liner bypass. Replacements are non-configurable, so the guest
 * cannot put the real clock back either.
 */
const REPLAY_GUARD_SETUP = `
const __replayGuard = 'Date, Math.random and performance.now are disabled in replayable scripts; pass time and randomness as arguments';
const __blocked = () => { throw new Error(__replayGuard); };
(() => {
  const copy = {};
  for (const key of Object.getOwnPropertyNames(Math)) {
    if (key !== 'random') Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(Math, key));
  }
  Object.defineProperty(globalThis, 'Math', { value: Object.freeze(copy), writable: false, configurable: false });
})();
(() => {
  const RealDate = Date;
  // Parsing and UTC conversion depend only on their arguments; only the clock
  // (no-argument construction and Date.now) is blocked.
  const GuardedDate = function (...args) { if (args.length === 0) __blocked(); return new RealDate(...args); };
  RealDate.prototype.constructor = GuardedDate;
  GuardedDate.prototype = RealDate.prototype;
  GuardedDate.now = __blocked;
  GuardedDate.parse = RealDate.parse;
  GuardedDate.UTC = RealDate.UTC;
  Object.freeze(GuardedDate);
  Object.defineProperty(globalThis, 'Date', { value: GuardedDate, writable: false, configurable: false });
})();
Object.defineProperty(globalThis, 'performance', { value: Object.freeze({ now: __blocked }), writable: false, configurable: false });
`

/**
 * Agent steps wait on a whole subagent turn, so the host-call budget must cover
 * them (every host call, including agentCall, costs one). The wall clock is NOT
 * raised here: `agentCall` pushes the deadline when it actually runs, so a
 * tools-only script keeps the default ceiling instead of holding the turn for
 * half an hour.
 */
const AGENT_LIMITS = {
  ...DEFAULT_LIMITS,
  maxHostCalls: Math.max(DEFAULT_LIMITS.maxHostCalls, 264),
}

/** Wall clock granted per agent() step, applied on entry. */
const AGENT_STEP_TIMEOUT_MS = 10 * 60_000

/** Executes tools and constructs JSON output without owning any conversation. */
export async function executeToolCode(
  code: string, tools: CodeToolCapabilities, signal: AbortSignal, callId: string,
  agentHost?: CodeAgentHost, replay?: boolean, inputs?: JsonValue,
): Promise<{ result: CodeRunResult; calls: CodeToolTrace[] }> {
  const calls: CodeToolTrace[] = []
  const output: OutputPart[] = []
  let outputBytes = 0
  let traceChars = 0
  let closed = false
  // Named so host functions can reach the runtime controls the client installs
  // on this object (extendTimeout).
  const bindings: RuntimeBindings = {
    // `inputs` carries caller-supplied data (dates, seeds, ids) into the guest
    // so a replayable script never has to derive them itself.
    globals: { toolNames: tools.names, inputs: inputs ?? null },
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
      ...(agentHost
        ? {
            agentCall: async (args: JsonValue[], callSignal: AbortSignal) => {
              if (closed) throw new Error('Execution already ended')
              callSignal?.throwIfAborted?.()
              // Each step may legitimately block for minutes; the runtime turns
              // this into a moving deadline (CPU/host-call budgets unchanged).
              bindings.extendTimeout?.(AGENT_STEP_TIMEOUT_MS)
              const [prompt, options] = args
              if (typeof prompt !== 'string') throw new Error('agent(prompt, options?) — prompt must be a string')
              return await agentHost.run(prompt, options === undefined ? undefined : options, callSignal) as JsonValue
            },
          }
        : {}),
    },
  }
  const execution = await executeCode(
    {
      code,
      filename: 'run_code.js',
      setup:
        TOOL_BINDINGS_SETUP + CODE_OUTPUT_SETUP +
        (agentHost ? AGENT_BINDING_SETUP : '') +
        (agentHost && replay ? REPLAY_GUARD_SETUP : ''),
      limits: agentHost ? AGENT_LIMITS : DEFAULT_LIMITS,
    },
    bindings,
    signal,
  )
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
