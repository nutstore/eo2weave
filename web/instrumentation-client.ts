/**
 * Next.js client instrumentation hook.
 *
 * This module is loaded at the very top of Next's client entry (before
 * app-globals.js registers the dev-tools `unhandledrejection` handler), which
 * makes it the guaranteed-first registration point for the agent-abort
 * rejection filter. The filter needs `stopImmediatePropagation()` to keep
 * expected agent cancellations away from the Next.js dev overlay, and that
 * only works for listeners registered AFTER ours.
 *
 * Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  const { installAgentAbortRejectionFilter } = await import('@/lib/agent-abort')
  installAgentAbortRejectionFilter(window)
}
