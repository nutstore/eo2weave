import { convertJsonSchemaToZod } from 'zod-from-json-schema'
import { isToolAllowedInMode } from '@/agent/agent-mode'
import type { AgentMode } from '@/agent/agent-mode'
import type { AgentCallbacks, AgentLoopConfig } from '@/agent/loop/types'
import type { ToolRegistry } from '@/agent/tool-registry'
import { executeToolWithTimeout, normalizeToolResult } from '@/agent/loop/tool-execution'
import { getToolPolicy } from '@/agent/policy-engine'
import { notifyOtherToolCall } from '@/agent/tools/loop-guard'
import { isToolEnvelopeV2 } from '@/agent/tools/tool-envelope'
import type { ToolContext } from '@/agent/tools/tool-types'

export interface ToolInvocation {
  toolName: string
  toolCallId: string
  args: Record<string, unknown>
  context: ToolContext
  parentCallId?: string
  /** Rewrites the raw result before normalization and afterToolCall (e.g. truncation). */
  prepareResult?: (raw: string) => string | Promise<string>
}

export interface InvocationOutcome {
  /** Unmodified tool output. */
  raw: string
  /** Output after prepareResult; what presentation was derived from. */
  prepared: string
  value: unknown
  isError: boolean
  presentation: ReturnType<typeof normalizeToolResult>
}

/** Mode checks, argument validation, hooks, timeout and post-processing shared by direct and nested calls. */
export interface ToolInvocationInput {
  toolRegistry: Pick<ToolRegistry, 'getToolDefinitionsForMode' | 'execute'>
  mode: AgentMode
  callbacks?: Pick<AgentCallbacks, 'onToolCallStart' | 'onToolCallComplete'>
  beforeToolCall?: AgentLoopConfig['beforeToolCall']
  afterToolCall?: AgentLoopConfig['afterToolCall']
  getAbortSignal: () => AbortSignal | undefined
  toolExecutionTimeout: number
  toolTimeoutExemptions: Set<string>
  /** Caller-owned capability scope, rechecked for every nested invocation. */
  allowedToolNames?: () => readonly string[]
  /** Optional consumer observation; the execution service never writes conversation state. */
  onResult?: (call: ToolInvocation, outcome: InvocationOutcome) => void | Promise<void>
}

export async function invokeTool(
  input: ToolInvocationInput,
  call: ToolInvocation
): Promise<InvocationOutcome> {
  const { toolName, toolCallId, args } = call
  const toolCall = {
    id: toolCallId,
    type: 'function' as const,
    function: { name: toolName, arguments: JSON.stringify(args) },
  }
  if (call.parentCallId) input.callbacks?.onToolCallStart?.(toolCall)
  let raw = ''
  let prepared: string
  let presentation: ReturnType<typeof normalizeToolResult>
  try {
    const { getCurrentWorkspaceAgentMode } = await import('@/store/workspace-preferences.store')
    const currentMode = getCurrentWorkspaceAgentMode()
    if (!isToolAllowedInMode(toolName, input.mode) || !isToolAllowedInMode(toolName, currentMode)) {
      throw new Error(
        `Tool "${toolName}" is not available in plan mode. Switch to Act mode to use it.`
      )
    }
    const definitions = input.toolRegistry.getToolDefinitionsForMode(input.mode)
    const definition = definitions.find((def) => def.function.name === toolName)
    if (input.allowedToolNames && !input.allowedToolNames().includes(toolName))
      throw new Error(`Tool unavailable: ${toolName}`)
    if (!definition) {
      throw new Error(`Tool "${toolName}" is no longer available`)
    }
    if (definition.function.parameters) {
      const validation = convertJsonSchemaToZod(
        definition.function.parameters as unknown as Parameters<typeof convertJsonSchemaToZod>[0]
      ).safeParse(args)
      if (!validation.success)
        throw new Error(`Invalid arguments for ${toolName}: ${validation.error.message}`)
    }
    const before = await input.beforeToolCall?.({ toolName, toolCallId, args })
    if (before?.block) throw new Error(before.reason || 'Tool execution was blocked by policy.')

    const isRunCode = toolName === 'run_code'
    const codeToolNames = isRunCode
      ? definitions.map((def) => def.function.name).filter((name) => name !== 'run_code' && (!input.allowedToolNames || input.allowedToolNames().includes(name)))
      : []
    const execute = (abortSignal: AbortSignal) => {
      abortSignal.throwIfAborted()
      return input.toolRegistry.execute(toolName, args, {
        ...call.context,
        agentMode: currentMode,
        abortSignal,
        currentToolCallId: toolCallId,
        codeTools: isRunCode
          ? {
              names: codeToolNames,
              invoke: (nested) => {
                if (!codeToolNames.includes(nested.toolName))
                  throw new Error(`Tool unavailable: ${nested.toolName}`)
                return invokeTool(input, {
                  ...nested,
                  parentCallId: toolCallId,
                  context: { ...call.context, abortSignal: nested.signal, codeTools: undefined },
                })
              },
            }
          : undefined,
      })
    }

    if (isRunCode) {
      // run_code owns cancellation so its partial JSON output can be finalized.
      const signals = [input.getAbortSignal(), call.context.abortSignal].filter(
        (s): s is AbortSignal => !!s
      )
      raw = await execute(AbortSignal.any(signals))
    } else {
      let timeoutMs: number | null = input.toolExecutionTimeout
      if (input.toolTimeoutExemptions.has(toolName) || getToolPolicy(toolName).level === 'prompt')
        timeoutMs = null
      else if (typeof args.timeout === 'number' && args.timeout > 0)
        timeoutMs = Math.min(args.timeout, 300_000)
      raw = await executeToolWithTimeout({
        toolName,
        args,
        timeoutMs,
        runAbortSignal: input.getAbortSignal(),
        externalAbortSignal: call.context.abortSignal,
        execute,
      })
    }

    prepared = call.prepareResult ? await call.prepareResult(raw) : raw
    const normalized = normalizeToolResult(prepared)
    const patched = await input.afterToolCall?.({ toolName, toolCallId, args, ...normalized })
    presentation = {
      content: patched?.content ?? normalized.content,
      details: patched?.details ?? normalized.details,
      isError: patched?.isError ?? normalized.isError,
    }
  } finally {
    if (call.parentCallId) input.callbacks?.onToolCallComplete?.(toolCall, raw)
    if (toolName !== 'read' && toolName !== 'search') notifyOtherToolCall(call.context)
  }
  const parsed = presentation.details.parsed
  const outcome: InvocationOutcome = {
    raw,
    prepared,
    value: isToolEnvelopeV2(parsed) && parsed.ok ? parsed.data : (parsed ?? raw),
    isError: presentation.isError,
    presentation,
  }
  await input.onResult?.(call, outcome)
  return outcome
}
