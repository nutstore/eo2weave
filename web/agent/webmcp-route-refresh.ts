/**
 * Race a legacy-route key refresh against the run's abort signal.
 *
 * The refresh is an OPTIMIZATION: it re-discovers the tab's current route
 * key so a stale key can be retried once. Every failure mode of the refresh
 * must therefore degrade to "no refreshed key" (undefined) and NEVER
 * propagate:
 *
 *   - the run aborted → the call must not dispatch a retry (#139 review:
 *     slow route refresh loses cancellation),
 *   - the refresh itself failed (network error, catalog endpoint down) →
 *     the original pre-execution routing error keeps its original
 *     classification. Letting the rejection escape reaches the outer catch,
 *     which would reclassify a provably pre-execution routing failure as an
 *     ambiguous write (#139 review round 6: safe route failures become
 *     ambiguous).
 */
export async function raceRouteRefreshAgainstAbort<T>(
  refresh: Promise<T>,
  abortSignal?: AbortSignal,
): Promise<T | undefined> {
  if (!abortSignal) {
    // No signal: a failed refresh still degrades to "no refreshed key".
    try {
      return await refresh
    } catch {
      return undefined
    }
  }
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      refresh.then(
        (value) => value,
        () => undefined,
      ),
      new Promise<undefined>((resolve) => {
        onAbort = () => resolve(undefined)
        if (abortSignal.aborted) onAbort()
        else abortSignal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } catch {
    return undefined
  } finally {
    if (onAbort) abortSignal.removeEventListener('abort', onAbort)
  }
}
