import { toolErrorJson, toolOkJson } from './tool-envelope'
import { SubagentError } from './tool-types'
import type { ToolPromptDoc } from './tool-types'
import type { TeamTaskHandoff } from '@/agent/team/team-manifest'
import {
  validateAgentId,
  validateDescription,
  validateMessage,
  validateName,
  validatePrompt,
  validateSubagentType,
} from './subagent-validation'
import type { ToolDefinition, ToolExecutor } from './tool-types'

const TOOL_NAME_SPAWN = 'spawn_subagent'
const TOOL_NAME_SEND = 'send_message_to_subagent'
const TOOL_NAME_STOP = 'stop_subagent'
const TOOL_NAME_RESUME = 'resume_subagent'
const TOOL_NAME_GET_STATUS = 'get_subagent_status'
const TOOL_NAME_GET_TRACE = 'get_subagent_trace'
const TOOL_NAME_LIST = 'list_subagents'

/**
 * Subagent type descriptions — injected into spawn_subagent
 * tool description so the main agent knows when to use each type.
 *
 * Modelled after codex's role description injection (see codex-rs/core/src/agent/role.rs).
 */
const SUBAGENT_TYPE_DESCRIPTIONS = `

Available subagent types (use the subagent_type parameter to select):
- general-purpose: Default subagent. Use when neither explorer nor worker fits.
- explorer: Read-only investigation. Use for specific, well-scoped questions on the codebase. Explorers are fast and authoritative. They must be used to ask specific, well-scoped questions on the codebase. You are encouraged to spawn up multiple explorers in parallel when you have multiple distinct questions to ask about the codebase that can be answered independently. Reuse existing explorers for related questions.
- worker: Code-changing subtasks. Use when the task involves modifying files. When delegating coding work, the subagent lists file paths it changed in the final answer. For coding tasks, prefer worker over explorer when the subagent can make a bounded patch in a clear write scope. Decompose work so each delegated task has a disjoint write set.
- awaiter: For long-running commands. Runs in the background with deterministic polling and no unrelated actions.`

/**
 * Subagent output is no longer pre-emptively offloaded to asset files.
 * The context manager (ContextManager) handles compression when token usage
 * approaches the context window limit (85% trigger threshold). Pre-emptive
 * truncation forced the main agent to waste a tool call on `read` to recover
 * the full output — defeating the purpose of delegation.
 *
 * If we ever need a safety valve for truly enormous outputs (e.g. >500K chars),
 * the threshold should be derived from the active model's context window size,
 * not a fixed character count.
 */

function runtimeMissing(tool: string): string {
  return toolErrorJson(
    tool,
    'SUBAGENT_RUNTIME_UNAVAILABLE',
    'Subagent runtime is not available in current tool context.'
  )
}

/**
 * Normalize the optional `handoff` argument into the manifest shape.
 * Unknown fields are dropped; empty strings collapse to undefined so the
 * manifest never stores `expects: ""`.
 */
function parseHandoffArg(value: unknown): TeamTaskHandoff | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const handoff: TeamTaskHandoff = {}
  if (typeof source.expects === 'string' && source.expects.trim()) handoff.expects = source.expects.trim()
  const reads = parseStringListArg(source.reads)
  const writes = parseStringListArg(source.writes)
  if (reads) handoff.reads = reads
  if (writes) handoff.writes = writes
  return Object.keys(handoff).length ? handoff : undefined
}

function parseStringListArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()).filter(Boolean)
  return items.length ? items : undefined
}

/** Format a SubagentError (or fallback Error) into a tool envelope string. */
function formatError(tool: string, error: unknown): string {
  if (error instanceof SubagentError) {
    return toolErrorJson(tool, error.code, error.message, {
      retryable: error.recoverable,
      details: error.field ? { field: error.field } : undefined,
    })
  }
  const message = error instanceof Error ? error.message : String(error)
  return toolErrorJson(tool, 'INTERNAL_ERROR', message)
}

export const spawnSubagentDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAME_SPAWN,
    description:
      'Submit a delegated subagent task in the background. Returns a durable accepted receipt immediately; pending/running means submitted, not completed. Completion arrives automatically as a notification in a new parent turn. Continue independent work, or finish the current turn when nothing else remains.' +
      SUBAGENT_TYPE_DESCRIPTIONS,
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Short task summary for tracking.',
        },
        prompt: {
          type: 'string',
          description:
            'Detailed instructions for the subagent. For best results include: (1) which specific tools to use, (2) what to sample or probe FIRST before doing bulk work, (3) expected output format, and (4) what to do if the primary approach fails.',
        },
        name: {
          type: 'string',
          description: 'Optional unique alias for later lookup.',
        },
        mode: {
          type: 'string',
          enum: ['plan', 'act'],
          description: 'Optional execution mode for the subagent.',
        },
        subagent_type: {
          type: 'string',
          enum: ['general-purpose', 'explorer', 'worker', 'awaiter'],
          description: 'Optional subagent role. Default: general-purpose. See tool description for guidance on when to use each type.',
        },
        as: {
          type: 'string',
          description:
            'Optional agent id to run as, so that agent\'s persona files apply. Omit entirely for an anonymous execution with no persona.',
        },
        role: {
          type: 'string',
          description:
            'Optional one-line role statement for a temporary member. Reaches the model through the system prompt only; creates no agent and persists nothing.',
        },
        task_id: {
          type: 'string',
          description:
            'Optional id of the team board task this spawn fulfils. Recorded in the run manifest; the child sees only its own task.',
        },
        handoff: {
          type: 'object',
          description:
            'Optional handoff contract for that task: what you expect back, what it should read first, what it should produce.',
          properties: {
            expects: { type: 'string', description: 'One sentence describing the expected answer shape.' },
            reads: {
              type: 'array',
              items: { type: 'string' },
              description: 'Board-relative paths the child should read before starting.',
            },
            writes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Board-relative paths the child is expected to produce.',
            },
          },
        },
      },
      required: ['description', 'prompt'],
    },
  },
}

export const sendMessageToSubagentDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAME_SEND,
    description:
      'Send a follow-up message to a running/pending subagent by agentId or alias name.',
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Target subagent id or alias.',
        },
        message: {
          type: 'string',
          description: 'Message payload for the target subagent.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional enqueue wait timeout in milliseconds.',
        },
        overflow_action: {
          type: 'string',
          enum: ['reject', 'drop_oldest'],
          description: 'Queue overflow strategy. Default reject.',
        },
      },
      required: ['to', 'message'],
    },
  },
}

export const stopSubagentDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAME_STOP,
    description: 'Stop a subagent by agentId or alias. Safe to call repeatedly (idempotent).',
    parameters: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Target subagent id or alias.',
        },
        force: {
          type: 'boolean',
          description: 'Force immediate stop.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Soft-stop wait timeout in milliseconds (default 10000).',
        },
      },
      required: ['agentId'],
    },
  },
}

export const resumeSubagentDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAME_RESUME,
    description: 'Resume a stopped or failed subagent with an additional prompt.',
    parameters: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Target subagent id or alias.',
        },
        prompt: {
          type: 'string',
          description: 'Prompt to continue the task.',
        },
      },
      required: ['agentId', 'prompt'],
    },
  },
}

export const getSubagentStatusDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAME_GET_STATUS,
    description: 'Get current status and queue depth of a subagent by id or alias.',
    parameters: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Target subagent id or alias.',
        },
      },
      required: ['agentId'],
    },
  },
}

export const getSubagentTraceDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAME_GET_TRACE,
    description:
      "Read a subagent's execution history (the same trace humans see in the task detail panel): assistant turns, tool calls, and results of the current or a past execution. Use when a child failed, delivered no answer, or you need to verify what it actually did. Content is size-capped per message; offset counts from the END so the default window is the most recent steps.",
    parameters: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Target subagent id or alias.',
        },
        execution_id: {
          type: 'string',
          description: 'Optional execution id (from a completion notification Trace line). Defaults to the latest execution.',
        },
        limit: {
          type: 'number',
          maximum: 50,
          description: 'Max messages returned (default 20, max 50).',
        },
        offset: {
          type: 'number',
          description: 'Skip this many messages counted from the end (older history). Default 0 = most recent window.',
        },
      },
      required: ['agentId'],
    },
  },
}

export const listSubagentsDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAME_LIST,
    description: 'List subagents in current workspace with optional status filter and pagination.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Optional status filter: pending|running|completed|failed|killed.',
        },
        limit: {
          type: 'number',
          description: 'Pagination limit. Default 50, max 200.',
        },
        offset: {
          type: 'number',
          description: 'Pagination offset. Default 0.',
        },
      },
    },
  },
}

export const spawnSubagentExecutor: ToolExecutor = async (args, context) => {
  const runtime = context.subagentRuntime
  if (!runtime) return runtimeMissing(TOOL_NAME_SPAWN)

  try {
    const description = validateDescription(args.description)
    const prompt = validatePrompt(args.prompt)
    const name = validateName(args.name)
    const subagentType = validateSubagentType(args.subagent_type)

    const result = await runtime.start({
      description,
      prompt,
      name,
      mode: args.mode === 'plan' || args.mode === 'act' ? args.mode : undefined,
      subagent_type: subagentType,
      as: typeof args.as === 'string' && args.as.trim() ? args.as.trim() : undefined,
      role: typeof args.role === 'string' && args.role.trim() ? args.role.trim() : undefined,
      task_id: typeof args.task_id === 'string' && args.task_id.trim() ? args.task_id.trim() : undefined,
      handoff: parseHandoffArg(args.handoff),
      parentToolCallId: context.currentToolCallId,
    })

    return toolOkJson(TOOL_NAME_SPAWN, result)
  } catch (error) {
    return formatError(TOOL_NAME_SPAWN, error)
  }
}

export const sendMessageToSubagentExecutor: ToolExecutor = async (args, context) => {
  const runtime = context.subagentRuntime
  if (!runtime) return runtimeMissing(TOOL_NAME_SEND)

  try {
    const to = validateAgentId(args.to)
    const message = validateMessage(args.message)

    const result = await runtime.sendMessage({
      to,
      message,
      timeout_ms: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
      overflow_action:
        args.overflow_action === 'drop_oldest' || args.overflow_action === 'reject'
          ? args.overflow_action
          : undefined,
    })
    if (!result.success) {
      return toolErrorJson(TOOL_NAME_SEND, result.message, result.message, {
        details: result,
      })
    }
    return toolOkJson(TOOL_NAME_SEND, result)
  } catch (error) {
    return formatError(TOOL_NAME_SEND, error)
  }
}

export const stopSubagentExecutor: ToolExecutor = async (args, context) => {
  const runtime = context.subagentRuntime
  if (!runtime) return runtimeMissing(TOOL_NAME_STOP)

  try {
    const agentId = validateAgentId(args.agentId)
    const result = await runtime.stop({
      agentId,
      force: args.force === true,
      timeout_ms: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
    })
    return toolOkJson(TOOL_NAME_STOP, result)
  } catch (error) {
    return formatError(TOOL_NAME_STOP, error)
  }
}

export const resumeSubagentExecutor: ToolExecutor = async (args, context) => {
  const runtime = context.subagentRuntime
  if (!runtime) return runtimeMissing(TOOL_NAME_RESUME)

  try {
    const agentId = validateAgentId(args.agentId)
    const prompt = validatePrompt(args.prompt)

    const result = await runtime.resume({
      agentId,
      prompt,
    })
    return toolOkJson(TOOL_NAME_RESUME, result)
  } catch (error) {
    return formatError(TOOL_NAME_RESUME, error)
  }
}

export const getSubagentStatusExecutor: ToolExecutor = async (args, context) => {
  const runtime = context.subagentRuntime
  if (!runtime) return runtimeMissing(TOOL_NAME_GET_STATUS)

  try {
    const agentId = validateAgentId(args.agentId)
    const result = await runtime.getStatus({ agentId })
    return toolOkJson(TOOL_NAME_GET_STATUS, result)
  } catch (error) {
    return formatError(TOOL_NAME_GET_STATUS, error)
  }
}

export const getSubagentTraceExecutor: ToolExecutor = async (args, context) => {
  const runtime = context.subagentRuntime
  if (!runtime) return runtimeMissing(TOOL_NAME_GET_TRACE)

  try {
    const agentId = validateAgentId(args.agentId)
    const result = await runtime.getTrace({
      agentId,
      execution_id: typeof args.execution_id === 'string' ? args.execution_id : undefined,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
      offset: typeof args.offset === 'number' ? args.offset : undefined,
    })
    return toolOkJson(TOOL_NAME_GET_TRACE, result)
  } catch (error) {
    return formatError(TOOL_NAME_GET_TRACE, error)
  }
}

export const listSubagentsExecutor: ToolExecutor = async (args, context) => {
  const runtime = context.subagentRuntime
  if (!runtime) return runtimeMissing(TOOL_NAME_LIST)

  const result = await runtime.list({
    status: typeof args.status === 'string' ? args.status : undefined,
    limit: typeof args.limit === 'number' ? args.limit : undefined,
    offset: typeof args.offset === 'number' ? args.offset : undefined,
  })
  return toolOkJson(TOOL_NAME_LIST, result)
}

export const subagentPromptDoc: ToolPromptDoc = {
  category: 'subagent',
  section: '### Subagent Delegation',
  lines: [
    '- `spawn_subagent(description, prompt, ...)` - Submit a background child task; receipt means accepted, not finished',
    '- Optional `as: <agentId>` runs the child as that agent (its persona applies). Omit it for an anonymous execution with no persona; use `role` for a one-line temporary role.',
    '- On a team board run, pass `task_id` + `handoff: { expects, reads, writes }` so the task is recorded in `manifest.json` and the child reads its own task instead of your prompt telling it twice.',
    '- Completion results arrive automatically as notifications in new parent turns; do not poll to keep the current turn alive',
    '- `send_message_to_subagent(to, message)` - Send follow-up instruction to a running/pending child',
    '- `stop_subagent(agentId)` - Stop a child task when scope changes',
    '- `resume_subagent(agentId, prompt)` - Resume a stopped/failed/completed child with new instructions',
    '- `get_subagent_status(agentId)` - Query child status, queue depth, and errors',
    '- `get_subagent_trace(agentId, execution_id?, limit?, offset?)` - Read a child\'s execution history (tool calls + results, size-capped, newest-first window). Use this to investigate a failed child or verify what it did',
    '- `list_subagents(status?, limit?, offset?)` - Enumerate all child tasks in this workspace',
  ],
}
