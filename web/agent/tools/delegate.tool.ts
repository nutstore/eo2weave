/**
 * Delegate To Tool - allows the main agent to hand off the conversation
 * to another agent persona.
 *
 * Unlike spawn_subagent (which submits an isolated background task and returns
 * an accepted receipt, with results available through wait_subagents), delegate_to performs a **one-way
 * handoff**: the target agent takes over the next loop iteration with
 * the full conversation history and its own persona injected. The
 * originating agent does not regain control.
 *
 * Mechanism: the executor validates inputs, calls `context.onDelegation`
 * (injected by conversation.store), then returns a success message. The
 * store reads the pending delegation after the loop completes and
 * restarts the loop with the target agent's persona.
 */

import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'
import { toolErrorJson, toolOkJson } from './tool-envelope'
import { useAgentsStore } from '@/store/agents.store'

export const delegateToDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'delegate_to',
    description: [
      'Hand off the conversation to another agent persona. The target agent takes over the next iteration with full conversation history and its own persona injected.',
      '',
      'Use this when the task is better handled by a specialist (e.g. delegate code review to the backend engineer, design work to the frontend lead, security assessment to the security officer). The target agent receives the full history plus your `task` framing.',
      '',
      'IMPORTANT: This is a **one-way handoff** — you will NOT regain control after delegating. Only call this when you are confident the target agent should take over.',
      '',
      '## When to use',
      '- The user explicitly asks for a specialist (and you are not that specialist)',
      '- The task has shifted into a domain where another agent has deeper expertise',
      '- You have prepared the context and the next step clearly belongs to another role',
      '',
      '## When NOT to use',
      '- You can complete the task yourself — just do it',
      '- You only need a quick sub-result (use `spawn_subagent` and retrieve its background result with `wait_subagents`)',
      '- The user just @-mentioned another agent (the system already handles that)',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        target_agent_id: {
          type: 'string',
          description: [
            'ID of the agent persona to hand off to (e.g. "backend-engineer", "frontend-lead").',
            'Must be a known agent in the current project. If unsure, call this with a clearly-named target — invalid IDs return AGENT_NOT_FOUND.',
          ].join(' '),
        },
        task: {
          type: 'string',
          description: [
            'What the target agent should do. Be specific — this becomes the target agent\'s framing for the next iteration.',
            'Include the goal, any constraints, and pointers to relevant context already in the conversation.',
          ].join(' '),
        },
        reason: {
          type: 'string',
          description: 'Brief justification for the handoff (shown in UI). Helps the user understand why control is transferring.',
        },
      },
      required: ['target_agent_id', 'task'],
    },
  },
}

/**
 * Executor for delegate_to.
 *
 * Behaviour:
 * 1. Validate target_agent_id exists in the agents store.
 * 2. Reject self-delegation (prevents infinite loops).
 * 3. Call context.onDelegation to signal the store.
 * 4. Return a success message — the main agent sees this and naturally stops,
 *    then the store restarts the loop with the target agent's persona.
 *
 * If context.onDelegation is not registered (e.g. legacy toolContext), the
 * tool returns DELEGATION_UNAVAILABLE so the agent can fall back gracefully.
 */
export const delegateToExecutor: ToolExecutor = async (
  args: Record<string, unknown>,
  context
) => {
  const { target_agent_id, task, reason } = args as {
    target_agent_id: string
    task: string
    reason?: string
  }

  // --- Parameter validation ---
  if (!target_agent_id?.trim()) {
    return toolErrorJson(
      'delegate_to',
      'INVALID_INPUT',
      'Parameter "target_agent_id" is required and must be non-empty.',
      { retryable: true }
    )
  }

  if (!task?.trim()) {
    return toolErrorJson(
      'delegate_to',
      'INVALID_INPUT',
      'Parameter "task" is required and must be non-empty.',
      { retryable: true }
    )
  }

  // Normalise strings once so the rest of the executor can use them directly.
  const trimmedTask = task.trim()
  const trimmedReason = reason?.trim() || undefined

  // --- Reject self-delegation ---
  if (context.currentAgentId && target_agent_id === context.currentAgentId) {
    return toolErrorJson(
      'delegate_to',
      'SELF_DELEGATION',
      `Cannot delegate to self ("${target_agent_id}"). You are already acting in this persona.`,
      { retryable: false }
    )
  }

  // --- Validate target agent exists ---
  // Validate against THIS run's project catalog, not the globally loaded
  // Agent store: the prompt's Available Agents block is built from the run's
  // project (ToolContext.projectId), and a background conversation may run
  // in a different project than the one open in the UI — the global store
  // would then reject targets the prompt itself advertised. Runs without a
  // bound project (legacy/subagent contexts) keep the store fallback.
  let availableAgents: { id: string; name: string }[]
  if (context.projectId) {
    const { ProjectManager } = await import('@/opfs')
    const project = await (await ProjectManager.create()).getProject(context.projectId)
    if (!project) {
      return toolErrorJson(
        'delegate_to',
        'AGENT_NOT_FOUND',
        `Project "${context.projectId}" is not available, so the target agent cannot be resolved.`,
        { retryable: false }
      )
    }
    availableAgents = (await project.agentManager.listAgents()) as {
      id: string
      name: string
    }[]
  } else {
    availableAgents = useAgentsStore.getState().agents
  }
  const targetMeta = availableAgents.find((a) => a.id === target_agent_id)
  if (!targetMeta) {
    return toolErrorJson(
      'delegate_to',
      'AGENT_NOT_FOUND',
      `Agent "${target_agent_id}" not found in the current project.`,
      {
        retryable: false,
        hint: 'Available agents: ' + availableAgents.map((a) => a.id).join(', '),
        details: { available_agent_ids: availableAgents.map((a) => a.id) },
      }
    )
  }

  // --- No handler: graceful degradation ---
  if (!context.onDelegation) {
    return toolErrorJson(
      'delegate_to',
      'DELEGATION_UNAVAILABLE',
      'Delegation is not available in this context (no onDelegation handler registered).',
      {
        retryable: false,
        hint: 'This is expected in subagent contexts. Subagents cannot delegate.',
      }
    )
  }

  // --- Signal the store ---
  context.onDelegation({
    targetAgentId: target_agent_id,
    task: trimmedTask,
    reason: trimmedReason,
  })

  // --- Success message ---
  // This tool result is read by BOTH agents:
  //   - the outgoing agent (which should end its output naturally), AND
  //   - the incoming target agent (which sees it in history on the next run).
  // Phrased neutrally so it reads correctly for either audience. The `task`
  // field carries the framing — the target agent reads it as its directive.
  return toolOkJson('delegate_to', {
    delegated_to: target_agent_id,
    delegated_to_name: targetMeta.name,
    task: trimmedTask,
    ...(trimmedReason ? { reason: trimmedReason } : {}),
    message: `Handoff initiated: "${targetMeta.name}" will take over the next iteration with full conversation history. The task framing is in the \`task\` field above.`,
  }, {
    next_step: 'End your output. The target agent will continue automatically.',
  })
}

export const delegateToPromptDoc: ToolPromptDoc = {
  category: 'meta',
  section: '### Agent Delegation',
  lines: [
    '- `delegate_to(target_agent_id, task, reason?)` - Hand off the conversation to another agent persona (one-way handoff, full history preserved)',
  ],
}
