/**
 * Settled-outcome envelope for page-action retry dedupe (background).
 *
 * The settled cache stores WHAT happened, not just a value, so a late
 * retry can be answered faithfully:
 *   - `status: 'ok'` — the run resolved; `outcome` is exactly what the
 *     first run returned (undefined means the action really produced
 *     undefined — but see the corrupt-entry guard below);
 *   - `status: 'error'` — the run REJECTED (tab lock, queue abort,
 *     unexpected crash). The rejection is cached as a structured
 *     ok:false failure so a retry replays the failure instead of a
 *     swallowed `undefined`.
 *
 * CORRUPT-ENTRY GUARD: a page-action runner result is ALWAYS an object
 * with an `ok` boolean. A settled run that resolved to `undefined`
 * cannot be a legitimate runner outcome — it means the value was lost
 * between the runner and the settlement handler. Caching it verbatim
 * would make every retry replay a meaningless `undefined` as if the
 * action had succeeded; the guard converts it into an explicit,
 * retryable error instead. Falsy-but-defined values (false, 0, null,
 * '') are legitimate results and pass through untouched.
 */

export type PageActionSettledErrorOutcome = {
  ok: false
  errorCode: string
  error: string
}

export type PageActionSettledEntry =
  | { status: 'ok'; outcome: unknown }
  | { status: 'error'; outcome: PageActionSettledErrorOutcome }

/**
 * Wrap a settled run outcome (the value the run resolved to) into the
 * stored envelope. Called on BOTH resolve and reject paths:
 *   - the caller catches the rejection and passes a
 *     `PageActionSettledErrorOutcome` (never a bare undefined);
 *   - a resolved `undefined` is flagged as a corrupt entry (see above).
 */
export function describeSettledOutcome(outcome: unknown): PageActionSettledEntry {
  if (outcome === undefined) {
    return {
      status: 'error',
      outcome: {
        ok: false,
        errorCode: 'PAGE_ACTION_SETTLED_ENTRY_CORRUPT',
        error:
          'The recorded result of the first run was lost (the run settled without a usable outcome). The action DID run once; this is a transport-level bookkeeping failure, not a new execution. Retry the action if its effect is still needed.',
      },
    }
  }
  return { status: 'ok', outcome }
}

/**
 * Answer a late retry from a stored settled entry. `status: 'ok'`
 * replays the recorded value verbatim (backward compatible — the caller
 * sees exactly what the first run returned); `status: 'error'` replays
 * the structured failure.
 */
export function replayedSettledOutcome(entry: PageActionSettledEntry): unknown {
  return entry.outcome
}

/**
 * Heuristic plausibility check for a page-action runner outcome: the
 * runner ALWAYS resolves with `{ ok: boolean, ... }` (see
 * injected.content.ts `runBoundPageAction` and the background's own
 * structured error shapes). Anything object-shaped with a boolean `ok`
 * field counts as a legitimate result.
 */
export function isPlausibleRunnerResult(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  )
}

/**
 * How long a settled outcome stays in the dedupe cache. It must cover
 * the bridge caller's ENTIRE retry window (one retry, full budget, see
 * injected.content.ts runBoundPageAction): the first run's bridge
 * request times out at T, the caller retries immediately, and that
 * retry's own request lives up to another full window. A shorter TTL
 * would let a late-but-legitimate retry find no record and execute the
 * SAME logical action a second time. 300s window + 5s scheduling slack.
 */
export const PAGE_ACTION_RETRY_MEMORY_MS = 305_000

/**
 * Drop settled entries older than the retry-memory window. Keeps the
 * cache bounded without ever suppressing a retry that can still arrive:
 * after the window, the original caller's retry chain is provably dead
 * (its last bridge request expired), so a same-id submission can only
 * be a genuinely new run.
 */
export function pruneSettledEntries<T extends { settledAt: number }>(
  map: Map<string, T>,
  ttlMs: number = PAGE_ACTION_RETRY_MEMORY_MS,
  now: number = Date.now(),
): void {
  for (const [key, entry] of map) {
    if (now - entry.settledAt > ttlMs) map.delete(key)
  }
}
