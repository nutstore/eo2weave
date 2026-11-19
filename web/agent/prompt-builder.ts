/**
 * Agent Prompt Builder
 *
 * Convert an agent config file into an LLM system prompt.
 */

import type { AgentInfo } from '@/opfs'
import { DEFAULT_AGENT_TEMPLATE } from '@/opfs/agent/agent-templates'

export interface PromptOptions {
  /** Whether to include today's diary */
  includeTodayLog?: boolean
  /** Today's diary content */
  todayLog?: string | null
  /** Extra system prompt */
  extraSystemPrompt?: string
}

/**
 * Build the agent system prompt
 */
export function buildAgentPrompt(agent: AgentInfo, options: PromptOptions = {}): string {
  const sections: string[] = []

  // 1. SOUL - core personality
  if (agent.soul.trim()) {
    sections.push(`# 核心人格\n\n${agent.soul.trim()}`)
  }

  // 2. IDENTITY - identity
  if (agent.identity.trim()) {
    sections.push(`# 身份\n\n${agent.identity.trim()}`)
  }

  // 3. AGENTS - workflows
  if (agent.agents.trim()) {
    sections.push(`# 工作流程\n\n${agent.agents.trim()}`)
  }

  // 4. USER - user info (skip default unfilled template)
  if (agent.user.trim() && agent.user.trim() !== DEFAULT_AGENT_TEMPLATE.USER.trim()) {
    sections.push(`# 用户\n\n${agent.user.trim()}`)
  }

  // 5. MEMORY - long-term memory (skip default unfilled template)
  if (agent.memory.trim() && agent.memory.trim() !== DEFAULT_AGENT_TEMPLATE.MEMORY.trim()) {
    sections.push(`# 长期记忆\n\n${agent.memory.trim()}`)
  }

  // 6. Today's diary (optional)
  if (options.includeTodayLog && options.todayLog?.trim()) {
    sections.push(`# 今日日志\n\n${options.todayLog.trim()}`)
  }

  // 7. Extra system prompt (optional)
  if (options.extraSystemPrompt?.trim()) {
    sections.push(options.extraSystemPrompt.trim())
  }

  return sections.join('\n\n---\n\n')
}

/**
 * Build the compact prompt (core sections only)
 */
export function buildCompactPrompt(agent: AgentInfo): string {
  const sections: string[] = []

  // SOUL and IDENTITY only
  if (agent.soul.trim()) {
    sections.push(agent.soul.trim())
  }

  if (agent.identity.trim()) {
    sections.push(agent.identity.trim())
  }

  return sections.join('\n\n')
}

/**
 * Estimate the prompt's token count (rough)
 */
export function estimatePromptTokens(agent: AgentInfo, options: PromptOptions = {}): number {
  const prompt = buildAgentPrompt(agent, options)
  // Rough estimate: ~4 characters per token for English, ~2 for Chinese
  // Average out to 3 characters per token
  return Math.ceil(prompt.length / 3)
}

/**
 * Per-section token estimates for the prompt
 */
export function getPromptTokenBreakdown(
  agent: AgentInfo,
  options: PromptOptions = {}
): Record<string, number> {
  const breakdown: Record<string, number> = {}

  breakdown.soul = Math.ceil((agent.soul?.length || 0) / 3)
  breakdown.identity = Math.ceil((agent.identity?.length || 0) / 3)
  breakdown.agents = Math.ceil((agent.agents?.length || 0) / 3)
  breakdown.user = Math.ceil((agent.user?.length || 0) / 3)
  breakdown.memory = Math.ceil((agent.memory?.length || 0) / 3)

  if (options.includeTodayLog && options.todayLog) {
    breakdown.todayLog = Math.ceil(options.todayLog.length / 3)
  }

  if (options.extraSystemPrompt) {
    breakdown.extra = Math.ceil(options.extraSystemPrompt.length / 3)
  }

  breakdown.total = Object.values(breakdown).reduce((a, b) => a + b, 0)

  return breakdown
}
