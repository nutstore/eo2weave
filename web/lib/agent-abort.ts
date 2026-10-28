/**
 * Agent abort-reason utilities.
 *
 * AgentLoop cancels its work by calling `abort(reason)` with a semantic
 * DOMException whose message starts with `agent-cancelled`. Downstream code
 * (stream bridges, workers) and the dev-overlay noise filter can then
 * distinguish *expected* internal cancellations from genuine errors
 * (timeouts, external aborts), which must still surface.
 */

export const AGENT_ABORT_PREFIX = 'agent-cancelled'

/** Semantic reason names for the agent cancellation chain. */
export const AgentAbortReasonName = {
  /** User clicked Stop / cancelled the conversation. */
  ByUser: 'agent-cancelled-by-user',
  /** Internal loop request abort (e.g. stopping an in-flight LLM stream). */
  Internal: 'agent-cancelled-internal',
  /** Loop hit its max-iteration cap and is shutting down in-flight work. */
  IterationLimit: 'agent-cancelled-iteration-limit',
  /** Loop lifecycle teardown (completed/errored; cleans queued listeners). */
  LifecycleTeardown: 'agent-cancelled-lifecycle-teardown',
} as const

export type AgentAbortReasonName = (typeof AgentAbortReasonName)[keyof typeof AgentAbortReasonName]

/**
 * Create a semantic AbortError DOMException used as an abort reason.
 * The message always carries the `agent-cancelled` prefix so it can be
 * recognized downstream.
 */
export function createAgentAbortReason(name: AgentAbortReasonName): DOMException {
  return new DOMException(name, 'AbortError')
}

/** True if the value looks like an AbortError with our `agent-cancelled` prefix. */
export function isExpectedAgentAbort(reason: unknown): reason is DOMException {
  return (
    reason instanceof DOMException &&
    reason.name === 'AbortError' &&
    reason.message.startsWith(AGENT_ABORT_PREFIX)
  )
}

let installed = false

/**
 * Narrow unhandledrejection filter: suppress only rejections whose reason is
 * one of OUR agent-cancelled AbortErrors. These rejections can escape from
 * async contexts (stream bridges, worker clients) that raced the loop's own
 * graceful `signal.aborted` handling, and would otherwise show up as a raw
 * "signal is aborted without reason" error in the Next.js dev overlay.
 *
 * Other AbortErrors (timeouts, external cancels, genuine bugs) are NOT
 * intercepted and still surface normally.
 */
export function installAgentAbortRejectionFilter(target: Window = window): void {
  if (installed) return
  installed = true
  target.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = (event as PromiseRejectionEvent).reason
    if (isExpectedAgentAbort(reason)) {
      event.preventDefault()
      // Keep a breadcrumb for debugging without triggering the dev overlay.
      console.debug('[AgentAbort] suppressed expected cancellation:', reason.message)
    }
  })
}
