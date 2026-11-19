/**
 * OpenCode Go session routing.
 *
 * Go rejects any request that lacks `x-opencode-session` with
 * `400 MissingSessionID`, so EVERY request to the Go gateway — the agent loop,
 * auxiliary calls (titles, context summaries, follow-up suggestions), subagents
 * — must carry a stable session id. Console uses it to route a conversation to
 * the same upstream and reuse its prompt cache.
 *
 * @see https://opencode.ai/docs/console/harnesses
 */

export const OPENCODE_GO_PROVIDER = 'opencode-go'

/**
 * Build the session header for an OpenCode Go request, preserving any headers
 * the caller already set. Returns undefined for every other provider so callers
 * can spread it conditionally without branching themselves.
 */
export function opencodeGoSessionHeaders(
  provider: string | undefined,
  sessionId: string | undefined,
  existing?: Record<string, string>,
): Record<string, string> | undefined {
  if (provider !== OPENCODE_GO_PROVIDER || !sessionId) return undefined
  return { ...(existing ?? {}), 'x-opencode-session': sessionId }
}

/**
 * Fallback session id for callers that do not know the conversation id.
 * Stable for the lifetime of one provider instance, which is what Console
 * needs to keep routing a request stream consistently.
 */
export function createProviderSessionId(): string {
  return `ses_cw_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}
