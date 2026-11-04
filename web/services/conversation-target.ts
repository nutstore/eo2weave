import { ProjectManager } from '@/opfs'
import { getWorkspaceRepository } from '@/sqlite/repositories/workspace.repository'
import { getProjectRepository } from '@/sqlite/repositories/project.repository'
import { useProjectStore } from '@/store/project.store'
import { useConversationContextStore } from '@/store/conversation-context.store'
import { useWorkspacePreferencesStore } from '@/store/workspace-preferences.store'
import { useAgentsStore } from '@/store/agents.store'

export interface ConversationTargetInput {
  projectId?: string
  /** Existing conversation workspace whose project the new conversation inherits. */
  workspaceId?: string
}

export interface ConversationTarget {
  projectId: string
  projectName: string
  workspaceId: string | null
  agentId: string | null
  agents: { id: string; name: string }[]
}

/** Resolve the open context once, before creation or any other asynchronous work. */
export async function resolveConversationTarget(
  input: ConversationTargetInput = {}
): Promise<ConversationTarget> {
  const routeProjectId = useProjectStore.getState().activeProjectId
  const openWorkspaceId = useConversationContextStore.getState().activeWorkspaceId
  const savedSelections = useWorkspacePreferencesStore.getState().agentIdByWorkspace
  const { loadedProjectId, activeAgentId } = useAgentsStore.getState()
  const workspaceId = input.workspaceId || (input.projectId ? null : openWorkspaceId)
  const workspace = workspaceId
    ? await getWorkspaceRepository().findWorkspaceById(workspaceId)
    : null
  if (input.workspaceId && !workspace?.projectId) {
    throw new Error(`Workspace not found or unbound: ${input.workspaceId}`)
  }
  if (input.projectId && workspace?.projectId && input.projectId !== workspace.projectId) {
    throw new Error('workspaceId does not belong to projectId')
  }
  const projectId = input.projectId || workspace?.projectId || routeProjectId
  if (!projectId) throw new Error('No open project; specify projectId or workspaceId')
  const projectRecord = await getProjectRepository().findById(projectId)
  if (!projectRecord || projectRecord.status === 'archived') {
    throw new Error(`Project not found or archived: ${projectId}`)
  }
  const project = await (await ProjectManager.create()).getProject(projectId)
  if (!project) throw new Error(`Project not available: ${projectId}`)
  const agents = (await project.agentManager.listAgents()).map(({ id, name }) => ({ id, name }))
  const savedId = workspaceId ? savedSelections[workspaceId] : null
  const uiId = loadedProjectId === projectId ? activeAgentId : null
  const preferredId = savedId || uiId || 'default'
  const agentId =
    agents.find((a) => a.id === preferredId)?.id ??
    agents.find((a) => a.id === 'default')?.id ??
    agents[0]?.id ??
    null
  return {
    projectId,
    projectName: projectRecord.name,
    workspaceId: workspace?.id ?? null,
    agentId,
    agents,
  }
}
