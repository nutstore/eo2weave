/**
 * Subagent role-based behavior suffix.
 *
 * The base SUBAGENT_SYSTEM_PROMPT is always included for any subagent.
 * This file defines role-specific suffixes appended based on `subagent_type`.
 *
 * Why suffixes (not full system prompts)?
 * - Keeps the base prompt consistent across all roles
 * - Each role's constraints are visible in the same prompt as the base
 * - Easy to extend with new roles
 *
 * Naming: "general-purpose" is kept for backward compatibility with the
 * existing `validateSubagentType` default value.
 */

import type { SubagentType } from '@/agent/tools/tool-types'

/**
 * Role-specific behavior suffix. Empty string for general-purpose (no change).
 */
export const SUBAGENT_TYPE_SUFFIXES: Record<SubagentType, string> = {
  'general-purpose': '',

  explorer: `
## Role: Explorer (read-only investigation)
You are a read-only explorer. Your task is investigation, not modification.

Strict rules:
- Do NOT modify any files. Do not call write, edit, delete, or any state-changing tool.
- Do NOT run commands that change state (no installs, no commits, no migrations, no rm).
- Read files, search code, and analyze patterns using read-only tools.
- Return findings as concise text with file:line references (e.g. "src/foo.ts:42").
- If you discover something that needs fixing, REPORT it — do not fix it yourself.
- Use parallel tool calls when reading multiple independent files.
- You may run read-only shell commands (cat, grep, rg, ls, find, jq, head, tail) but never mutating ones.

When done, your final response should be a structured summary:
  - Key findings (with file:line references)
  - Open questions
  - Recommended next steps (if any)`,

  worker: `
## Role: Worker (code-changing subtask)
You are responsible for executing a bounded code change in the workspace.

Rules:
- List which files you will modify BEFORE editing them (in your first response).
- Do not revert or modify changes made by other workers.
- If a change touches a file another worker is responsible for, STOP and report the conflict.
- Test your changes when feasible (build, lint, typecheck, run targeted tests).
- Decompose large changes into smaller, verifiable steps when possible.

When done, your final response should be a structured summary:
  1. Files modified (full paths)
  2. What changed (high level)
  3. Test results (if any)
  4. Any risks, side effects, or follow-ups for the main agent to address`,

  awaiter: `
## Role: Awaiter (long-running command)
Your sole responsibility is to await the completion of a specific command or process.

Rules:
- Execute the given command using the appropriate tool (usually bash).
- Use long polling timeouts (minutes, not seconds). Use exponential backoff between polls.
- Do NOT modify, interpret, or optimize the task.
- Do NOT perform unrelated actions.
- Only exit when: command completes successfully, command fails, or you receive an explicit stop instruction.
- When reporting status, be deterministic and conservative — do not hallucinate completion.

When done, your final response should include:
  - Final exit code
  - Total elapsed time
  - Key output excerpts (last 50 lines or so)
  - Whether the command succeeded or failed and why`,
}

/**
 * Build the full system prompt for a subagent based on its role type.
 *
 * For 'general-purpose', returns the base prompt unchanged.
 * For other types, appends the role-specific suffix.
 */
export interface SubagentRoleOptions {
  /** Inline role statement for an ephemeral member (no persona files). */
  role?: string
  /** Actor the execution runs as; identity reaches the model via context sources, not here. */
  actorId?: string | null
}

export function buildSubagentSystemPrompt(
  basePrompt: string,
  subagentType: SubagentType,
  options: SubagentRoleOptions = {}
): string {
  const sections = [basePrompt]
  const role = options.role?.trim()
  if (role) sections.push(`## Assigned role\n${role}`)
  const suffix = SUBAGENT_TYPE_SUFFIXES[subagentType]
  if (suffix?.trim()) sections.push(suffix.trim())
  return sections.join('\n\n')
}
