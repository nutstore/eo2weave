import { bashCommandRegistry } from '@/agent/bash-commands/registry'
import { ProjectManager } from '@/opfs'
import { buildAgentPrompt } from '@/agent/prompt-builder'
import { getAgentModeEnhancement } from '@/agent/prompts/universal-system-prompt'
import { isHumanUserMessage } from '@/agent/message-types'
import { t } from '@creatorweave/i18n'
import { useI18nStore } from '@/i18n/store'
import type { InjectEnhancementsInput } from '@/agent/loop/enhancements'
import { collectContextSources, type ContextEntries, type ContextObservation, type ContextSource } from './journal'

const scalar = (value: string | null | undefined): ContextEntries => value ? { value } : {}

async function getProject(projectId?: string | null) {
  if (!projectId) return null
  return (await ProjectManager.create()).getProject(projectId)
}

async function resolveAgent(toolContext: { projectId?: string | null; currentAgentId?: string | null }) {
  const project = await getProject(toolContext.projectId)
  if (!project) return null
  const agent = await project.agentManager.getAgent(toolContext.currentAgentId?.trim() || 'default')
    ?? await project.agentManager.getAgent('default')
  return { project, agent }
}

/** Create per-run providers; state and revisions belong to the durable journal, never these collectors. */
export function createRuntimeContextSources(input: () => InjectEnhancementsInput): ContextSource[] {
  return [
    { id: 'mode', collect: () => scalar(getAgentModeEnhancement(input().mode)) },
    { id: 'skills', collect: async () => {
      const { getSkillManager } = await import('@/skills/skill-manager')
      const manager = getSkillManager()
      if (!manager.initialized) return undefined
      await manager.refreshProviderSkills()
      const { formatSkillMetadata } = await import('@/skills/skill-injection')
      return Object.fromEntries(manager.getSkillMetadata().filter(skill => skill.enabled).map(skill => [
        skill.source === 'provider' ? skill.id : skill.name, formatSkillMetadata({ ...skill, tags: [...skill.tags].sort(), triggers: {
          ...skill.triggers, keywords: [...skill.triggers.keywords].sort(),
          fileExtensions: skill.triggers.fileExtensions ? [...skill.triggers.fileExtensions].sort() : undefined,
        } }),
      ]))
    } },
    { id: 'workspace-roots', collect: async () => {
      // Direct conversations have no folder authorization — omit the roots
      // block entirely so the model never assumes file access exists.
      if (input().toolContext.directMode) return {}
      const projectId = input().toolContext.projectId
      if (!projectId) return {}
      const { getProjectRootRepository } = await import('@/sqlite/repositories/project-root.repository')
      const roots = await getProjectRootRepository().findByProject(projectId)
      return Object.fromEntries(roots.map(root => [root.name, `Workspace root: ${root.name}${root.isDefault ? ' (default)' : ''}`]))
    } },
    { id: 'direct-mode-boundary', collect: () => {
      if (!input().toolContext.directMode) return {}
      // Localized so the capability boundary reads in the user's language
      // (parity check enforces all four locales).
      return scalar(t(useI18nStore.getState().locale, 'agent.directChat.systemBoundary'))
    } },
    { id: 'agents', collect: async () => {
      // Direct chats are project-independent: the hidden host binding must not
      // surface project agents (or any project-bound context) to the model.
      if (input().toolContext.directMode) return {}
      const project = await getProject(input().toolContext.projectId)
      if (!project) return {}
      const agents = await project.agentManager.listAgents()
      return Object.fromEntries(agents.map(agent => [agent.id, `${agent.name}; delegate_to target_agent_id: ${agent.id}`]))
    } },
    { id: 'agent-persona', collect: async () => {
      if (input().toolContext.directMode) return {}
      const resolved = await resolveAgent(input().toolContext)
      return resolved ? scalar(resolved.agent ? buildAgentPrompt(resolved.agent, { includeTodayLog: false }) : null) : {}
    } },
    { id: 'today-log', collect: async () => {
      if (input().toolContext.directMode) return {}
      const resolved = await resolveAgent(input().toolContext)
      return resolved ? scalar(resolved.agent ? await resolved.project.agentManager.readTodayLog(resolved.agent.id) : null) : {}
    } },
    { id: 'external-tools', collect: async () => {
      const { buildCompactExternalToolsSummary } = await import('@/agent/external-tool-bridge')
      return scalar(buildCompactExternalToolsSummary())
    } },
    { id: 'page', collect: async () => {
      const { isSidePanelMode, renderPageContextBlock } = await import('@/agent/workspace-assistant-context')
      if (!isSidePanelMode()) return {}
      // Resolve "this page" against the user's captured snapshot, never a later navigation.
      const message = [...input().messages].reverse().find(isHumanUserMessage)
      return message?.pageContext ? scalar(renderPageContextBlock(message.pageContext)) : undefined
    } },
    { id: 'page-tools', collect: async () => {
      const { buildSidePanelWebMCPBlock } = await import('@/agent/external-tool-bridge')
      return scalar(buildSidePanelWebMCPBlock())
    } },
    { id: 'bash-commands', collect: () => input().mode === 'act'
      ? Object.fromEntries([...bashCommandRegistry.snapshot()].map(([name, command]) => [
          name, `Description: ${command.manifest.description}\nManual:\n${command.manifest.manual}`,
        ])) : {} },
    { id: 'conversation', collect: () => {
      const { toolContext } = input()
      if (!toolContext.workspaceId) return {}
      // Direct chats never expose the hidden host project id.
      return {
        conversationId: toolContext.workspaceId,
        ...(toolContext.projectId && !toolContext.directMode ? { projectId: toolContext.projectId } : {}),
        instance: typeof window !== 'undefined' ? window.location.origin : '',
        guidance: 'Use these ids with self-control tools. When multiple instances expose a tool, ONLY call the variant whose source host matches this instance.',
      }
    } },
    { id: 'date', collect: () => {
      const now = new Date()
      return scalar(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`)
    } },
  ]
}

export async function collectRuntimeContext(sources: ContextSource[]): Promise<ContextObservation[]> {
  // Discovery is best-effort; failed discovery is not evidence of removed capabilities.
  const results = await Promise.allSettled([
    import('@/webmcp/manager').then(manager => manager.discoverWebMCPCatalog()),
    import('@/mcp').then(async ({ getMCPManager }) => {
      const manager = getMCPManager()
      await manager.initialize()
      await manager.connectUnconnectedEnabled()
    }),
    bashCommandRegistry.refresh(),
  ])
  const discoveryFailed = results.slice(0, 2).some(result => result.status === 'rejected')
  return collectContextSources(sources.filter(source =>
    !discoveryFailed || (source.id !== 'external-tools' && source.id !== 'page-tools')))
}
