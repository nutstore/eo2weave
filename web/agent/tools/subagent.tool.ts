import { toolErrorJson, toolOkJson } from './tool-envelope'
import { SubagentError } from './tool-types'
import type { ToolPromptDoc } from './tool-types'
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
const TOOL_NAME_BATCH_SPAWN = 'batch_spawn'
const TOOL_NAME_SEND = 'send_message_to_subagent'
const TOOL_NAME_STOP = 'stop_subagent'
const TOOL_NAME_RESUME = 'resume_subagent'
const TOOL_NAME_GET_STATUS = 'get_subagent_status'
const TOOL_NAME_LIST = 'list_subagents'

/**
 * Subagent type descriptions — injected into spawn_subagent / batch_spawn
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
      'Submit a delegated subagent task in the background. Returns a durable accepted receipt immediately; pending/running means submitted, not completed. Continue independent work, or use wait_subagents to retrieve results.' +
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

export const batchSpawnDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAME_BATCH_SPAWN,
    description:
      'Submit multiple independent background tasks. Returns accepted receipts and per-member rejections immediately. Use wait_subagents to retrieve results.' +
      SUBAGENT_TYPE_DESCRIPTIONS,
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              prompt: { type: 'string' },
              name: { type: 'string' },
              mode: { type: 'string', enum: ['plan', 'act'] },
              subagent_type: {
                type: 'string',
                enum: ['general-purpose', 'explorer', 'worker', 'awaiter'],
                description: 'Optional subagent role. See spawn_subagent description.',
              },
            },
            required: ['description', 'prompt'],
          },
          description: 'Subagent tasks to launch.',
        },
        max_concurrency: {
          type: 'number',
          maximum: 5,
          description: 'Max parallel tasks per batch (default 5, max 5).',
        },
      },
      required: ['tasks'],
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
      parentToolCallId: context.currentToolCallId,
    })

    return toolOkJson(TOOL_NAME_SPAWN, result)
  } catch (error) {
    return formatError(TOOL_NAME_SPAWN, error)
  }
}

export const batchSpawnExecutor: ToolExecutor = async (args, context) => {
  const runtime = context.subagentRuntime
  if (!runtime) return runtimeMissing(TOOL_NAME_BATCH_SPAWN)

  try {
    const tasks: Array<import('./tool-types').SpawnSubagentInput> = []
    const indices: number[] = []
    const rejected: import('@/agent/subagent/async-types').SubagentBatchAcceptance['rejected'] = []
    for (const [task_index, raw] of (Array.isArray(args.tasks) ? args.tasks : []).entries()) {
      try {
        const task = raw as Record<string, unknown>
        tasks.push({ description: validateDescription(task.description), prompt: validatePrompt(task.prompt),
          name: validateName(task.name), subagent_type: validateSubagentType(task.subagent_type),
          mode: task.mode === 'plan' || task.mode === 'act' ? task.mode : undefined,
          parentToolCallId: context.currentToolCallId })
        indices.push(task_index)
      } catch (error) {
        rejected.push({ task_index, reason: error instanceof Error ? error.message : String(error),
          error_code: error instanceof SubagentError ? error.code : 'INVALID_INPUT' })
      }
    }
    const result = await runtime.batchStart({ tasks,
      max_concurrency: typeof args.max_concurrency === 'number' ? args.max_concurrency : undefined })
    return toolOkJson(TOOL_NAME_BATCH_SPAWN, {
      accepted: result.accepted.map((item) => ({ ...item, task_index: indices[item.task_index] })),
      rejected: [...rejected, ...result.rejected.map((item) => ({ ...item, task_index: indices[item.task_index] }))]
        .sort((a, b) => a.task_index - b.task_index),
    })
  } catch (error) {
    return formatError(TOOL_NAME_BATCH_SPAWN, error)
  }
}

export const waitSubagentsDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'wait_subagents',
    description: 'Wait for current executions of submitted subagents. Returns completed results and pending IDs; timeout never cancels work. Explicitly received pending results are consumed to avoid later automatic redelivery.',
    parameters: {
      type: 'object',
      properties: {
        agentIds: { type: 'array', items: { type: 'string' }, description: 'Agent IDs or aliases to wait for.' },
        timeout_ms: { type: 'number', minimum: 0, maximum: 60000, description: 'Bounded wait in milliseconds; default 60000, maximum 60000.' },
        wait_for: { type: 'string', enum: ['any', 'all'], description: 'Return after any or all targets finish; default any.' },
      },
      required: ['agentIds'],
    },
  },
}

export const waitSubagentsExecutor: ToolExecutor = async (args, context) => {
  if (!context.subagentRuntime) return runtimeMissing('wait_subagents')
  try {
    if (!Array.isArray(args.agentIds) || args.agentIds.length === 0) {
      throw new Error('agentIds must contain at least one agent ID')
    }
    const agentIds = args.agentIds.map(validateAgentId)
    const result = await context.subagentRuntime.wait({ agentIds,
      timeout_ms: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
      wait_for: args.wait_for === 'all' ? 'all' : 'any', signal: context.abortSignal })
    return toolOkJson('wait_subagents', {
      ...result,
      results: result.results.map((completion) => ({
        agentId: completion.agentId, executionId: completion.executionId, status: completion.taskStatus,
        result: completion.result, usage: completion.usage, error: completion.error,
        changedPaths: completion.changedPaths, traceId: completion.id,
      })),
    })
  } catch (error) { return formatError('wait_subagents', error) }
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
    '- `batch_spawn(tasks, max_concurrency?)` - Submit independent children with per-member acceptance/rejection',
    '- `wait_subagents(agentIds, timeout_ms?, wait_for?)` - Retrieve current child execution results; default any, maximum 60 seconds; timeout keeps work running',
    '- `send_message_to_subagent(to, message)` - Send follow-up instruction to a running/pending child',
    '- `stop_subagent(agentId)` - Stop a child task when scope changes',
    '- `resume_subagent(agentId, prompt)` - Resume a stopped/failed/completed child with new instructions',
    '- `get_subagent_status(agentId)` - Query child status, queue depth, and errors',
    '- `list_subagents(status?, limit?, offset?)` - Enumerate all child tasks in this workspace',
  ],
}
