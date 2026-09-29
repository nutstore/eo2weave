import type { AgentTool } from '@earendil-works/pi-agent-core'
import { type AgentMode } from '../agent-mode'
import { invokeTool } from '@/agent/tool-invocation'
import type { ContextManager } from '../context-manager'
import type { PiAIProvider } from '../llm/pi-ai-provider'
import type { Message, ToolCall } from '../message-types'
import type { ToolRegistry } from '../tool-registry'
import type { ToolContext } from '../tools/tool-types'
import { isToolEnvelopeV2 } from '../tools/tool-envelope'
import type { AgentCallbacks, AgentLoopConfig } from './types'
import {
  coerceToolArgs,
  normalizeToolResult,
  truncateLargeToolResult,
} from './tool-execution'

/** Extract real token usage from the most recent assistant message's usage field. */
function extractLastAssistantUsage(messages: Message[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role === 'assistant' && msg.usage) {
      return msg.usage.totalTokens || undefined
    }
  }
  return undefined
}

export interface BuildAgentToolsInput {
  toolRegistry: ToolRegistry
  mode: AgentMode
  callbacks?: AgentCallbacks
  beforeToolCall?: AgentLoopConfig['beforeToolCall']
  afterToolCall?: AgentLoopConfig['afterToolCall']
  getAllMessages: () => Message[]
  getAbortSignal: () => AbortSignal | undefined
  getToolContext: () => ToolContext
  setToolContext: (context: ToolContext) => void
  provider: PiAIProvider
  contextManager: ContextManager
  toolExecutionTimeout: number
  toolTimeoutExemptions: Set<string>
  onElicitationDetected?: () => void
}

export function buildAgentTools(input: BuildAgentToolsInput): AgentTool[] {
  return input.toolRegistry.getToolDefinitionsForMode(input.mode).map((toolDef) => ({
    name: toolDef.function.name,
    label: toolDef.function.name,
    description: toolDef.function.description || '',
    parameters: toolDef.function.parameters as never,
    execute: async (toolCallId, params) => {
      const args = coerceToolArgs(params)
      const toolCall: ToolCall = {
        id: toolCallId,
        type: 'function',
        function: {
          name: toolDef.function.name,
          arguments: JSON.stringify(args),
        },
      }

      try {
        // 计算当前上下文使用情况，传递给工具用于自我调节
        const contextConfig = input.contextManager.getConfig()
        const maxContextTokens = contextConfig.maxContextTokens || input.provider.maxContextTokens || 200000
        const reserveTokens = contextConfig.reserveTokens ?? 8192

        // Only pass real token usage from the last API response to truncateLargeToolResult.
        // Heuristic estimates are intentionally low (see token-counter.ts) and unreliable
        // for budget calculation — without real data, truncation is skipped entirely.
        const realUsedTokens = extractLastAssistantUsage(input.getAllMessages())

        // 在调用工具前更新 toolContext 的 contextUsage
        const originalToolContext = input.getToolContext()

        const outcome = await invokeTool(input, {
          toolName: toolDef.function.name,
          toolCallId,
          args,
          context: {
            ...originalToolContext,
            contextUsage: { usedTokens: realUsedTokens ?? 0, maxTokens: maxContextTokens - reserveTokens },
          },
        })
        let rawResult = outcome.raw

        // Truncate oversized results before normalizeToolResult.
        // If the result exceeds the context budget, write it to an assets file
        // and return the file path so the Agent can use a subagent to summarize it.
        rawResult = await truncateLargeToolResult({
          rawResult,
          toolName: toolDef.function.name,
          args,
          toolCallId,
          workspaceId: originalToolContext.workspaceId ?? undefined,
          existingTokens: realUsedTokens,
          maxContextTokens,
          reserveTokens,
          estimateTextTokens: (text) =>
            input.provider.estimateTokens([
              {
                role: 'assistant',
                content: text,
              },
            ]),
          writeToAssets: originalToolContext.workspaceId
            ? async (content, toolName, metadata) => {
                try {
                  const { AssetsBackend } = await import('../tools/backends/assets-backend')
                  const backend = new AssetsBackend(originalToolContext.workspaceId!)
                  const safeName = (metadata?.toolName ?? toolName).replace(/[^a-zA-Z0-9_-]/g, '_')
                  const ts = metadata?.timestamp ?? Date.now()
                  // Write raw data file (parseable JSON for front-end renderers)
                  const assetFileName = `overflow_${safeName}_${ts}.txt`
                  await backend.writeFile(assetFileName, content)
                  // Write companion metadata file for debugging (tool name, args, token budget)
                  try {
                    const metaFileName = `overflow_${safeName}_${ts}.meta.json`
                    await backend.writeFile(metaFileName, JSON.stringify({
                      toolName: metadata.toolName,
                      toolCallId: metadata.toolCallId ?? null,
                      timestamp: metadata.timestamp,
                      estimatedTokens: metadata.estimatedTokens,
                      availableTokens: metadata.availableTokens,
                      workspaceId: metadata.workspaceId ?? null,
                      args: metadata.args,
                    }, null, 2))
                  } catch { /* non-critical — metadata is best-effort */ }
                  return assetFileName
                } catch (err) {
                  console.error('[AgentLoop] Failed to write overflow to assets:', err)
                  return null
                }
              }
            : undefined,
        })

        const normalized = rawResult === outcome.raw ? outcome.presentation : normalizeToolResult(rawResult)

        let finalContent = normalized.content
        let finalDetails = normalized.details
        let finalIsError = normalized.isError

        if (finalIsError) {
          // If the error is already wrapped in a ToolEnvelopeV2 (e.g. from MCP tools),
          // return the raw envelope JSON as-is so the LLM receives structured error data.
          // Only throw for non-envelope errors (legacy/internal tools).
          if (isToolEnvelopeV2(finalDetails.parsed)) {
            finalContent = rawResult
            finalIsError = false
          } else if (outcome.deferred.length === 0) {
            throw new Error(
              finalContent.replace(/^Error(?:\s*\[[^\]]+\])?:\s*/i, '') || 'Tool execution failed'
            )
          }
        }

        let elicitationData: {
          mode: 'binary'
          message: string
          toolName: string
          args: Record<string, unknown>
          serverId: string
        } | null = null
        try {
          const parsedResult = JSON.parse(rawResult)
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

        if (toolDef.function.name === 'run_python' && rawResult) {
          try {
            const parsedResult = JSON.parse(rawResult)
            if (parsedResult.fileChanges) {
              const { useConversationContextStore } = await import('@/store/conversation-context.store')
              useConversationContextStore.getState().addChanges(parsedResult.fileChanges)
            }
          } catch {
            // ignore non-json outputs
          }
        }

        return {
          content: (() => {
            // If the envelope carried multimodal contentParts (e.g. a
            // screenshot from page_screenshot), the text-only envelope.json
            // string is meaningless to the model. Lift the parts out so the
            // downstream fetcher can emit image_url content parts.
            const parsed = finalDetails.parsed as
              | { contentParts?: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }
              | undefined
            if (parsed && Array.isArray(parsed.contentParts) && parsed.contentParts.length > 0) {
              return [...parsed.contentParts, ...outcome.deferred.flatMap(event => event.content)]
            }
            return [{ type: 'text' as const, text: finalContent }, ...outcome.deferred.flatMap(event => event.content)]
          })(),
          details: { ...finalDetails, deferred: outcome.deferred },
        }
      } catch (toolError) {
        if (toolError instanceof Error && toolError.message.includes('timed out')) {
          input.callbacks?.onToolTimeout?.(toolCall)
        }
        throw toolError
      }
    },
  }))
}
