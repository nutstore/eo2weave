import { convertJsonSchemaToZod } from 'zod-from-json-schema'
import { projectTools } from '@/agent/tool-projection'
import { isToolAllowedInMode } from '@/agent/agent-mode'
import { createContextCollector, type DeferredContext } from '@/agent/deferred-context'
import type { BuildAgentToolsInput } from '@/agent/loop/build-agent-tools'
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
  onContext?: (event: DeferredContext) => void
  parentCallId?: string
}

export interface InvocationOutcome {
  raw: string
  value: unknown
  isError: boolean
  deferred: DeferredContext[]
  presentation: ReturnType<typeof normalizeToolResult>
}

/** Shared execution path. Presentation budgets are applied by the caller. */
export async function invokeTool(
  input: BuildAgentToolsInput,
  call: ToolInvocation
): Promise<InvocationOutcome> {
  const { toolName, toolCallId, args } = call
  const collector = createContextCollector(toolCallId)
  let eventSequence = 0
  const emit = (content: import('@/agent/deferred-context').ContextPart[]) => {
    if (!collector.emit(content)) return
    call.onContext?.({
      sourceCallId: toolCallId,
      sequence: eventSequence++,
      content: structuredClone(content),
    })
  }
  const toolCall = {
    id: toolCallId,
    parentToolCallId: call.parentCallId,
    type: 'function' as const,
    function: { name: toolName, arguments: JSON.stringify(args) },
  }
  if (call.parentCallId) input.callbacks?.onToolCallStart?.(toolCall)
  let raw = ''
  let presentation: ReturnType<typeof normalizeToolResult> | null = null
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
    const names = projectTools(definitions).codeTools.map((def) => def.function.name)
    const before = await input.beforeToolCall?.({ toolName, toolCallId, args })
    if (before?.block) throw new Error(before.reason || 'Tool execution was blocked by policy.')
    let timeoutMs: number | null = input.toolExecutionTimeout
    if (
      toolName === 'run_code' ||
      input.toolTimeoutExemptions.has(toolName) ||
      getToolPolicy(toolName).level === 'prompt'
    )
      timeoutMs = null
    else if (typeof args.timeout === 'number' && args.timeout > 0)
      timeoutMs = Math.min(args.timeout, 300_000)
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
        codeTools:
          toolName === 'run_code'
            ? {
                names,
                invoke: (nested) => {
                  if (!names.includes(nested.toolName))
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
    // run_code owns cancellation and must finish collecting context before the
    // outer result is committed. A racing abort would discard that context.
    const signals = [input.getAbortSignal(), call.context.abortSignal].filter(
      (s): s is AbortSignal => !!s
    )
    raw =
      toolName === 'run_code'
        ? await execute(AbortSignal.any(signals))
        : await executeToolWithTimeout({
            toolName,
            args,
            timeoutMs,
            runAbortSignal: input.getAbortSignal(),
            externalAbortSignal: call.context.abortSignal,
            execute,
          })
    let elicitationData: {
      mode: 'binary'
      message: string
      toolName: string
      args: Record<string, unknown>
      serverId: string
    } | null = null
    try {
      const parsedResult = JSON.parse(raw)
      if (parsedResult._elicitation?.mode === 'binary') {
        elicitationData = parsedResult._elicitation
      }
    } catch {
      // non-json tool output
    }

    if (elicitationData && input.callbacks?.onElicitation) {
      console.warn('[#LoopStop] elicitation_detected', {
        toolCallId,
        toolName: elicitationData.toolName,
        serverId: elicitationData.serverId,
      })
      input.callbacks.onElicitation({
        ...elicitationData,
        toolCallId,
      })
      input.onElicitationDetected?.()
    }

    if (toolName === 'run_python' && raw) {
      try {
        const parsedResult = JSON.parse(raw)
        if (parsedResult.fileChanges) {
          const { useConversationContextStore } = await import('@/store/conversation-context.store')
          useConversationContextStore.getState().addChanges(parsedResult.fileChanges)
        }
      } catch {
        // ignore non-json outputs
      }
    }

    const normalized = normalizeToolResult(raw)
    const patched = await input.afterToolCall?.({ toolName, toolCallId, args, ...normalized })
    presentation = {
      content: patched?.content ?? normalized.content,
      details: patched?.details ?? normalized.details,
      isError: patched?.isError ?? normalized.isError,
    }
  } catch (error) {
    const deferred = collector.close()
    if (!deferred.length) {
      raw = JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      throw error
    }
    raw = JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    return { raw, value: null, isError: true, deferred, presentation: normalizeToolResult(raw) }
  } finally {
    if (call.parentCallId) input.callbacks?.onToolCallComplete?.(toolCall, raw)
    if (toolName !== 'read' && toolName !== 'search') notifyOtherToolCall(call.context)
  }
  const normalized = presentation ?? normalizeToolResult(raw)
  const parsed = normalized.details.parsed
  const value = isToolEnvelopeV2(parsed) && parsed.ok ? parsed.data : (parsed ?? raw)
  return {
    raw,
    value,
    isError: normalized.isError,
    deferred: collector.close(),
    presentation: normalized,
  }
}
