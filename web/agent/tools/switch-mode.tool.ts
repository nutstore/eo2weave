/**
 * Switch Agent Mode Tool - allows the agent to switch between Plan and Act modes.
 *
 * This is a meta-tool: it doesn't modify files, but changes the agent's own execution mode.
 * It is classified as a "read" tool so it's available in both Plan and Act modes.
 */

import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'
import type { AgentMode } from '../agent-mode'
import {
  getAgentModeForWorkspace,
  setAgentModeForWorkspace,
} from '@/store/workspace-preferences.store'
import { usePageActionSessionStore } from '@/store/page-action-session.store'
import { useYoloModeStore, syncLegacyPageActionYolo } from '@/store/yolo-mode.store'

export const switchAgentModeDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'switch_agent_mode',
    description: [
      'Switch the agent execution mode between Plan (read-only) and Act (full access).',
      'Use this tool when you determine that the current mode is not appropriate for the task at hand.',
      'For example, switch to Act mode when analysis is complete and you need to make file changes,',
      'or switch to Plan mode when you want to do a read-only review before making further changes.',
      '',
      'IMPORTANT: When switching from Plan to Act mode after analyzing a complex task, you should first present your plan to the user using ask_user_question (type=single_choice with plan details) and get their confirmation. Only switch to Act mode after the user approves the plan.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['plan', 'act'],
          description: 'The target mode to switch to.',
        },
        reason: {
          type: 'string',
          description:
            'Brief explanation of why the mode switch is needed. This will be shown to the user.',
        },
      },
      required: ['mode', 'reason'],
    },
  },
}

/**
 * Callback type for mode switch events.
 * Called when the agent successfully switches its own mode.
 */
export type OnModeSwitched = (payload: {
  newMode: AgentMode
  previousMode: AgentMode
  reason: string
}) => void

/**
 * Create an executor for switch_agent_mode.
 *
 * The executor reads/writes the mode of the conversation that ISSUED the call
 * (`context.workspaceId`), not whichever conversation is on screen. A loop keeps
 * running while the user browses other conversations, so resolving through the
 * active workspace let an agent switch somebody else's mode.
 */
export function createSwitchModeExecutor(opts?: {
  /** Optional callback when mode is switched */
  onModeSwitched?: OnModeSwitched
}): ToolExecutor {
  return async (args: Record<string, unknown>, context) => {
    const { mode, reason } = args as { mode: AgentMode; reason: string }
    const workspaceId = context?.workspaceId

    // No conversation context: refuse. Falling back to the open tab here would
    // reintroduce exactly the leak this tool now avoids — a run without a
    // workspace (script agent, nested invocation) silently rewriting whichever
    // conversation the user happens to be looking at.
    if (!workspaceId) {
      console.warn('[switch_agent_mode] refused: no conversation context in the tool call')
      return JSON.stringify({
        success: false,
        error: 'switch_agent_mode needs a conversation context; no mode was changed.',
      })
    }

    const currentMode = getAgentModeForWorkspace(workspaceId)

    // YOLO is an explicit user choice. An LLM-initiated mode switch may
    // disable it, but must never preserve or enable it implicitly.
    // PR-4: clears the conversation-scoped yolo across ALL conversations
    // (the safety valve is global — the LLM must never be able to leave any
    // conversation in auto-approve), plus the legacy shim.
    useYoloModeStore.getState().clearAll()
    syncLegacyPageActionYolo(false)
    usePageActionSessionStore.getState().setPageActionYolo(false)

    if (mode === currentMode) {
      return JSON.stringify({
        success: false,
        message: `Already in ${mode} mode. No switch needed.`,
        current_mode: mode,
      })
    }

    const previousMode = currentMode

    // Perform the switch for THIS conversation
    setAgentModeForWorkspace(mode, workspaceId)

    // Notify callback (for AgentLoop to update its internal state)
    opts?.onModeSwitched?.({ newMode: mode, previousMode, reason })

    return JSON.stringify({
      success: true,
      message: `Switched from ${previousMode} to ${mode} mode.`,
      reason,
      previous_mode: previousMode,
      current_mode: mode,
      hint:
        mode === 'act'
          ? 'Write tools (write, edit, delete) are now available for use.'
          : 'Only read-only tools are available. Write operations are disabled.',
    })
  }
}

export const switchModePromptDoc: ToolPromptDoc = {
  category: 'meta',
  section: '### Agent Mode Switching',
  lines: [
    '- `switch_agent_mode(mode, reason)` - Switch between Plan (read-only) and Act (full access) modes',
  ],
}
