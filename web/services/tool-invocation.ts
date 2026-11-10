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
  /** Folder-less conversation: folder-dependent tools are unavailable even by direct name. */
  directMode?: boolean
  callbacks?: Pick<AgentCallbacks, 'onToolCallStart' | 'onToolCallComplete' | 'onToolTimeout'>
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
    const definitions = input.toolRegistry.getToolDefinitionsForMode(input.mode, { directMode: input.directMode })
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
      // Task controls authorize inside mcp_tasks; allow time for that confirmation.
      const timeoutPolicyTool = toolName === 'mcp_tasks' && (args.action === 'cancel' || args.action === 'resume')
        ? 'mcp_task_control'
        : toolName
      if (input.toolTimeoutExemptions.has(toolName) || getToolPolicy(timeoutPolicyTool).level === 'prompt')
        timeoutMs = null
      else if (typeof args.timeout === 'number' && args.timeout > 0)
        timeoutMs = Math.min(args.timeout, 300_000)
      // Only WebMCP tools produce a structured CALL_CANCELLED envelope on a
      // lost abort race (#148 review round 7: non-WebMCP tools pay a useless
      // 2-second grace wait for an envelope they can never emit; round 8:
      // MCP-backed `call_tool` must skip it too — it never emits envelopes).
      // WebMCP full names are origin-derived and ALWAYS contain the `__`
      // separator (`https_host_com__tool`, see tool-name.ts); MCP-backed
      // names are `serverId:toolName` where serverId is constrained to
      // [a-z0-9-] (mcp.repository validateServerId), so it can never contain
      // `__`. The `https_` prefix check is the primary discriminator — the
      // origin normalization maps `https://host` to `https_host` — with the
      // `__` check as a fallback for non-https origins.
      const fullToolNameArg = typeof args.full_tool_name === 'string' ? args.full_tool_name : ''
      const isWebMCPInvocation = toolName === 'call_tool' &&
        (/^https_/.test(fullToolNameArg) || fullToolNameArg.includes('__'))
      if (toolName === 'mcp_tasks' && args.action === 'wait' && timeoutMs !== null) {
        // The outer deadline must leave room for the bounded local wait to return.
        const seconds = typeof args.seconds === 'number' && Number.isFinite(args.seconds)
          ? Math.min(30, Math.max(0, args.seconds))
          : 10
        timeoutMs = Math.max(timeoutMs, seconds * 1000 + 5000)
      }
      raw = await executeToolWithTimeout({
        toolName,
        args,
        timeoutMs,
        runAbortSignal: input.getAbortSignal(),
        externalAbortSignal: call.context.abortSignal,
        execute,
        // The timeout notification must fire even when a CALL_CANCELLED
        // envelope settles within the grace window and REPLACES the timeout
        // rejection (#148 review round 8: the envelope-fallback return
        // skipped build-agent-tools' timeout catch, so onToolTimeout was
        // never called). The hook fires at most once, on the timeout loss
        // itself, so the ordinary rejection path never duplicates it.
        onTimeout: () => input.callbacks?.onToolTimeout?.(toolCall),
        // A WebMCP call that loses the abort/timeout race resolves moments
        // later with a structured CALL_CANCELLED envelope (non-retryable +
        // "the page may still change" warning). Prefer that envelope over
        // the generic abort/timeout rejection so the model never loses the
        // warning (#139 review: cancellation warning gets lost).
        preferEnvelopeOnRaceLoss: isWebMCPInvocation
          ? (envelope) => {
              try {
                const parsed = JSON.parse(envelope) as {
                  ok?: boolean
                  error?: { code?: string }
                }
                if (parsed?.ok === false && parsed?.error?.code === 'CALL_CANCELLED') {
                  return envelope
                }
              } catch { /* not JSON — keep the plain rejection */ }
              return null
            }
          : undefined,
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
