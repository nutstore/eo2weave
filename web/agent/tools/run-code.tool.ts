import { executeToolCode } from '@/services/code-execution'
import type { CodeAgentHost } from '@/services/code-execution'
import type { JsonValue } from '@creatorweave/quickjs-runtime'
import { createWorkflowStore } from '@/agent/workflow/sqlite-store'
import { createAgentRunner } from '@/agent/workflow/agent-runner'
import { toolErrorJson, toolOkJson } from './tool-envelope'
import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'

export type { CodeToolTrace } from '@/services/code-execution'
export const RUN_CODE_TOOL = 'run_code'

export const runCodeDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: RUN_CODE_TOOL,
    description: [
      'Execute an async JavaScript function body to combine available tools and process their results.',
      'purpose and code are required. Top-level await and return work; TypeScript and imports do not.',
      'Call await tools.name(args) or await tools["tool-name"](args), using the same argument schemas as direct tools.',
      'Direct tools remain available. run_code cannot call itself.',
      'Successful tools return envelope data, otherwise parsed JSON or text. Failed tools reject with code and toolName.',
      'Return JSON data. text(value), image(imageBlock) and console.log append explicit output to this execution result. Intermediate images are not forwarded automatically. Use output.forward(child.output) to forward a child result deliberately.',
      'Await all work that must complete; unfinished calls are canceled on exit and may already have side effects. No DOM, fetch, timers or persistent globals.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        purpose: {
          type: 'string',
          minLength: 1,
          description: 'A concise explanation of this execution, in the user’s language.',
        },
        code: { type: 'string', minLength: 1, description: 'Async JavaScript function body.' },
        replay: {
          type: 'string',
          description: 'Optional replay key. Supplying it persists each agent() step so rerunning with the same key serves finished steps from cache and re-executes from the first changed step. Also disables Date/Math.random/performance.now inside the script.',
        },
        inputs: {
          type: 'object',
          description: 'Optional JSON passed to the script as `inputs`. Use it for anything nondeterministic (a date, a seed, an id) so a replayable script stays identical between runs.',
        },
      },
      required: ['purpose', 'code'],
    },
  },
}

/** Drops UI-only traces from the model-facing result. */
export function stripRunCodeTrace(raw: string): string {
  try {
    const response = JSON.parse(raw)
    delete response.meta
    return JSON.stringify(response)
  } catch {
    return raw
  }
}

export const runCodeExecutor: ToolExecutor = async (args, context) => {
  if (!context.codeTools)
    return toolErrorJson(RUN_CODE_TOOL, 'UNAVAILABLE', 'Tool invocation context is unavailable')
  const replay = typeof args.replay === 'string' && args.replay.trim() ? args.replay.trim() : undefined
  if (replay && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(replay))
    return toolErrorJson(RUN_CODE_TOOL, 'INVALID_REPLAY_KEY', 'replay must match [A-Za-z0-9][A-Za-z0-9_-]{0,79}')
  const runtime = context.subagentRuntime
  // In a subagent context there is no runtime, so `replay` would be accepted and
  // silently inert: no agent(), no guard, no rows. Refuse instead of pretending.
  if (replay && !runtime)
    return toolErrorJson(
      RUN_CODE_TOOL, 'AGENT_RUNTIME_UNAVAILABLE',
      'replay requires the agent runtime, which this execution context does not have',
      { hint: 'Drop the replay argument here, or run the script from the main conversation.' }
    )
  // Replay rows are scoped to the conversation (workspaceId === conversationId):
  // a bare key like `daily` in another conversation must never serve this one's
  // answers. Model-facing meta keeps the raw key.
  const runId = replay ? `${context.workspaceId ?? 'global'}:${replay}` : undefined
  // agent() is only meaningful with a runtime; without one the script simply
  // keeps the plain tools-only sandbox.
  const runner = runtime
    ? createAgentRunner({
        runtime,
        store: replay ? createWorkflowStore() : undefined,
        runId,
        agentMode: context.agentMode,
        parentToolCallId: context.currentToolCallId,
      })
    : undefined
  // The guest receives { content, agentId, cached } — enough to branch on, and
  // small enough to stay inside the sandbox transfer budget.
  const agentHost: CodeAgentHost | undefined = runner
    ? {
        run: async (prompt: string, options?: JsonValue, signal?: AbortSignal) => {
          const outcome = await runner.runAgent(prompt, options, signal)
          return { content: outcome.content, agentId: outcome.agentId, cached: outcome.cached }
        },
      }
    : undefined
  const { result, calls } = await executeToolCode(
    args.code as string, context.codeTools,
    context.abortSignal ?? new AbortController().signal, context.currentToolCallId ?? 'run_code',
    agentHost,
    !!replay,
    (args.inputs ?? null) as JsonValue | null,
  )
  // A script that threw is a failed tool call: the envelope must say so, or
  // policy hooks and loop guards treat it as success. Any output emitted before
  // the failure is inlined, because the model only sees the error message.
  if (!result.ok) {
    const emitted = result.output
      .map((part) => (part.type === 'text' ? part.text : `[image ${part.mimeType}]`))
      .join('\n')
      .trim()
    const message = emitted
      ? `${result.error.code}: ${result.error.message}\n\nOutput before failure:\n${emitted}`
      : `${result.error.code}: ${result.error.message}`
    return toolErrorJson(RUN_CODE_TOOL, result.error.code, message, {
      retryable: result.error.code !== 'JS_CANCELED',
      details: { steps: runner ? runner.steps : [], calls },
      meta: { calls, replay: replay ?? null, steps: runner ? runner.steps : [] },
    })
  }
  return toolOkJson(RUN_CODE_TOOL, result, {
    meta: { calls, replay: replay ?? null, steps: runner ? runner.steps : [] },
  })
}

export const runCodePromptDoc: ToolPromptDoc = {
  category: 'execution',
  lines: [
    '- `run_code(purpose, code, replay?, inputs?)` — Combine tools with async JavaScript. Explicitly emit images using `image(result)` or `image(result.image)`; return JSON and use `text(value)` or `console.log` for text output.',
    '  - `await agent(prompt, options?)` runs one subagent and waits for its answer (`{ content, agentId, cached }`), so the script can branch on results. Use it instead of `tools.spawn_subagent`, which only queues work and returns a receipt.',
    '  - Pass `replay` to make the run replayable: finished `agent()` steps are served from cache on a rerun with the same key, execution resumes from the first changed step, and Date/Math.random/performance.now throw inside the script. Feed such values in through `inputs` instead.',
  ],
}
