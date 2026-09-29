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
}

export interface InvocationOutcome {
  raw: string
  value: unknown
  isError: boolean
  deferred: DeferredContext[]
  presentation: ReturnType<typeof normalizeToolResult>
}

/** Shared execution path. Presentation budgets are applied by the caller. */
export async function invokeTool(input: BuildAgentToolsInput, call: ToolInvocation): Promise<InvocationOutcome> {
  const { toolName, toolCallId, args } = call
  const collector = createContextCollector(toolCallId)
  let raw = ''
  let presentation: ReturnType<typeof normalizeToolResult> | null = null
  try {
    const { getCurrentWorkspaceAgentMode } = await import('@/store/workspace-preferences.store')
    const currentMode = getCurrentWorkspaceAgentMode()
    if (!isToolAllowedInMode(toolName, input.mode) || !isToolAllowedInMode(toolName, currentMode)) {
      throw new Error(`Tool "${toolName}" is not available in plan mode. Switch to Act mode to use it.`)
    }
    if (!input.toolRegistry.getToolDefinitionsForMode(input.mode).some(def => def.function.name === toolName)) {
      throw new Error(`Tool "${toolName}" is no longer available`)
    }
    const before = await input.beforeToolCall?.({ toolName, toolCallId, args })
    if (before?.block) throw new Error(before.reason || 'Tool execution was blocked by policy.')
    let timeoutMs: number | null = input.toolExecutionTimeout
    if (input.toolTimeoutExemptions.has(toolName) || getToolPolicy(toolName).level === 'prompt') timeoutMs = null
    else if (typeof args.timeout === 'number' && args.timeout > 0) timeoutMs = Math.min(args.timeout, 300_000)
    raw = await executeToolWithTimeout({
      toolName, args, timeoutMs,
      runAbortSignal: input.getAbortSignal(),
      externalAbortSignal: call.context.abortSignal,
      execute: abortSignal => {
        abortSignal.throwIfAborted()
        return input.toolRegistry.execute(toolName, args, {
          ...call.context, agentMode: currentMode, abortSignal,
          currentToolCallId: toolCallId, deferContext: collector.emit,
        })
      },
    })
    const normalized = normalizeToolResult(raw)
    const patched = await input.afterToolCall?.({ toolName, toolCallId, args, ...normalized })
    presentation = {
      content: patched?.content ?? normalized.content,
      details: patched?.details ?? normalized.details,
      isError: patched?.isError ?? normalized.isError,
    }
  } catch (error) {
    const deferred = collector.close()
    if (!deferred.length) throw error
    raw = JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    return { raw, value: null, isError: true, deferred, presentation: normalizeToolResult(raw) }
  } finally {
    if (toolName !== 'read' && toolName !== 'search') notifyOtherToolCall(call.context)
  }
  const normalized = presentation ?? normalizeToolResult(raw)
  const parsed = normalized.details.parsed
  const value = isToolEnvelopeV2(parsed) && parsed.ok ? parsed.data : parsed ?? raw
  return { raw, value, isError: normalized.isError, deferred: collector.close(), presentation: normalized }
}
