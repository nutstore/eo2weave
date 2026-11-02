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
 *
 * Minted reasons are tracked in `ourReasons` so `isExpectedAgentAbort` can
 * verify ownership instead of trusting any AbortError that happens to carry
 * the prefix (a foreign subsystem could mint an identical message).
 */
export function createAgentAbortReason(name: AgentAbortReasonName): DOMException {
  return registerAgentAbortError(new DOMException(name, 'AbortError'))
}

/**
 * Mark an AbortError created outside `createAgentAbortReason` (fallbacks in
 * stream bridges, worker clients) as one of ours, so the rejection filter
 * recognizes it too.
 */
export function registerAgentAbortError(error: DOMException): DOMException {
  ourReasons.add(error)
  return error
}

/** Reasons minted (or registered) by this module — the ownership check. */
const ourReasons = new WeakSet<object>

/**
 * True only for AbortErrors that BOTH carry the `agent-cancelled` prefix AND
 * were minted by this module (createAgentAbortReason / registerAgentAbortError).
 * The prefix keeps the diagnostic contract; the WeakSet check is the actual
 * discriminator, so a foreign subsystem copying the prefix is NOT suppressed.
 */
export function isExpectedAgentAbort(reason: unknown): reason is DOMException {
  return (
    reason instanceof DOMException &&
    reason.name === 'AbortError' &&
    reason.message.startsWith(AGENT_ABORT_PREFIX) &&
    ourReasons.has(reason)
  )
}

/**
 * Extract a human-readable message from an abort reason. DOMException does
 * NOT reliably pass `instanceof Error` in every browser engine, so both
 * shapes are handled explicitly.
 */
export function abortReasonMessage(reason: unknown): string | null {
  if (reason instanceof Error) return reason.message
  if (typeof DOMException !== 'undefined' && reason instanceof DOMException) return reason.message
  return null
}

/** Windows that already have the unhandledrejection filter attached. */
const installedTargets = new WeakSet<Window>()

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
  if (installedTargets.has(target)) return
  installedTargets.add(target)
  // Suppression must reach the OTHER listeners too: preventDefault() only
  // cancels the browser's default reporting (console), it does not stop
  // Next.js dev-tools' `unhandledrejection` listener from queuing the
  // rejection into the dev overlay. stopImmediatePropagation() does — but
  // only for listeners registered AFTER ours. Next registers its handler in
  // app-globals.js (devtools setup), which runs before any React effect, so
  // this filter is installed from instrumentation-client.ts (loaded at the
  // top of the Next client entry) to guarantee first-registration order.
  target.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = (event as PromiseRejectionEvent).reason
    if (isExpectedAgentAbort(reason)) {
      event.preventDefault()
      // Keep a breadcrumb for debugging without triggering the dev overlay.
      console.debug('[AgentAbort] suppressed expected cancellation:', reason.message)
      event.stopImmediatePropagation()
    }
  })
}
