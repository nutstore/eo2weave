/**
 * Stable request identity for page actions.
 *
 * The page-side bridge caller (`runBoundPageAction` in
 * injected.content.ts) stamps every submission with a `__cwRequestId`
 * before the action crosses the bridge. The background keys its retry
 * dedupe on that id, so a RETRY of the same logical action — e.g. a
 * caller that resubmits after a bridge timeout while the first
 * execution is still in flight — must carry the SAME id to join the
 * first run instead of queueing a duplicate execution.
 *
 * A per-invocation counter cannot do that (every call gets a fresh
 * id), so the id is derived from the action's CONTENT: the same
 * logical action always yields the same id, and different actions
 * yield different ids. Combined with the background's settlement-based
 * entry removal (the dedupe entry is deleted as soon as the run
 * settles), this gives exactly the desired split:
 *   - a retry while the first run is in flight → joins it;
 *   - a LATER, independent submission of an identical action (the
 *     first run already settled) → runs again, as it should.
 */

/** The transport-only key carrying the request identity. */
export const PAGE_ACTION_REQUEST_ID_KEY = '__cwRequestId'

/**
 * Deterministically serialize a value (object keys sorted) so that two
 * structurally identical actions produce identical strings regardless
 * of property insertion order. Returns null when the value cannot be
 * serialized (cyclic structure) — the caller then skips stamping and
 * the action simply runs without dedupe, as a legacy caller would.
 */
function stableSerialize(value: unknown): string | null {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'number') return Number.isFinite(value as number) ? String(value) : 'null'
  if (t === 'boolean' || t === 'undefined') return String(value)
  if (t === 'string') return JSON.stringify(value)
  if (t === 'function') return 'undefined'
  if (t !== 'object') return 'undefined'
  const seen = value as { __cwCyclic?: boolean }
  if (seen.__cwCyclic) return null
  try {
    ;(value as { __cwCyclic?: boolean }).__cwCyclic = true
    if (Array.isArray(value)) {
      const parts: string[] = []
      for (const item of value) {
        const s = stableSerialize(item)
        if (s === null) return null
        parts.push(s)
      }
      return '[' + parts.join(',') + ']'
    }
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    const parts: string[] = []
    for (const k of keys) {
      if (k === '__cwCyclic') continue
      const s = stableSerialize(obj[k])
      if (s === null) return null
      parts.push(JSON.stringify(k) + ':' + s)
    }
    return '{' + parts.join(',') + '}'
  } finally {
    delete (value as { __cwCyclic?: boolean }).__cwCyclic
  }
}

/** FNV-1a 32-bit hash, hex-encoded. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Derive the stable request id for a logical action. Returns '' for
 * non-object actions or actions that cannot be deterministically
 * serialized — those are never deduped by the background.
 */
export function stablePageActionRequestId(action: unknown): string {
  if (!action || typeof action !== 'object') return ''
  const serialized = stableSerialize(action)
  if (serialized === null) return ''
  return '__cw_' + fnv1a(serialized) + '_' + serialized.length
}
