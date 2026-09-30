import { convertJsonSchemaToZod } from 'zod-from-json-schema'
import { isToolAllowedInMode } from '@/agent/agent-mode'
import {
  createContextCollector,
  type ContextPart,
  type DeferredContext,
} from '@/agent/deferred-context'
import type { BuildAgentToolsInput } from '@/agent/loop/build-agent-tools'
import { executeToolWithTimeout, normalizeToolResult } from '@/agent/loop/tool-execution'
import { getToolPolicy } from '@/agent/policy-engine'
import { notifyOtherToolCall } from '@/agent/tools/loop-guard'
import { RUN_CODE_TOOL } from '@/agent/tools/run-code.tool'
import { isToolEnvelopeV2 } from '@/agent/tools/tool-envelope'
import type { ToolContext } from '@/agent/tools/tool-types'
import type { ChangeDetectionResult } from '@/opfs/types/opfs-types'

export interface ToolInvocation {
  toolName: string
  toolCallId: string
  args: Record<string, unknown>
  context: ToolContext
  onContext?: (event: DeferredContext) => void
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
  deferred: DeferredContext[]
  presentation: ReturnType<typeof normalizeToolResult>
}

type ElicitationData = {
  mode: 'binary'
  message: string
  toolName: string
  args: Record<string, unknown>
  serverId: string
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Mode checks, argument validation, hooks, timeout and post-processing shared by direct and nested calls. */
export async function invokeTool(
  input: BuildAgentToolsInput,
  call: ToolInvocation
): Promise<InvocationOutcome> {
  const { toolName, toolCallId, args } = call
  const collector = createContextCollector(toolCallId)
  const emit = (content: ContextPart[]) => {
    const event = collector.emit(content)
    if (event) call.onContext?.(event)
  }
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

    const isRunCode = toolName === RUN_CODE_TOOL
    const codeToolNames = isRunCode
      ? definitions.map((def) => def.function.name).filter((name) => name !== RUN_CODE_TOOL)
      : []
    const execute = (abortSignal: AbortSignal) => {
      abortSignal.throwIfAborted()
      return input.toolRegistry.execute(toolName, args, {
        ...call.context,
        agentMode: currentMode,
        abortSignal,
        currentToolCallId: toolCallId,
        deferContext: emit,
        ...(call.parentCallId
          ? {
              onReadImageSuccess: (
                payload: Parameters<NonNullable<ToolContext['onReadImageSuccess']>>[0]
              ) => {
                emit(payload.contentParts)
                return true
              },
            }
          : {}),
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
      // run_code owns cancellation and must finish collecting context before the
      // outer result is committed. A racing abort would discard that context.
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

    const parsedResult = parseJson(raw)
    const elicitation = (parsedResult?._elicitation ?? null) as ElicitationData | null
    if (elicitation?.mode === 'binary' && input.callbacks?.onElicitation) {
      console.warn('[#LoopStop] elicitation_detected', {
        toolCallId,
        toolName: elicitation.toolName,
        serverId: elicitation.serverId,
      })
      input.callbacks.onElicitation({ ...elicitation, toolCallId })
      input.onElicitationDetected?.()
    }
    if (toolName === 'run_python' && parsedResult?.fileChanges) {
      try {
        const { useConversationContextStore } = await import('@/store/conversation-context.store')
        useConversationContextStore
          .getState()
          .addChanges(parsedResult.fileChanges as ChangeDetectionResult)
      } catch (error) {
        console.warn('[tool-invocation] Failed to record run_python file changes:', error)
      }
    }

    prepared = call.prepareResult ? await call.prepareResult(raw) : raw
    const normalized = normalizeToolResult(prepared)
    const patched = await input.afterToolCall?.({ toolName, toolCallId, args, ...normalized })
    presentation = {
      content: patched?.content ?? normalized.content,
      details: patched?.details ?? normalized.details,
      isError: patched?.isError ?? normalized.isError,
    }
  } catch (error) {
    raw = JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    const deferred = collector.close()
    if (!deferred.length) throw error
    return {
      raw,
      prepared: raw,
      value: null,
      isError: true,
      deferred,
      presentation: normalizeToolResult(raw),
    }
  } finally {
    if (call.parentCallId) input.callbacks?.onToolCallComplete?.(toolCall, raw)
    if (toolName !== 'read' && toolName !== 'search') notifyOtherToolCall(call.context)
  }
  const parsed = presentation.details.parsed
  return {
    raw,
    prepared,
    value: isToolEnvelopeV2(parsed) && parsed.ok ? parsed.data : (parsed ?? raw),
    isError: presentation.isError,
    deferred: collector.close(),
    presentation,
  }
}
