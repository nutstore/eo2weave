import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { AgentMode } from '../agent-mode'
import { invokeTool } from '@/services/tool-invocation'
import { projectToolOutput } from './tool-result-output'
import type { ChangeDetectionResult } from '@/opfs/types/opfs-types'
import { RUN_CODE_TOOL, stripRunCodeTrace } from '@/agent/tools/run-code.tool'
import type { ContextManager } from '../context-manager'
import type { PiAIProvider } from '../llm/pi-ai-provider'
import type { Message, ToolCall } from '../message-types'
import type { ToolRegistry } from '../tool-registry'
import type { ToolContext } from '../tools/tool-types'
import { isToolEnvelopeV2 } from '../tools/tool-envelope'
import type { AgentCallbacks, AgentLoopConfig } from './types'
import { coerceToolArgs, normalizeToolResult, truncateLargeToolResult } from './tool-execution'

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
        const originalToolContext = input.getToolContext()
        const isRunCode = toolDef.function.name === RUN_CODE_TOOL

        // Truncate model-facing text after separating image bytes from presentation.
        // If the result exceeds the context budget, write it to an assets file
        // and return the file path so the Agent can use a subagent to summarize it.
        const truncateText = (raw: string) =>
          truncateLargeToolResult({
            rawResult: raw,
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

        const outcome = await invokeTool({
          ...input,
          onResult: async (call, result) => {
            // These observations belong to this Agent, not the shared executor or WebMCP.
            let parsed: Record<string, unknown>
            try { parsed = JSON.parse(result.raw) } catch { return }
            const elicitation = parsed?._elicitation as { mode: 'binary'; message: string; toolName: string; args: Record<string, unknown>; serverId: string } | undefined
            if (elicitation?.mode === 'binary' && input.callbacks?.onElicitation) {
              input.callbacks.onElicitation({ ...elicitation, toolCallId: call.toolCallId })
              input.onElicitationDetected?.()
            }
            if (call.toolName === 'run_python' && parsed?.fileChanges) {
              try {
                const { useConversationContextStore } = await import('@/store/conversation-context.store')
                useConversationContextStore.getState().addChanges(parsed.fileChanges as ChangeDetectionResult)
              } catch (error) {
                console.warn('[AgentLoop] Failed to record run_python file changes:', error)
              }
            }
          },
        }, {
          toolName: toolDef.function.name,
          toolCallId,
          args,
          context: {
            ...originalToolContext,
            contextUsage: { usedTokens: realUsedTokens ?? 0, maxTokens: maxContextTokens - reserveTokens },
          },
          prepareResult: isRunCode ? stripRunCodeTrace : undefined,
        })

        const finalDetails = outcome.presentation.details
        let finalContent = outcome.presentation.content
        if (outcome.presentation.isError) {
          if (isToolEnvelopeV2(finalDetails.parsed)) finalContent = outcome.prepared
          else throw new Error(finalContent.replace(/^Error(?:\s*\[[^\]]+\])?:\s*/i, '') || 'Tool execution failed')
        }
        // Hooks may replace the presentation. Honor that replacement without reviving old output.
        const replaced = outcome.presentation.content !== normalizeToolResult(outcome.prepared).content
        const projected = replaced
          ? { text: finalContent, output: [], isError: false }
          : projectToolOutput(toolDef.function.name, finalDetails.parsed, finalContent)
        const supportsVision = input.provider.getModel?.().input?.includes('image') ?? false
        const content = projected.text ? [{ type: 'text' as const, text: projected.text }] : []
        const parts = []
        for (const part of projected.output) {
          if (part.type === 'text') parts.push(part)
          else if (supportsVision) parts.push(part)
          else parts.push({ type: 'text' as const, text: '[Image output omitted: this model does not accept images. Use ocr explicitly for text recognition.]' })
        }
        const assembled = [...content, ...parts]
        const modelText = assembled.filter(p => p.type === 'text').map(p => p.text).join('\n')
        const boundedText = modelText ? await truncateText(modelText) : modelText
        return {
          content: boundedText === modelText ? assembled : [
            { type: 'text' as const, text: boundedText }, ...assembled.filter(p => p.type === 'image'),
          ],
          details: {
            ...finalDetails,
            ...(projected.isError ? { executionError: true } : {}),
            ...(isRunCode || toolDef.function.name === 'read_image' ? { displayContent: outcome.raw } : {}),
          },
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
