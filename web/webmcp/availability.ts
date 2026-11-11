/**
 * Why WebMCP exposed no tools for the captured page.
 *
 * The snapshot freezes this next to the tool list so history stays consistent
 * with what the agent saw. Only two states are knowable on the app side today:
 * the site authorization is off, or nothing resolved. "A package exists but its
 * urlRegex did not match" and "a package was rejected at catalog time" are not
 * recorded anywhere yet — see issue #273 — so they collapse into `unavailable`
 * rather than being guessed at.
 */
export type WebmcpAvailabilityState = 'ok' | 'host-disabled' | 'unavailable'

export function deriveWebmcpAvailability(input: {
  globalEnabled: boolean
  hostEnabled: boolean
  toolCount: number
}): WebmcpAvailabilityState {
  if (!input.globalEnabled || !input.hostEnabled) return 'host-disabled'
  return input.toolCount > 0 ? 'ok' : 'unavailable'
}
