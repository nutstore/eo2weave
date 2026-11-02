/**
 * Next.js client instrumentation hook.
 *
 * This module is evaluated at the very top of Next's client entry (before
 * app-globals.js registers the dev-tools `unhandledrejection` handler). The
 * filter installation therefore runs at MODULE LOAD (top level), not inside
 * `register()` — Next only invokes `register()` on its own schedule, which
 * could be after the devtools listener is already attached, defeating the
 * registration-order guarantee that `stopImmediatePropagation()` relies on.
 *
 * Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
import { installAgentAbortRejectionFilter } from '@/lib/agent-abort'

if (typeof window !== 'undefined') {
  installAgentAbortRejectionFilter(window)
}

// Kept for Next's instrumentation hook contract; installation above does not
// depend on Next calling this.
export async function register() {
  if (typeof window !== 'undefined') {
    installAgentAbortRejectionFilter(window)
  }
}
