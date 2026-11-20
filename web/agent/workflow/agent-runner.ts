/**
 * Agent-step bookkeeping for scripts that orchestrate subagents.
 *
 * Extracted from the former workflow engine so `run_code` can expose a single
 * blocking `agent()` primitive to its guest script. The runner owns everything
 * that must not live in the guest:
 *   - step ordering and the agent() budget,
 *   - replay: (runId, step_index) + prompt hash lookups,
 *   - persistence of each step's result,
 *   - duplicate-name fallback when a replayed run reuses a finished agent name.
 *
 * Scripts without a replay key get no store and therefore no caching — the
 * runner then behaves like a plain blocking spawn helper.
 */

import type { JsonValue } from '@creatorweave/quickjs-runtime'
import type { SubagentCapabilities, SubagentRuntime, SubagentType } from '@/agent/tools/tool-types'

/** Upper bound on agent() calls per script — bounds the cost of a runaway run. */
export const MAX_SCRIPT_AGENTS = 32

export type AgentStepStatus = 'cached' | 'completed' | 'failed'

export interface AgentStepTrace {
  index: number
  status: AgentStepStatus
  agentId?: string
  name?: string
  chars?: number
  usage?: JsonValue
  error?: string
  /** Wall clock of the step, so the card can infer which steps ran in parallel. */
  startedAt?: number
  finishedAt?: number
}

export interface AgentStepRecord {
  stepIndex: number
  /** Diagnostics only — equality is decided by prompt/optionsKey text. */
  promptHash: string
  prompt: string | null
  optionsKey: string | null
  status: 'completed' | 'failed'
  agentId: string | null
  name?: string | null
  result: string | null
  /** Read back by the UI so a reloaded card can still draw the run. */
  startedAt?: number
  finishedAt?: number
}

/** Persistence port — production uses SQLite, tests use an in-memory fake. */
export interface AgentStepStore {
  listSteps(runId: string): Promise<AgentStepRecord[]>
  saveStep(input: {
    runId: string
    stepIndex: number
    promptHash: string
    prompt: string
    optionsKey: string
    agentId: string | null
    name: string | null
    status: 'completed' | 'failed'
    result: string | null
    usageJson: string | null
    errorJson: string | null
    startedAt: number
    finishedAt: number
  }): Promise<void>
}

export interface AgentRunnerOptions {
  runtime: Pick<SubagentRuntime, 'spawn'>
  /** Enables replay for this run. Omit for one-shot execution. */
  store?: AgentStepStore
  runId?: string
  maxAgents?: number
  agentMode?: 'plan' | 'act'
  /** Owning tool call, forwarded so the UI can render live child cards. */
  parentToolCallId?: string
  now?: () => number
}

export interface AgentRunOutcome {
  content: string
  agentId: string | null
  usage: JsonValue | null
  cached: boolean
}

const SUBAGENT_TYPES: readonly SubagentType[] = ['general-purpose', 'explorer', 'worker', 'awaiter']

interface NormalizedOptions {
  name?: string
  subagent_type?: SubagentType
  mode?: 'plan' | 'act'
  timeout_ms?: number
  /** Actor the child runs as; `null` makes the anonymous intent explicit. */
  as?: string | null
  /** Inline role statement for an ephemeral member. */
  role?: string
  /** Capability boundary requested for this step (merged with the actor's). */
  capabilities?: SubagentCapabilities
  /** Exact identity of everything that shapes the child's answer. */
  optionsKey: string
}

function normalizeOptions(raw: JsonValue | undefined, agentMode?: 'plan' | 'act'): NormalizedOptions {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('agent(prompt, options?) — options must be a plain object')
  }
  const record = raw as Record<string, JsonValue>
  const resolved: Omit<NormalizedOptions, 'optionsKey'> = {}
  if (typeof record.name === 'string' && record.name.trim()) resolved.name = record.name.trim().slice(0, 80)
  if (typeof record.subagent_type === 'string' && SUBAGENT_TYPES.includes(record.subagent_type as SubagentType)) {
    resolved.subagent_type = record.subagent_type as SubagentType
  }
  if (record.mode === 'plan' || record.mode === 'act') resolved.mode = record.mode
  if (typeof record.timeout_ms === 'number' && Number.isFinite(record.timeout_ms) && record.timeout_ms > 0) {
    resolved.timeout_ms = Math.min(record.timeout_ms, 3_600_000)
  }
  if (record.as === null) resolved.as = null
  else if (typeof record.as === 'string' && record.as.trim()) resolved.as = record.as.trim().slice(0, 64)
  if (typeof record.role === 'string' && record.role.trim()) resolved.role = record.role.trim().slice(0, 500)
  // Capability boundary requested by the script. Class names are validated in
  // the runtime (unknown names throw), so only shape normalization happens here.
  if (record.capabilities && typeof record.capabilities === 'object' && !Array.isArray(record.capabilities)) {
    const raw = record.capabilities as { classes?: unknown; readonly?: unknown }
    const classes = Array.isArray(raw.classes) ? raw.classes.filter((value): value is string => typeof value === 'string') : undefined
    const readonly = raw.readonly === true
    if (classes || readonly) {
      resolved.capabilities = {
        ...(classes ? { classes: classes as SubagentCapabilities['classes'] } : {}),
        ...(readonly ? { readonly } : {}),
      }
    }
  }
  // The run's own mode wins over the guest's request, so it belongs to identity:
  // a plan-mode rerun must not be served an act-mode result.
  const effectiveMode = agentMode === 'plan' ? 'plan' : resolved.mode
  return {
    ...resolved,
    optionsKey: JSON.stringify([
      resolved.name ?? null,
      resolved.subagent_type ?? null,
      effectiveMode ?? null,
      resolved.timeout_ms ?? null,
      // Identity, not styling: swapping the actor or the role must never be
      // served a cached answer produced under different instructions.
      resolved.as ?? null,
      resolved.role ?? null,
      // Restricting tools changes what the answer could possibly be; a narrowed
      // rerun must not be served a cached result from an unrestricted one.
      resolved.capabilities ? JSON.stringify(resolved.capabilities) : null,
    ]),
  }
}

/** Digest for diagnostics only; never used to decide a replay hit. */
export function hashText(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index++) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Reused agent names collide with finished tasks on replay divergence.
 * Two layers can reject the duplicate: the in-memory name map
 * (`name "x" already exists`, registering only resumable failed tasks) and the
 * subagent_tasks unique index (`SQLITE_CONSTRAINT_UNIQUE`). Fall back to a
 * numbered variant so a changed step can still run; the replay hash keeps
 * using the original name, so cached lookups stay stable.
 */
async function spawnWithUniqueName(
  runtime: Pick<SubagentRuntime, 'spawn'>,
  input: Parameters<SubagentRuntime['spawn']>[0],
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<SubagentRuntime['spawn']>>> {
  if (!input.name) return runtime.spawn(input, { signal })
  const isNameConflict = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error)
    return /already exists/i.test(message) || /UNIQUE constraint failed: subagent_tasks/i.test(message)
  }
  const candidates = [input.name, ...[2, 3, 4, 5].map((suffix) => `${input.name}~${suffix}`)]
  let lastError: unknown
  for (const name of candidates) {
    try {
      return await runtime.spawn({ ...input, name }, { signal })
    } catch (error) {
      if (!isNameConflict(error)) throw error
      lastError = error
    }
  }
  throw lastError
}

export interface AgentRunner {
  runAgent: (prompt: string, rawOptions?: JsonValue, signal?: AbortSignal) => Promise<AgentRunOutcome>
  /** Trace in start order, including cached steps. */
  steps: AgentStepTrace[]
}

export function createAgentRunner(options: AgentRunnerOptions): AgentRunner {
  const now = options.now ?? (() => Date.now())
  const maxAgents = options.maxAgents ?? MAX_SCRIPT_AGENTS
  const store = options.store
  const runId = options.runId
  const steps: AgentStepTrace[] = []
  let stepIndex = 0
  let priorLoad: Promise<Map<number, AgentStepRecord>> | null = null
  let diverged = !store

  /**
   * Loaded once per run, shared as a promise: handing the second concurrent
   * agent() call a half-filled map made it miss every step and re-run the whole
   * fan-out, which is exactly the parallelism replay is supposed to skip.
   */
  const loadPrior = (): Promise<Map<number, AgentStepRecord>> => {
    if (!priorLoad) {
      priorLoad = (async () => {
        const loaded = new Map<number, AgentStepRecord>()
        if (store && runId) {
          try {
            for (const record of await store.listSteps(runId)) loaded.set(record.stepIndex, record)
          } catch {
            // Replay is best-effort: a missing table must not block a first run.
          }
        }
        return loaded
      })()
    }
    return priorLoad
  }

  /** Prior steps already served in this run, so a step is never reused twice. */
  const consumedPrior = new Set<number>()

  /**
   * Cache hit = same prompt text plus same options, preferring this step index.
   * Falling back to any unconsumed prior step keeps replay working when a script
   * fans agent() out behind async work and the calls land in another order; the
   * comparison is exact text, so reordering can never serve another prompt's
   * answer.
   */
  const findCachedStep = (
    prior: Map<number, AgentStepRecord>, index: number, prompt: string, optionsKey: string,
  ): AgentStepRecord | undefined => {
    const usable = (record: AgentStepRecord | undefined): record is AgentStepRecord =>
      !!record && record.status === 'completed' && !consumedPrior.has(record.stepIndex) &&
      record.prompt === prompt && record.optionsKey === optionsKey
    const exact = prior.get(index)
    if (usable(exact)) return exact
    for (const record of [...prior.values()].sort((a, b) => a.stepIndex - b.stepIndex)) {
      if (usable(record)) return record
    }
    return undefined
  }

  const runAgent = async (prompt: string, rawOptions?: JsonValue, signal?: AbortSignal): Promise<AgentRunOutcome> => {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('agent(prompt, options?) — prompt must be a non-empty string')
    }
    // A canceled run must not start new work.
    signal?.throwIfAborted()
    const normalized = normalizeOptions(rawOptions, options.agentMode)
    if (stepIndex >= maxAgents) {
      throw new Error(`agent budget exceeded: at most ${maxAgents} agent calls per script`)
    }
    const index = stepIndex++
    const promptHash = hashText(`${prompt}\u0000${normalized.optionsKey}`)

    if (store) {
      const prior = diverged ? undefined : findCachedStep(await loadPrior(), index, prompt, normalized.optionsKey)
      if (prior) {
        consumedPrior.add(prior.stepIndex)
        steps.push({ index, status: 'cached', agentId: prior.agentId ?? undefined })
        return { content: prior.result ?? '', agentId: prior.agentId, usage: null, cached: true }
      }
      diverged = true
    }

    const startedAt = now()
    try {
      const spawned = await spawnWithUniqueName(options.runtime, {
        description: normalized.name || `agent step ${index + 1}`,
        prompt,
        name: normalized.name,
        mode: options.agentMode === 'plan' ? 'plan' : normalized.mode,
        subagent_type: normalized.subagent_type,
        timeout_ms: normalized.timeout_ms,
        as: normalized.as,
        role: normalized.role,
        capabilities: normalized.capabilities,
        parentToolCallId: options.parentToolCallId,
      }, signal)
      const usage = spawned.usage as unknown as JsonValue | undefined
      // Cancellation between the child finishing and the write would otherwise
      // persist a `completed` row for a run the user already stopped, and the
      // next rerun would serve that output.
      signal?.throwIfAborted()
      if (store && runId) {
        try {
          await store.saveStep({
            runId,
            stepIndex: index,
            promptHash,
            prompt,
            optionsKey: normalized.optionsKey,
            agentId: spawned.agentId,
            name: normalized.name ?? null,
            status: 'completed',
            result: spawned.content,
            usageJson: usage === undefined ? null : JSON.stringify(usage),
            errorJson: null,
            startedAt,
            finishedAt: now(),
          })
        } catch {
          // Persistence failure only weakens replay; the step still counts.
        }
      }
      steps.push({
        index,
        status: 'completed',
        agentId: spawned.agentId,
        name: normalized.name,
        chars: spawned.content.length,
        usage,
        startedAt,
        finishedAt: now(),
      })
      return { content: spawned.content, agentId: spawned.agentId, usage: usage ?? null, cached: false }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A canceled step is not a failed step: writing it would poison the cache
      // with a failure caused by the user, not by the prompt.
      if (store && runId && !signal?.aborted) {
        try {
          await store.saveStep({
            runId,
            stepIndex: index,
            promptHash,
            prompt,
            optionsKey: normalized.optionsKey,
            agentId: null,
            name: normalized.name ?? null,
            status: 'failed',
            result: null,
            usageJson: null,
            errorJson: JSON.stringify({ message }),
            startedAt,
            finishedAt: now(),
          })
        } catch {
          // Keep the original failure.
        }
      }
      steps.push({ index, status: 'failed', name: normalized.name, error: message, startedAt, finishedAt: now() })
      throw error
    }
  }

  return { runAgent, steps }
}
