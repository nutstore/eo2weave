/**
 * Intelligence Coordinator - Integrates intelligent prompt enhancements.
 *
 * This module coordinates:
 * 1. Agent Configuration (SOUL, IDENTITY, etc.)
 * 2. Tool Recommendation System
 *
 * And injects relevant enhancements into the system prompt.
 */

import { getRecommendationEngine } from './tools/tool-recommendation'
import { ProjectManager, type AgentInfo } from '@/opfs'
import { buildAgentPrompt } from './prompt-builder'
import { extractFirstMentionedAgentId } from './agent-mention'

// Re-export AgentInfo for use in this module
export type { AgentInfo } from '@/opfs'

//=============================================================================
// Types
//=============================================================================

/** Intelligence enhancement result */
export interface IntelligenceEnhancement {
  /** Enhanced system prompt */
  systemPrompt: string
  /** Recommended tools */
  recommendedTools: string[]
  /** Agent info (if loaded) */
  agentInfo: AgentInfo | null
  /**
   * Today's log content, separated from the persona block.
   * The caller should inject this into the DYNAMIC section of the prompt
   * (not the stable prefix) because the log grows throughout the day —
   * including it in the stable section would break prompt caching every
   * time the agent writes a new diary entry.
   */
  todayLog: string | null
}

/** Coordinator options */
export interface CoordinatorOptions {
  /** Explicit project id for this run (preferred over any global active pointer) */
  projectId?: string | null
  /** Current user message for intent analysis */
  userMessage?: string
  /** Recent conversation history */
  recentMessages?: string[]
  /** Session ID for memory tracking */
  sessionId?: string
  /** Active file being discussed */
  activeFile?: string
  /** Current routed agent id for this run (from @mention routing) */
  currentAgentId?: string | null
}

//=============================================================================
// Intelligence Coordinator
//=============================================================================

export class IntelligenceCoordinator {
  /**
   * Enhance system prompt with intelligent context
   */
  async enhanceSystemPrompt(
    basePrompt: string,
    options: CoordinatorOptions = {}
  ): Promise<IntelligenceEnhancement> {
    const enhancements: string[] = []
    const recommendedTools: string[] = []
    let agentInfo: AgentInfo | null = null

    // 0. Load Agent Configuration (routed agent, fallback to default)
    const routedAgentId =
      options.currentAgentId?.trim() || extractFirstMentionedAgentId(options.userMessage || undefined)
    agentInfo = await this.loadAgentForRun(routedAgentId, options.projectId)

    // 1. Tool recommendation block injection disabled for prompt-cache stability.
    // Keep this section static across turns to avoid cache misses.

    // 2. Multi-root project context (inject root names so agent uses correct paths)
    try {
      const rootBlock = await buildMultiRootBlock(options.projectId)
      if (rootBlock) {
        enhancements.push(rootBlock)
      }
    } catch {
      // Non-critical
    }

    // 3. Available agents catalog (so delegate_to knows valid target_agent_id values).
    // Stable per project — only changes when user creates/deletes agents.
    try {
      const agentsBlock = await this.buildAvailableAgentsBlock(options.projectId)
      if (agentsBlock) {
        enhancements.push(agentsBlock)
      }
    } catch {
      // Non-critical
    }

    // Combine: base prompt + stable enhancements (multi-root, agent catalog),
    // then persona appended LAST. Ordering rationale:
    //   - base prompt + tools + project block = stable across persona switches
    //     → keeps prompt cache hot when delegate_to swaps persona
    //   - persona varies per turn when delegation happens → must be at the tail
    //     so its cache invalidation only affects itself, not the whole prefix
    let enhancedPrompt = basePrompt
    if (enhancements.length > 0) {
      enhancedPrompt += '\n\n' + enhancements.join('\n\n')
    }

    // Today's log is intentionally NOT included in the persona block here.
    // It is returned separately (see `todayLog` below) so the caller can place
    // it in the dynamic section, preserving the stable cache prefix.
    let todayLog: string | null = null
    if (agentInfo) {
      // Build persona WITHOUT today log — SOUL/IDENTITY/AGENTS/USER/MEMORY
      // are stable enough for the cache prefix (they only change when the
      // user explicitly edits agent files).
      const agentPrompt = buildAgentPrompt(agentInfo, { includeTodayLog: false })
      enhancedPrompt += '\n\n---\n\n' + agentPrompt

      // Load today log separately for the dynamic section.
      todayLog = await this.loadTodayLog(agentInfo.id, options.projectId)
    }

    return {
      systemPrompt: enhancedPrompt,
      recommendedTools: [...new Set(recommendedTools)],
      agentInfo,
      todayLog,
    }
  }

  /**
   * Load current routed agent configuration.
   * Falls back to default agent if requested agent is missing.
   * Note: No caching - always read fresh from OPFS so user changes take effect immediately.
   */
  private async loadAgentForRun(
    currentAgentId?: string | null,
    projectId?: string | null
  ): Promise<AgentInfo | null> {
    try {
      const targetProjectId = projectId?.trim() || null
      if (!targetProjectId) {
        return null
      }

      const projectManager = await ProjectManager.create()
      const project = await projectManager.getProject(targetProjectId)
      if (!project) {
        return null
      }

      const requestedAgentId = currentAgentId?.trim() || 'default'
      if (requestedAgentId !== 'default') {
        const requested = await project.agentManager.getAgent(requestedAgentId)
        if (requested) {
          return requested
        }
      }

      return await project.agentManager.getAgent('default')
    } catch (error) {
      console.warn('[IntelligenceCoordinator] Failed to load routed agent:', error)
      return null
    }
  }

  /**
   * Load today's log for an agent
   */
  private async loadTodayLog(agentId: string, projectId?: string | null): Promise<string | null> {
    try {
      const targetProjectId = projectId?.trim() || null
      if (!targetProjectId) {
        return null
      }

      const projectManager = await ProjectManager.create()
      const project = await projectManager.getProject(targetProjectId)
      if (!project) {
        return null
      }

      return await project.agentManager.readTodayLog(agentId)
    } catch (error) {
      console.warn('[IntelligenceCoordinator] Failed to load today log:', error)
      return null
    }
  }

  /**
   * Build a compact catalog of available agents in the current project, so the
   * LLM knows which `target_agent_id` values are valid for `delegate_to`.
   *
   * Returns null if the project has no agents or only the implicit `default`
   * (in which case delegation is pointless and we don't waste prompt tokens).
   */
  private async buildAvailableAgentsBlock(
    projectId?: string | null
  ): Promise<string | null> {
    try {
      const targetProjectId = projectId?.trim() || null
      if (!targetProjectId) {
        return null
      }

      const projectManager = await ProjectManager.create()
      const project = await projectManager.getProject(targetProjectId)
      if (!project) {
        return null
      }

      const agents = await project.agentManager.listAgents()
      // Don't bother emitting a block if there's only `default` — the LLM has
      // nobody to delegate to, and showing the section would just be noise.
      if (agents.length === 0) return null
      if (agents.length === 1 && agents[0].id === 'default') return null

      const lines = agents.map((a) => `- \`${a.id}\` — ${a.name}`)
      return [
        '## Available Agents',
        '',
        'You can hand a self-contained task to a teammate with `spawn_subagent(description, prompt, as: <agentId>)`, or run several in parallel from a `run_code` script via `await agent(prompt, { as: <agentId> })`. The child inherits the current history but runs as that agent.',
        '',
        ...lines,
      ].join('\n')
    } catch (error) {
      console.warn('[IntelligenceCoordinator] Failed to build agents block:', error)
      return null
    }
  }

  /**
   * Get tool recommendations for UI display
   */
  getToolRecommendations(userMessage: string, maxResults = 5) {
    return getRecommendationEngine().recommend(userMessage, maxResults)
  }

  /**
   * Get all available tools by category
   */
  getAllTools() {
    return getRecommendationEngine().getAllTools()
  }
}

//=============================================================================
// Singleton
//=============================================================================

let instance: IntelligenceCoordinator | null = null

export function getIntelligenceCoordinator(): IntelligenceCoordinator {
  if (!instance) {
    instance = new IntelligenceCoordinator()
  }
  return instance
}

//=============================================================================
// Integration Helpers
//=============================================================================

/**
 * Build root context block for the system prompt.
 * Always injects the root name(s) so the agent knows to prefix paths correctly.
 * Even for single-root projects, the agent must use the rootName prefix in all tool calls.
 */
async function buildMultiRootBlock(
  projectId?: string | null
): Promise<string | null> {
  try {
    if (!projectId) {
      const { getProjectRepository } = await import('@/sqlite/repositories/project.repository')
      const activeProject = await getProjectRepository().findActiveProject()
      projectId = activeProject?.id ?? undefined
    }
    if (!projectId) return null

    const { getProjectRootRepository } = await import('@/sqlite/repositories/project-root.repository')
    const repo = getProjectRootRepository()
    const roots = await repo.findByProject(projectId)

    if (roots.length === 0) return null

    const rootNames = roots.map((r) => `\`${r.name}\``).join(', ')
    const defaultRoot = roots.find((r) => r.isDefault)

    return [
      `## Active Roots: ${rootNames}${defaultRoot ? ` (default: \`${defaultRoot.name}\`)` : ''}`,
    ].join('\n')
  } catch {
    return null
  }
}
