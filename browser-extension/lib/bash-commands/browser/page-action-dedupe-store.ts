/**
 * Restart-safe persistence for page-action retry dedupe (background).
 *
 * The in-flight and settled dedupe records live in module-scope maps in
 * the MV3 service worker. Chrome may terminate and restart the worker at
 * ANY time — including after an action has started (or already settled)
 * but before its retry arrives. On restart the maps are empty, so a
 * retry with the same request id finds no record and executes the action
 * AGAIN, duplicating page side effects.
 *
 * Fix: mirror every dedupe record into `chrome.storage.session` — the
 * standard MV3 pattern for exactly this problem. Session storage:
 *   - survives service-worker restarts (the in-memory maps do not);
 *   - is available in the SW context;
 *   - is cleared when the browser session ends (no stale cross-session
 *     leakage).
 *
 * Record kinds:
 *   - `{ kind: 'inflight' }`  — a run was STARTED. After a restart there
 *     is no live promise behind it: the run died with the old worker and
 *     its outcome is unknown (the action MAY have executed). The caller
 *     must get a structured "interrupted" failure, NEVER a re-execution.
 *   - `{ kind: 'settled' }`   — the run SETTLED. The recorded outcome
 *     envelope is replayed verbatim, exactly as the in-memory settled
 *     cache would.
 *
 * The in-memory map is a write-through cache: on the happy path (no
 * restart) lookups never touch storage; after a restart the first lookup
 * hydrates the record from session storage. Storage failures are
 * best-effort — persistence strengthens dedupe, and a storage error must
 * never break the action itself.
 */

import type { PageActionSettledEntry } from './page-action-settled-outcome'

export type PageActionDedupeRecord =
  | { kind: 'inflight'; startedAt: number }
  | { kind: 'settled'; entry: PageActionSettledEntry; settledAt: number }

const STORAGE_KEY_PREFIX = 'pageActionDedupe:'

/** Write-through cache: hot path, repopulated from session storage after a SW restart. */
const memory = new Map<string, PageActionDedupeRecord>()

/**
 * Minimal structural type for `chrome.storage.session` — declared
 * structurally (no chrome type dependency) so this module also
 * typechecks outside the extension build (the web test suite imports
 * sibling modules from this directory).
 */
type SessionAreaLike = {
  get: (key: string) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>) => Promise<void>
  remove: (key: string) => Promise<void>
}

function sessionArea(): SessionAreaLike | undefined {
  const chrome = (globalThis as { chrome?: unknown }).chrome as
    | { storage?: { session?: unknown } }
    | undefined
  const area = chrome?.storage?.session as SessionAreaLike | undefined
  return area && typeof area.get === 'function' && typeof area.set === 'function' ? area : undefined
}

function isWellFormedRecord(value: unknown): value is PageActionDedupeRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  if (r.kind === 'inflight') return typeof r.startedAt === 'number'
  if (r.kind === 'settled') {
    const entry = r.entry as Record<string, unknown> | undefined
    return (
      typeof r.settledAt === 'number' &&
      !!entry &&
      typeof entry === 'object' &&
      (entry.status === 'ok' || entry.status === 'error')
    )
  }
  return false
}

/**
 * Read the dedupe record for `key`. Checks the in-memory cache first,
 * then session storage (hydrating the cache on a hit — the restart
 * path). A missing or malformed record reads as absent.
 */
export async function readDedupeRecord(key: string): Promise<PageActionDedupeRecord | undefined> {
  const local = memory.get(key)
  if (local) return local
  const area = sessionArea()
  if (!area) return undefined
  try {
    const storageKey = STORAGE_KEY_PREFIX + key
    const stored = await area.get(storageKey)
    const record = stored?.[storageKey]
    if (isWellFormedRecord(record)) {
      memory.set(key, record)
      return record
    }
    return undefined
  } catch {
    // Storage is best-effort: an unavailable/failing backend degrades to
    // the in-memory-only behavior this file existed to improve upon.
    return undefined
  }
}

/** Record a dedupe state change (start / settle). Fire-and-forget safe. */
export async function writeDedupeRecord(key: string, record: PageActionDedupeRecord): Promise<void> {
  memory.set(key, record)
  const area = sessionArea()
  if (!area) return
  try {
    await area.set({ [STORAGE_KEY_PREFIX + key]: record })
  } catch {
    // Best-effort (see readDedupeRecord).
  }
}

/** Drop the record both from memory and session storage. */
export async function clearDedupeRecord(key: string): Promise<void> {
  memory.delete(key)
  const area = sessionArea()
  if (!area) return
  try {
    await area.remove(STORAGE_KEY_PREFIX + key)
  } catch {
    // Best-effort (see readDedupeRecord).
  }
}

/** Test hook: drop the in-memory mirror only (storage fakes are per-test). */
export function resetDedupeStoreForTest(): void {
  memory.clear()
}
