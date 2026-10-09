import { useAgentsStore } from '@/store/agents.store'
import type { ReadFileStateEntry } from '@/agent/tools/tool-types'
import { getToolRegistry } from '@/agent/tool-registry'
import { invokeTool } from '@/agent/tool-invocation'
import { createToolPolicyHooks } from '@/agent/tool-policy'
import { isToolEnvelopeV2 } from '@/agent/tools/tool-envelope'
import { resolveWorkspaceDirectoryHandle } from '@/agent/tools/tool-utils'
import { getCurrentWorkspaceAgentMode } from '@/store/workspace-preferences.store'
import { useWorkspaceStore } from '@/store/workspace.store'
import { useProjectStore } from '@/store/project.store'
import { getSidePanelBindingId } from '@/agent/workspace-assistant-context'
import type { AdapterToolHost } from './adapter-host'
import type { JsonValue } from '@creatorweave/quickjs-runtime'

/** Bind once; never redirect a running adapter to a newly selected workspace. */
export function createWorkspaceToolHost(): AdapterToolHost | null {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId
  const projectId = useProjectStore.getState().activeProjectId
  if (!workspaceId || !projectId || useWorkspaceStore.getState().isLoading) return null
  const registry = getToolRegistry()
  const binding = getSidePanelBindingId()
  const valid = () => useWorkspaceStore.getState().activeWorkspaceId === workspaceId &&
    useProjectStore.getState().activeProjectId === projectId && !useWorkspaceStore.getState().isLoading && getSidePanelBindingId() === binding
  const names = () => valid() ? registry.getToolDefinitionsForMode(getCurrentWorkspaceAgentMode())
    .map(tool => tool.function.name) : []
  const executions = new Map<string, { readFileState: Map<string, ReadFileStateEntry>; currentAgentId: string }>()
  return {
    workspaceId, binding, names,
    end: executionId => { executions.delete(executionId) },
    close: () => executions.clear(),
    async invoke(toolName, args, toolCallId, signal, executionId) {
      signal.throwIfAborted()
      if (!valid() || !names().includes(toolName)) throw new Error('Workspace tool host changed or tool unavailable')
      const directoryHandle = await resolveWorkspaceDirectoryHandle(workspaceId)
      signal.throwIfAborted()
      if (!valid()) throw new Error('Workspace changed')
      let execution = executions.get(executionId)
      if (!execution) {
        execution = { readFileState: new Map(), currentAgentId: useAgentsStore.getState().activeAgentId || 'default' }
        executions.set(executionId, execution)
      }
      const mode = getCurrentWorkspaceAgentMode()
      const outcome = await invokeTool({
        toolRegistry: registry, mode, ...createToolPolicyHooks(),
        getAbortSignal: () => signal, toolExecutionTimeout: 55_000, toolTimeoutExemptions: new Set(),
      }, {
        toolName, toolCallId, args,
        context: { workspaceId, projectId, directoryHandle, ...execution, agentMode: mode, abortSignal: signal },
      })
      if (outcome.isError) {
        const parsed = outcome.presentation.details.parsed
        const error = isToolEnvelopeV2(parsed) && !parsed.ok ? parsed.error : { code: 'TOOL_FAILED', message: outcome.presentation.content }
        throw Object.assign(new Error(error.message), error, { toolName })
      }
      return outcome.value as JsonValue
    },
  }
}
