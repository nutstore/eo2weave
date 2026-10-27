import { ProjectManager } from '@/opfs'
import { useAgentsStore } from '@/store/agents.store'
import { useWorkspacePreferencesStore } from '@/store/workspace-preferences.store'
import { extractFirstMentionedAgentId } from './agent-mention'

/** Resolve against the run's project catalog, never another open project's Agents. */
export async function resolveConversationAgentId(
  projectId: string | null,
  conversationId: string,
  overrideId: string | null | undefined,
  message: string | null | undefined
): Promise<string> {
  const preferences = useWorkspacePreferencesStore.getState()
  const savedId = preferences.agentIdByWorkspace[conversationId]
  const ui = useAgentsStore.getState()
  const uiId = ui.loadedProjectId === projectId ? ui.activeAgentId : null
  const explicit = overrideId?.trim()
  const mention = extractFirstMentionedAgentId(message)
  // Legacy foreground contexts may have no project yet. Never take the
  // identity of an unrelated project's open tab as their default.
  if (!projectId) {
    if (explicit || mention || savedId)
      throw new Error('Cannot select an Agent without a bound project')
    return 'default'
  }
  const project = await (await ProjectManager.create()).getProject(projectId)
  if (!project) throw new Error(`Project not available: ${projectId}`)
  const agents = await project.agentManager.listAgents()
  const canonical = (id: string | null | undefined) =>
    id ? agents.find((a) => a.id.toLowerCase() === id.toLowerCase())?.id : undefined
  if (explicit && !canonical(explicit))
    throw new Error(`Agent not found in project ${projectId}: ${explicit}`)
  if (!explicit && !canonical(mention) && savedId && !canonical(savedId)) {
    throw new Error(`Selected Agent no longer exists in project ${projectId}: ${savedId}`)
  }
  const agentId =
    canonical(explicit) ||
    canonical(mention) ||
    canonical(savedId) ||
    canonical(uiId) ||
    canonical('default') ||
    agents[0]?.id ||
    'default'
  // A deliberate UI selection made while the catalog was loading belongs
  // to the next turn; do not replace it with this run's earlier snapshot.
  if (useWorkspacePreferencesStore.getState().agentIdByWorkspace[conversationId] === savedId) {
    preferences.setWorkspaceAgentId(conversationId, agentId)
  }
  return agentId
}
