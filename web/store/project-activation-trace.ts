/**
 * Timing instrumentation for the project-activation chain (issue #316).
 *
 * `setActiveProject` in project.store.ts awaits a long chain of SQLite, OPFS,
 * dynamic-import and store work with no overall deadline. When one of those
 * awaits never settles, the app stays on the startup screen with `isLoading`
 * stuck at true and — before this module — no log line naming the pending
 * operation, so the stall could not be attributed without a debugger.
 *
 * Every step here logs a start line, an end line with its own duration, and the
 * elapsed time since activation began; a watchdog re-announces the step that is
 * still pending so a hang names itself in the console. This is logging only: no
 * step is timed out, cancelled, retried or reordered.
 */

const LOG_PREFIX = '[ProjectActivation]'

/** How often a still-running activation re-announces its pending step. */
export const ACTIVATION_STALL_LOG_INTERVAL_MS = 10_000

export type ActivationOutcome = 'ok' | 'not-found' | 'failed'

export interface ProjectActivationTrace {
  readonly projectId: string
  /** Runs `run` as a named step, logging its start, duration and failure. */
  step<T>(name: string, run: () => Promise<T> | T): Promise<T>
  /** Name of the step currently awaited, or null between steps. */
  pendingStep(): string | null
  /** Logs the outcome and total duration, and stops the stall watchdog. */
  finish(outcome: ActivationOutcome): void
}

export interface ProjectActivationTraceOptions {
  /** Overrides the stall log interval; 0 disables the watchdog. */
  stallLogIntervalMs?: number
}

function elapsedSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * The activation currently in flight, if any. Read by the route-sync guard so a
 * blocked sync can log which activation step it is waiting behind.
 */
let activeTrace: ProjectActivationTrace | null = null

export function getPendingActivationStep(): string | null {
  return activeTrace ? activeTrace.pendingStep() : null
}

export function getActiveActivationProjectId(): string | null {
  return activeTrace ? activeTrace.projectId : null
}

export function createProjectActivationTrace(
  projectId: string,
  options: ProjectActivationTraceOptions = {},
): ProjectActivationTrace {
  const startedAt = performance.now()
  const stallLogIntervalMs = options.stallLogIntervalMs ?? ACTIVATION_STALL_LOG_INTERVAL_MS
  let pending: string | null = null
  let finished = false
  let watchdog: ReturnType<typeof setInterval> | undefined

  const stopWatchdog = () => {
    if (watchdog !== undefined) {
      clearInterval(watchdog)
      watchdog = undefined
    }
  }

  if (stallLogIntervalMs > 0 && typeof setInterval === 'function') {
    watchdog = setInterval(() => {
      // Only a step that is still awaited is worth re-announcing: between steps
      // the chain is running synchronous code and a stall there would surface as
      // a frozen tab, not as a silent await.
      if (finished || pending === null) return
      console.warn(`${LOG_PREFIX} still pending`, {
        projectId,
        step: pending,
        elapsedMs: elapsedSince(startedAt),
      })
    }, stallLogIntervalMs)
    // A diagnostic timer must not keep a test process or a background tab alive.
    const handle = watchdog as unknown as { unref?: () => void }
    if (typeof handle.unref === 'function') handle.unref()
  }

  const trace: ProjectActivationTrace = {
    projectId,

    pendingStep: () => pending,

    async step<T>(name: string, run: () => Promise<T> | T): Promise<T> {
      pending = name
      const stepStartedAt = performance.now()
      console.log(`${LOG_PREFIX} step start`, {
        projectId,
        step: name,
        atMs: elapsedSince(startedAt),
      })
      try {
        const result = await run()
        const stepMs = Math.round(performance.now() - stepStartedAt)
        pending = null
        console.log(`${LOG_PREFIX} step done`, {
          projectId,
          step: name,
          stepMs,
          atMs: elapsedSince(startedAt),
        })
        return result
      } catch (error) {
        const stepMs = Math.round(performance.now() - stepStartedAt)
        pending = null
        console.warn(`${LOG_PREFIX} step failed`, {
          projectId,
          step: name,
          stepMs,
          atMs: elapsedSince(startedAt),
          error: describeError(error),
        })
        throw error
      }
    },

    finish(outcome: ActivationOutcome) {
      if (finished) return
      finished = true
      pending = null
      stopWatchdog()
      const log = outcome === 'ok' ? console.log : console.warn
      log(`${LOG_PREFIX} finished`, {
        projectId,
        outcome,
        totalMs: elapsedSince(startedAt),
      })
      if (activeTrace === trace) activeTrace = null
    },
  }

  activeTrace = trace
  return trace
}

/** Test seam: drops the in-flight trace reference between cases. */
export function resetActiveActivationTraceForTests(): void {
  activeTrace = null
}
