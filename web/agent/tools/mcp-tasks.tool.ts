import type { ToolDefinition, ToolExecutor } from './tool-types'
import { toolErrorJson, toolOkJson } from './tool-envelope'
import { authorize } from '../policy-engine'
import { formatMCPToolResult, wrapUntrustedContent } from '../external-tool-bridge'

export const mcpTasksDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'mcp_tasks',
    description:
      'Inspect known MCP tasks in this project when the user asks. Never resubmits a tool. ' +
      'The task card above the original conversation input already observes background tasks: do not automatically poll, wait, or fetch results after submission. ' +
      'Use wait/result only when the user explicitly asks to wait or retrieve a result, including Send to AI from the card. ' +
      'Completion does not start the Agent. wait is bounded (default 10s, max 30s); if still pending, report its status and return to the user instead of repeatedly waiting. cancel and resume require permission.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'status', 'result', 'wait', 'cancel', 'resume'] },
        local_task_id: { type: 'string' },
        conversation_id: { type: 'string', description: 'Optional filter for list.' },
        seconds: { type: 'number', minimum: 0, maximum: 30 },
      },
      required: ['action'],
    },
  },
}
export const mcpTasksExecutor: ToolExecutor = async (args, context) => {
  if (!context.projectId)
    return toolErrorJson('mcp_tasks', 'PROJECT_REQUIRED', 'MCP tasks require an owning project')
  const {
    action,
    local_task_id: id,
    conversation_id: conversationId,
    seconds,
  } = args as {
    action: string
    local_task_id?: string
    conversation_id?: string
    seconds?: number
  }
  try {
    const { getMCPTaskManager } = await import('@/mcp/task-manager')
    const manager = getMCPTaskManager()
    await manager.initialize()
    const summary = (task: ReturnType<typeof manager.get>) => ({
      local_task_id: task.id,
      remote_task_id: task.reference?.taskId,
      server: task.serverId,
      tool: task.toolName,
      conversation_id: task.context.conversationId,
      status: task.remoteStatus,
      observation: task.observation,
      status_message: task.snapshot?.statusMessage
        ? wrapUntrustedContent(task.snapshot.statusMessage, {
            untrusted: true,
            sourceId: task.serverId,
            toolName: task.toolName,
          })
        : undefined,
      error: task.error
        ? wrapUntrustedContent(task.error, {
            untrusted: true,
            sourceId: task.serverId,
            toolName: task.toolName,
          })
        : undefined,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      cancellation_requested: task.cancellationRequested,
    })
    if (action === 'list')
      return toolOkJson('mcp_tasks', {
        tasks: manager.list(context.projectId, conversationId).map(summary),
      })
    if (!id) return toolErrorJson('mcp_tasks', 'TASK_ID_REQUIRED', 'Provide local_task_id')
    const task = manager.get(context.projectId, id)
    if (action === 'cancel' || action === 'resume') {
      const permission = await authorize({
        toolName: 'mcp_task_control',
        args: { action, id },
        toolArgs: { action, id, server: task.serverId, tool: task.toolName },
        conversationId: context.workspaceId,
        signal: context.abortSignal,
        mode: context.agentMode,
      })
      if (permission.decision === 'deny')
        return toolErrorJson('mcp_tasks', 'AUTH_DENIED_BY_USER', permission.reason)
      context.abortSignal?.throwIfAborted()
      return toolOkJson(
        'mcp_tasks',
        summary(
          await (action === 'cancel'
            ? manager.cancel(context.projectId, id, context.abortSignal)
            : manager.resume(context.projectId, id))
        )
      )
    }
    if (action === 'wait') {
      if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0 || seconds > 30))
        throw new Error('seconds must be between 0 and 30')
      return toolOkJson(
        'mcp_tasks',
        summary(await manager.wait(context.projectId, id, seconds, context.abortSignal))
      )
    }
    if (action === 'status') return toolOkJson('mcp_tasks', summary(task))
    if (action === 'result') {
      const result = await manager.result(context.projectId, id)
      if (!result) return toolOkJson('mcp_tasks', summary(task))
      return formatMCPToolResult(
        result,
        {
          serverId: task.serverId,
          fullName: `${task.serverId}:${task.toolName}`,
          untrusted: task.untrusted ?? true,
        },
        'mcp_tasks'
      )
    }
    return toolErrorJson('mcp_tasks', 'INVALID_ACTION', 'Unknown MCP task action')
  } catch (error) {
    return toolErrorJson(
      'mcp_tasks',
      'MCP_TASK_ERROR',
      error instanceof Error ? error.message : String(error)
    )
  }
}
