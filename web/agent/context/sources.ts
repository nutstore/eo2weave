import { bashCommandRegistry } from '@/agent/bash-commands/registry'
import { ProjectManager } from '@/opfs'
import { buildAgentPrompt } from '@/agent/prompt-builder'
import { getAgentModeEnhancement } from '@/agent/prompts/universal-system-prompt'
import { isHumanUserMessage } from '@/agent/message-types'
import { t } from '@creatorweave/i18n'
import { useI18nStore } from '@/i18n/store'
import type { InjectEnhancementsInput } from '@/agent/loop/enhancements'
import { collectContextSources, type ContextEntries, type ContextObservation, type ContextSource } from './journal'
import { isToolAllowedByClasses } from '@/agent/tools/tool-capabilities'
import { teamMemberSlot } from '@/agent/team/team-paths'

const scalar = (value: string | null | undefined): ContextEntries => value ? { value } : {}

/**
 * Whether this execution can actually use a tool.
 *
 * Sources that document a capability (bash commands, skills, external tools) must
 * not be published to an execution whose capability boundary excludes that tool:
 * a model told about channels it cannot open burns turns discovering the wall.
 */
function canUseTool(toolName: string, input: InjectEnhancementsInput): boolean {
  return isToolAllowedByClasses(toolName, input.toolContext.capabilityClasses)
}

async function getProject(projectId?: string | null) {
  if (!projectId) return null
  return (await ProjectManager.create()).getProject(projectId)
}

async function resolveAgent(toolContext: { projectId?: string | null; currentAgentId?: string | null }) {
  // An explicit `null` means "no persona at all" (anonymous execution). Only an
  // absent/empty value falls back to the default agent, so callers can opt out
  // of persona injection without losing the project lookup.
  if (toolContext.currentAgentId === null) return null
  const project = await getProject(toolContext.projectId)
  if (!project) return null
  const requested = toolContext.currentAgentId?.trim() || ''
  const agent = requested
    ? await project.agentManager.getAgent(requested)
    : await project.agentManager.getAgent('default')
  // Fail closed: a requested actor that no longer resolves degrades to
  // "anonymous", never to a silent impersonation of the default agent.
  if (requested && !agent) return null
  return { project, agent }
}

/** Create per-run providers; state and revisions belong to the durable journal, never these collectors. */
export function createRuntimeContextSources(input: () => InjectEnhancementsInput): ContextSource[] {
  return [
    { id: 'mode', collect: () => scalar(getAgentModeEnhancement(input().mode)) },
    { id: 'team-board', collect: () => {
      const ctx = input().toolContext
      const runKey = ctx.teamRunKey
      // No active board = no section. Publishing a path that would be refused
      // is worse than publishing nothing: the model spends turns hitting it.
      if (!runKey) return undefined
      const root = `vfs://team/${runKey}`
      const canWrite = canUseTool('write', input())
      const lines = [
        '## Team Board',
        '',
        `This run has a shared scratch board at \`${root}/\`.`,
        '',
      ]
      if (ctx.isSubagent) {
        // Same slot rule as the ACL and the task section — never invent a name.
        // (A made-up `by/anonymous/` here is how a member ended up being told a
        // path it could not use while the ACL allowed a different one.)
        const slot = teamMemberSlot({ actorId: ctx.currentAgentId, taskId: ctx.teamTaskId })
        lines.push(
          `- Read anything on it: \`${root}/00-brief.md\` (the goal), \`${root}/manifest.json\` (task list), other members' notes under \`${root}/by/\`.`,
          canWrite && slot
            ? `- Your own space is \`${root}/${slot}/\` — put what the lead needs from you there (findings, file:line evidence, links). Everything else is read-only.`
            : canWrite
              ? '- You have no write area on this board: return your findings in your final message.'
              : '- You cannot write anything: this execution is read-only.',
        )
      } else {
        lines.push(
          `- \`${root}/00-brief.md\` — the goal in a few lines. Write it before you spawn anyone, so members read one shared statement instead of your prompt each.`,
          canWrite
            ? `- \`${root}/manifest.json\` — the task list (goal / assignee / status / artifacts). Only you write it; members never do, so there is exactly one writer.`
            : '- You cannot write to it: this execution is read-only.',
          `- \`${root}/by/{actorId}/\` — one directory per member; each may write only its own. Read them freely, including runs from other turns.`,
          '- Avoid passing long task text back and forth in prompts: put it on the board and hand over the path.',
        )
      }
      return { value: lines.join('\n') }
    } },
    { id: 'skills', collect: async () => {
      if (!canUseTool('read_skill', input())) return undefined
      const { getSkillManager } = await import('@/skills/skill-manager')
      const manager = getSkillManager()
      if (!manager.initialized) return undefined
      await manager.refreshProviderSkills()
      const { formatSkillMetadata } = await import('@/skills/skill-injection')
      // Direct conversations have no project: project-sourced skills are
      // host-project data (and their files resolve through the host
      // project's handles), so their metadata must not be published here —
      // read_skill rejects them for the same reason.
      const directMode = input().toolContext.directMode === true
      return Object.fromEntries(manager.getSkillMetadata().filter(skill => skill.enabled && (!directMode || skill.source !== 'project')).map(skill => [
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
      // Subagents cannot spawn or delegate, so a peer roster is pure noise — and
      // it is how the delegate_to instructions used to leak into them. Returning
      // undefined keeps the source out of the message entirely; `{}` would publish
      // an empty snapshot the model can still see.
      if (input().toolContext.isSubagent) return undefined
      const project = await getProject(input().toolContext.projectId)
      if (!project) return {}
      const agents = await project.agentManager.listAgents()
      // `role` is what lets the model pick a teammate on purpose instead of by
      // name alone. The spawn hint replaces the old delegate_to hint: delegation
      // is a spawn with `as`, not a one-way hand-off.
      return Object.fromEntries(agents.map(agent => [
        agent.id,
        agent.role
          ? `${agent.name} — ${agent.role} → spawn_subagent(as: ${agent.id})`
          : `${agent.name} → spawn_subagent(as: ${agent.id})`,
      ]))
    } },
    { id: 'agent-persona', collect: async () => {
      if (input().toolContext.directMode) return {}
      const resolved = await resolveAgent(input().toolContext)
      // Anonymous execution: omit the source entirely instead of publishing an
      // empty snapshot (`{}`), which reads as "persona exists but is blank".
      if (!resolved) return undefined
      return scalar(resolved.agent ? buildAgentPrompt(resolved.agent, { includeTodayLog: false }) : null)
    } },
    { id: 'today-log', collect: async () => {
      if (input().toolContext.directMode) return {}
      const resolved = await resolveAgent(input().toolContext)
      if (!resolved) return undefined
      return scalar(resolved.agent ? await resolved.project.agentManager.readTodayLog(resolved.agent.id) : null)
    } },
    { id: 'external-tools', collect: async () => {
      if (!canUseTool('call_tool', input())) return undefined
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
    { id: 'bash-commands', collect: () => {
      // The manual only exists where the `bash` door does.
      if (input().mode !== 'act' || !canUseTool('bash', input())) return undefined
      return Object.fromEntries([...bashCommandRegistry.snapshot()].map(([name, command]) => [
        name, `Description: ${command.manifest.description}\nManual:\n${command.manifest.manual}`,
      ]))
    } },
    { id: 'background-tasks', collect: async () => {
      const runtime = input().toolContext.subagentRuntime
      if (!runtime) return {}
      const active = await Promise.all(['pending', 'running'].map(status => runtime.list({ status, limit: 200 })))
      return Object.fromEntries(active.flatMap(result => result.agents).map(task => [task.agentId,
        JSON.stringify({ name: task.name, description: task.description, status: task.status,
          guidance: 'This task is already submitted. Reuse its identity and await its automatic notification; do not spawn a duplicate.' }),
      ]))
    } },
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
