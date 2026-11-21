/**
 * Deterministic 64-bit FNV-1a over UTF-16 code units, hex encoded.
 *
 * Used to compare request envelopes for equality — never as a security boundary,
 * so 64 bits is plenty and a collision only costs one skipped rebase (the journal
 * still verifies each source's own digest and throws on a mismatch).
 *
 * Lives in its own module so the SQLite migration can use exactly the same
 * function as the runtime; two implementations would drift and silently split
 * epochs.
 */
export function envelopeDigest(envelope: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < envelope.length; index++) {
    hash = ((hash ^ BigInt(envelope.charCodeAt(index))) * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}
