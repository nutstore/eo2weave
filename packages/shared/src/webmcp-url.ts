/** Longest URL a tool pattern is matched against. */
const MAX_MATCH_URL_LENGTH = 4096

/**
 * Catastrophic backtracking ("ReDoS") guard for tool URL patterns.
 *
 * A pattern that lets the matching engine split the same input span between
 * two quantifiers — a quantified group whose body can match empty, starts
 * with a quantified atom (the classic `(a+)+`), or carries overlapping
 * alternation branches — can take exponential time on a long non-matching
 * input. A registry package could ship such a pattern and stall the
 * extension's service worker while it probes the tab URL.
 *
 * The check below is a conservative structural scan, deliberately broader
 * than a literal "nested quantifier" pattern: it also rejects repeated
 * ambiguous alternations, bounded repeats over quantified bodies
 * (`(a+){2,4}`), and nested groups that bottom out in a quantifier. A tool
 * URL pattern has no reason to use any of these shapes, and every builtin
 * pattern stays unaffected.
 *
 * The patterns are rejected at VALIDATION time (manifest validation, which
 * both the installer and the extension catalog run), so a hostile package
 * never reaches the matching stage.
 */

interface SequenceAnalysis {
  /** The whole sequence can match the empty string. */
  canMatchEmpty: boolean
  /**
   * The FIRST atom of the sequence carries a quantifier (`(a+)` → true).
   * Atom here means ANY top-level atom, including a group: the value is
   * propagated OUT of group bodies so a wrapper cannot hide a quantified
   * first atom from an enclosing group's analysis (finding: "Nested
   * wrappers bypass regex guard" — `((a+))+` used to lose the inner
   * `leadingAtomQuantified` because the wrapper's own body analysis
   * discarded it).
   */
  leadingAtomQuantified: boolean
  /**
   * The sequence contains a top-level `|` anywhere, OR any nested group
   * body analysed here reported an alternation/overlapping-branch risk —
   * both let repeated branches overlap when the whole atom is quantified
   * (`(a|aa)*`, and `((a|aa))+` through the same propagation).
   */
  alternation: boolean
  /**
   * The FIRST atom of the sequence ends in a quantified atom at its top
   * level — the body starts `a+…` or `(...)+…` with no leading separator.
   * Quantifying a group over such a body (`(a+)(a+)+`, `((a+)(a+))+`)
   * splits input spans between adjacent quantifiers (finding: "URL
   * matching stalls on backtracking").
   */
  leadingAtomEndsQuantified: boolean
}

/**
 * Scan past a character class starting at `pattern[open]` (the `[`).
 * Returns the index just past the closing `]`, honoring `\]` escapes —
 * ending at the FIRST unescaped `]` (finding: "Escaped classes bypass
 * ReDoS guard": `[a\]x]+` used to scan as `[a\]`, leaving the trailing
 * `x]+` misparsed as top-level atoms).
 */
function classEnd(pattern: string, open: number): number {
  let i = open + 1
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '\\') { i += 2; continue }
    if (c === ']') return i + 1
    i += 1
  }
  return pattern.length // unterminated class — treat as consuming the rest
}

function isQuantifierChar(char: string | undefined): boolean {
  return char === '*' || char === '+' || char === '?' || char === '{'
}

/** Zero-repetition minimum for the quantifier at `index`, or null. */
function quantifierAllowsZero(pattern: string, index: number): boolean | null {
  const char = pattern[index]
  if (char === '*' || char === '?') return true
  if (char === '+') return false
  if (char === '{') {
    const close = pattern.indexOf('}', index)
    if (close === -1 || !/^\d+(,\d*)?$/.test(pattern.slice(index + 1, close))) return null
    const min = (pattern.slice(index + 1, close).split(',')[0] ?? '').trim()
    return min === '' || min === '0'
  }
  return null
}

/** Where a group's BODY starts, skipping `(?:`, `(?=`, `(?<name>`, … */
function groupBodyStart(pattern: string, open: number): number {
  if (pattern.startsWith('(?<', open)) {
    const arrow = pattern.indexOf('>', open)
    return arrow !== -1 ? arrow + 1 : open + 3
  }
  return pattern.startsWith('(?', open) ? open + 3 : open + 1
}

/**
 * Analyze `pattern[from, until)` — a sequence of atoms possibly joined by
 * top-level `|`. Returns null when the fragment is malformed in a way this
 * scanner does not model (the RegExp constructor reports those, not this
 * guard).
 */
function analyzeSequence(pattern: string, from: number, until: number): SequenceAnalysis {
  /** Skippability of each top-level atom, in order. */
  const atoms: boolean[] = []
  /** Index just past the FIRST atom — a quantifier here targets it. */
  let firstAtomEnd = -1
  /** Risk flags reported by nested group bodies (propagated outward). */
  let nestedLeadingQuantified = false
  let nestedAlternation = false
  let alternation = false
  let emptyBranch = false
  let depth = 0
  let groupOpen = -1
  let i = from
  while (i < until) {
    const char = pattern[i]
    if (char === '\\') {
      atoms.push(false)
      i += 2
      if (firstAtomEnd === -1) firstAtomEnd = i
      continue
    }
    if (char === '[') {
      i = classEnd(pattern, i)
      atoms.push(false)
      if (firstAtomEnd === -1) firstAtomEnd = i
      continue
    }
    if (char === '(') {
      if (depth === 0) groupOpen = i
      depth += 1
      i += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      if (depth === 0 && groupOpen !== -1) {
        const bodyStart = groupBodyStart(pattern, groupOpen)
        // A group atom is skippable when its own body can match empty.
        const inner = bodyStart <= i ? analyzeSequence(pattern, bodyStart, i) : null
        // Propagate the body's own risk flags outward (finding: "Nested
        // wrappers bypass regex guard") — a wrapper group must not be able
        // to hide a quantified first atom or an overlapping alternation
        // from the ENCLOSING group's body analysis.
        if (inner) {
          nestedLeadingQuantified ||= inner.leadingAtomQuantified
          nestedAlternation ||= inner.alternation
        }
        atoms.push(inner ? inner.canMatchEmpty : false)
        i += 1
        if (firstAtomEnd === -1) firstAtomEnd = i
        groupOpen = -1
        continue
      }
      i += 1
      continue
    }
    if (char === '|' && depth === 0) {
      alternation = true
      const prev = i > from ? pattern[i - 1] : '('
      const next = i + 1 < until ? pattern[i + 1] : ')'
      if (prev === '|' || prev === '(' || next === '|' || next === ')') emptyBranch = true
      i += 1
      continue
    }
    if (isQuantifierChar(char) && depth === 0) {
      const quantifierAt = i
      let allowsZero: boolean | null
      if (char === '{') {
        const close = pattern.indexOf('}', i)
        allowsZero = close !== -1 && close < until ? quantifierAllowsZero(pattern, i) : null
        if (allowsZero === null) {
          // Not a quantifier — a literal `{`.
          atoms.push(false)
          i += 1
          if (firstAtomEnd === -1) firstAtomEnd = i
          continue
        }
        i = close + 1
      } else {
        allowsZero = char !== '+'
        i += 1
      }
      // A trailing `?` is a lazy modifier, part of the same quantifier.
      if (pattern[i] === '?') i += 1
      if (atoms.length > 0) atoms[atoms.length - 1] = atoms[atoms.length - 1]! || allowsZero!
      if (firstAtomEnd === quantifierAt) {
        // The quantifier targeted the first atom of this sequence.
        return {
          canMatchEmpty: false,
          leadingAtomQuantified: true,
          alternation: alternation || nestedAlternation,
          leadingAtomEndsQuantified: true,
        }
      }
      continue
    }
    if (char === '|' || isQuantifierChar(char)) {
      // Quantifier inside a nested group — belongs to the inner scan.
      i += 1
      continue
    }
    if (depth > 0) {
      // Any other character inside a nested group belongs to the INNER
      // analysis, not to this sequence's atom list — counting it here would
      // desynchronize `firstAtomEnd` and hide a quantifier that targets the
      // group itself (`((a)*)+`).
      i += 1
      continue
    }
    // Plain character atom.
    atoms.push(false)
    i += 1
    if (firstAtomEnd === -1) firstAtomEnd = i
  }
  const canMatchEmpty =
    emptyBranch ||
    atoms.length === 0 ||
    (!alternation && atoms.every(skippable => skippable))
  return {
    canMatchEmpty,
    leadingAtomQuantified: false,
    alternation: alternation || nestedAlternation,
    // The first top-level atom of this body is a group whose own body
    // began with a quantified atom (`((a+)(a+))+` wrapper shape) —
    // propagated from the nested scan so no wrapper can hide it.
    leadingAtomEndsQuantified: nestedLeadingQuantified,
  }
}

/**
 * True when quantifying this group body creates a backtracking risk:
 * the body can match empty (skip ambiguity — `(?:a*)*`, `(|a)*`),
 * its first atom is itself quantified (consume ambiguity — `(a+)+`,
 * `(x+x+)+y`, `(a+){2,4}`), or it carries a top-level alternation whose
 * branches may overlap when repeated (`(a|aa)+`).
 */
function bodyIsDangerous(pattern: string, bodyStart: number, bodyEnd: number): boolean {
  if (bodyStart >= bodyEnd) return true // `()*` — empty body matches empty
  const body = analyzeSequence(pattern, bodyStart, bodyEnd)
  return (
    body.canMatchEmpty ||
    body.leadingAtomQuantified ||
    body.alternation ||
    // The body STARTS with a quantified atom (`(a+)(a+)+`): quantifying
    // the group splits input spans between the leading inner quantifier
    // and the outer one — adjacent overlapping quantifiers (finding:
    // "URL matching stalls on backtracking").
    body.leadingAtomEndsQuantified
  )
}

/**
 * Flat quantifier-chain scan: three or more ADJACENT quantified atoms
 * (`a*a*a*`, `.*.*.*`, `(?:x)(?:y)(?:z)` all quantified back-to-back)
 * whose operands all consume input give the engine factorial-split work —
 * and such chains carry no groups, so the group-body scan below cannot see
 * them (finding: "URL matching stalls on near-matches"). Legitimate URL
 * patterns never chain quantified atoms back-to-back: quantified atoms in
 * real patterns are separated by literal separators (`/v[0-9]+/`).
 */
function hasFlatQuantifierChain(pattern: string): boolean {
  let depth = 0
  // Streak of consecutive QUANTIFIED atoms at the top level. An atom that
  // ends WITHOUT a quantifier resets it (real separators anchor the match);
  // an alternation resets it too. `a*a*a*` -> 3 -> rejected;
  // `/v[0-9]+/x+` -> 1,1 (separated) -> allowed.
  let run = 0
  let pendingAtom = false
  let prevAtomQuantified = true
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '\\') { i += 1; pendingAtom = true; continue }
    if (char === '[') {
      i = classEnd(pattern, i) - 1
      pendingAtom = true
      continue
    }
    if (char === '(') {
      if (pendingAtom && !prevAtomQuantified) run = 0
      depth += 1
      pendingAtom = false
      prevAtomQuantified = true
      continue
    }
    if (char === ')') {
      depth -= 1
      pendingAtom = depth === 0
      continue
    }
    if (char === '|') {
      if (depth === 0) run = 0
      pendingAtom = false
      prevAtomQuantified = true
      continue
    }
    if (isQuantifierChar(char) && depth === 0) {
      if (char === '{') {
        const close = pattern.indexOf('}', i)
        if (close === -1 || !/^\d+(,\d*)?$/.test(pattern.slice(i + 1, close))) {
          pendingAtom = true
          continue
        }
        i = close
      }
      if (pattern[i + 1] === '?') i += 1
      run += 1
      prevAtomQuantified = true
      if (run >= 3) return true
      continue
    }
    if (isQuantifierChar(char)) { i += 1; continue } // quantifier inside a group
    // Plain character STARTS a new atom: if the previous atom ended without
    // a quantifier, the streak breaks.
    if (pendingAtom && !prevAtomQuantified) run = 0
    pendingAtom = true
    prevAtomQuantified = false
  }
  // Trailing atom that ended without a quantifier.
  if (pendingAtom && !prevAtomQuantified) run = 0
  return false
}

/**
 * Index just past the first top-level atom of `pattern[from, until)` when
 * that atom carries a quantifier, else -1. Used to detect a body that
 * STARTS with a quantified atom (`(a+)(a+)+` — adjacent quantifiers).
 */
function firstAtomQuantifiedEnd(pattern: string, from: number, until: number): number {
  let depth = 0
  let groupOpen = -1
  let firstAtomEnd = -1
  let i = from
  while (i < until) {
    const char = pattern[i]
    if (char === '\\') { i += 2; if (firstAtomEnd === -1) firstAtomEnd = i; return -1 }
    if (char === '[') { i = classEnd(pattern, i); if (firstAtomEnd === -1) firstAtomEnd = i; return -1 }
    if (char === '(') { if (depth === 0) groupOpen = i; depth += 1; i += 1; continue }
    if (char === ')') {
      depth -= 1
      if (depth === 0 && groupOpen !== -1) {
        i += 1
        if (firstAtomEnd === -1) firstAtomEnd = i
        groupOpen = -1
        continue
      }
      i += 1
      continue
    }
    if (isQuantifierChar(char) && depth === 0) {
      // The quantifier must target the FIRST atom: if any atom was already
      // closed before this position, this quantifier belongs to a LATER
      // atom — the first atom is unquantified.
      if (firstAtomEnd === -1 || firstAtomEnd !== i) return -1
      if (char === '{') {
        const close = pattern.indexOf('}', i)
        if (close === -1 || !/^\d+(,\d*)?$/.test(pattern.slice(i + 1, close))) {
          // Literal `{` — not a quantifier; the first atom ends here.
          return -1
        }
        i = close + 1
      } else {
        i += 1
      }
      if (pattern[i] === '?') i += 1
      return i
    }
    if (char === '|' && depth === 0) return -1 // alternation — no single first atom
    if (isQuantifierChar(char) || depth > 0) { i += 1; continue }
    // Plain character atom: it ends here; a quantifier at the next index
    // targets it — let the loop's quantifier branch inspect that position.
    i += 1
    if (firstAtomEnd === -1) firstAtomEnd = i
    continue
  }
  return -1
}

/**
 * True when a group body is an AMBIGUOUS alternation: its branches overlap
 * (one can match a prefix of another) or a branch can match empty —
 * `(a|a?)`, `(?:a|aa)`, `(x|)`. Two or more such groups in a row multiply
 * the ways the same input span can be split between them; V8 backtracks
 * exponentially on a near-miss even though NO quantifier appears anywhere
 * (round-3 finding: "Repeated alternatives evade ReDoS guard").
 */
function groupBodyIsAmbiguousAlternation(pattern: string, bodyStart: number, bodyEnd: number): boolean {
  const body = analyzeSequence(pattern, bodyStart, bodyEnd)
  if (!body.alternation && !body.canMatchEmpty) return false
  if (!body.alternation) return false
  // Overlap check: any branch whose FIRST character also starts another
  // branch (a|aa), or any empty-able branch (a|a?) — both create split
  // points. Compare the first literal of each top-level branch.
  const branches: string[] = []
  let depth = 0
  let start = bodyStart
  for (let i = bodyStart; i < bodyEnd; i += 1) {
    const char = pattern[i]
    if (char === '\\') { i += 1; continue }
    if (char === '[') { i = classEnd(pattern, i); continue }
    if (char === '(') { depth += 1; continue }
    if (char === ')') { depth -= 1; continue }
    if (char === '|' && depth === 0) {
      branches.push(pattern.slice(start, i))
      start = i + 1
    }
  }
  branches.push(pattern.slice(start, bodyEnd))
  if (body.canMatchEmpty || branches.some(branch => branch === '')) return true
  const firstLiterals = branches.map(branch => literalFirstChar(branch))
  // Finding: "URL matching stalls" — when a branch's first-character set is
  // UNKNOWN (it starts with a character class, a negated class, `.`, or an
  // escaped class like `\w`), it can start with ANY character, so it may
  // overlap every other branch: `([a-z]+|[0-9]+)*` passed the old check
  // (null === null never compared equal) and backtracked combinatorially.
  // Only branches whose first literals are BOTH known may be compared at
  // all; an unknown first set on either side means the branches are treated
  // as OVERLAPPING (conservative reject — fail closed).
  for (let a = 0; a < firstLiterals.length; a += 1) {
    for (let b = a + 1; b < firstLiterals.length; b += 1) {
      const fa = firstLiterals[a]
      const fb = firstLiterals[b]
      if (fa === null || fb === null) return true // unknown first set — assume overlap
      if (fa === fb) return true // same first literal — the branches overlap
    }
  }
  return false
}

/** First DISTINCT literal character a branch can start with, or null. */
function literalFirstChar(branch: string): string | null {
  for (let i = 0; i < branch.length; i += 1) {
    const char = branch[i]
    if (char === '\\') return branch[i + 1] ?? null
    if (char === '[') return null // class — treat as non-overlapping
    if (char === '(' || char === '|' || char === ')' || isQuantifierChar(char)) return null
    return char
  }
  return null
}

/**
 * Convenience wrapper used by `hasNestedQuantifier`: true when this
 * unquantified group's body is an ambiguous alternation.
 */
function adjacentGroupBodyIsAmbiguous(pattern: string, bodyStart: number, bodyEnd: number): boolean {
  return groupBodyIsAmbiguousAlternation(pattern, bodyStart, bodyEnd)
}

/**
 * Overlap test for two ADJACENT top-level groups, the first of which starts
 * with a quantified atom (round-5 finding: "Safe URL patterns are
 * rejected"). The pair `(<quantified-leading>)(next)` is only dangerous
 * when the boundary between them is AMBIGUOUS — i.e. both sides can claim
 * the same characters. The decidable safe case: the previous group's LAST
 * atom is a fixed literal (its quantified leading run is pinned to end on
 * that character) and the next group's FIRST literal is fixed and
 * different — `^(a+)(b)$`: the first group can only end on `a`, the second
 * can only start with `b`, so no split point is ever revisited and the
 * match stays linear. Everything else (equal literals, a class, an
 * alternation, another quantified leading atom on either side) stays
 * rejected — fail closed.
 */
function adjacentGroupsOverlap(pattern: string, previousStart: number, previousEnd: number, nextOpen: number): boolean {
  const lastLiteral = literalLastChar(pattern, previousStart, previousEnd)
  if (lastLiteral === null) return true // cannot prove the boundary decidable
  const nextBodyStart = groupBodyStart(pattern, nextOpen)
  const nextClose = matchingGroupClose(pattern, nextOpen)
  if (nextClose === -1) return true // malformed — the RegExp ctor reports it; fail closed
  const firstLiteral = literalFirstCharOf(pattern, nextBodyStart, nextClose)
  if (firstLiteral === null) return true // class/alternation/quantified lead — assume overlap
  return lastLiteral === firstLiteral
}

/** The LAST fixed single-character literal of a span, or null when the span's tail is not a plain literal. */
function literalLastChar(pattern: string, from: number, until: number): string | null {
  let i = until - 1
  // A trailing quantifier belongs to the last atom; step over it (`+`, `*`, `?`, `{n,m}`, lazy `?`).
  if (i >= from && isQuantifierChar(pattern[i])) {
    if (pattern[i] === '{') {
      const open = pattern.lastIndexOf('{', i)
      if (open === -1) return null
      i = open - 1
    } else {
      i -= 1
    }
    if (i >= from && pattern[i] === '?' && !isQuantifierChar(pattern[i - 1])) i -= 1
  }
  if (i < from) return null
  const char = pattern[i]
  if (char === ')') return null // group tail — not decidable here
  if (char === ']') {
    // A character class tail — the class COULD contain the next group's
    // first char; undecidable without class parsing.
    return null
  }
  if (char === '\\' && i - 1 >= from) return pattern[i - 1]
  if (isQuantifierChar(char) || char === '(' || char === '|' || char === '[') return null
  return char
}

/** Index of the `)` matching the `(` at `open`, honoring nesting/escapes/classes, or -1. */
function matchingGroupClose(pattern: string, open: number): number {
  let depth = 0
  for (let i = open; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '\\') { i += 1; continue }
    if (char === '[') { i = classEnd(pattern, i) - 1; continue }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** Like `literalFirstChar` but bounded to an explicit span. */
function literalFirstCharOf(pattern: string, from: number, until: number): string | null {
  for (let i = from; i < until && i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '\\') return pattern[i + 1] ?? null
    if (char === '[') return null // class — treat as non-overlapping would be UNSAFE here; fail closed
    if (char === '(' || char === '|' || char === ')' || isQuantifierChar(char)) return null
    return char
  }
  return null
}

/**
 * Structural backtracking scan: every group followed by a quantifier gets
 * its body analyzed, and flat quantifier chains are rejected (see
 * `hasFlatQuantifierChain`). Groups that are not quantified are irrelevant
 * (their body runs once); a quantified group with a fixed, non-empty,
 * non-alternating body — `(?:/[^?#]*)?` — stays allowed.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  if (hasFlatQuantifierChain(pattern)) return true
  const opens: number[] = []
  /**
   * Body span `[start, end)` of the last closed top-level group whose FIRST
   * atom carries a quantifier, plus whether that span is still adjacent to
   * the scan position (a literal atom between groups clears the adjacency).
   * Used by the overlap-aware adjacency check below.
   */
  let quantifiedLeadingGroup: { start: number; end: number } | null = null
  /** Run of consecutive unquantified groups with ambiguous alternation bodies. */
  let ambiguousAlternationGroups = 0
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '\\') { i += 1; continue }
    if (char === '[') {
      i = classEnd(pattern, i)
      continue
    }
    if (char === '(') {
      // A new group immediately after a group whose body STARTS with a
      // quantified atom (`(a+)(a+)…`): the two quantifiers split the same
      // input span BETWEEN the groups, which backtracks exponentially on a
      // near-miss (finding: "URL matching stalls on backtracking") — BUT
      // only when the groups can actually claim the same characters
      // (round-5 finding: "Safe URL patterns are rejected"). `^(a+)(b)$`
      // is safe: the first group's trailing run is all `a`s and the second
      // group must start with `b`, so no split point is ever revisited.
      // When the previous group's LAST literal and this group's FIRST
      // literal are fixed and distinct, the boundary is decidable and the
      // pattern stays allowed.
      if (opens.length === 0 && quantifiedLeadingGroup) {
        const previous = quantifiedLeadingGroup
        quantifiedLeadingGroup = null
        if (adjacentGroupsOverlap(pattern, previous.start, previous.end, i)) return true
      }
      opens.push(i)
      continue
    }
    if (char === ')') {
      const open = opens.pop()
      if (open === undefined) continue
      if (isQuantifierChar(pattern[i + 1]) && bodyIsDangerous(pattern, groupBodyStart(pattern, open), i)) {
        return true
      }
      // UNQUANTIFIED group: when its body STARTS with a quantified atom
      // (`(a+)…`), remember the body span — the NEXT adjacent atom decides
      // via the overlap check above whether the pair is dangerous (finding:
      // "URL matching stalls on backtracking" — adjacent quantified groups,
      // which the group-free flat-chain scan cannot see).
      if (firstAtomQuantifiedEnd(pattern, groupBodyStart(pattern, open), i) !== -1) {
        quantifiedLeadingGroup = { start: groupBodyStart(pattern, open), end: i }
      } else if (adjacentGroupBodyIsAmbiguous(pattern, groupBodyStart(pattern, open), i)) {
        // Round-3 finding ("Repeated alternatives evade ReDoS guard"): an
        // unquantified group whose body is an AMBIGUOUS alternation
        // (`(a|a?)`) followed by more such groups passes every quantifier
        // check, yet each boundary multiplies the split points — measured
        // exponential on a near-miss input. Reject the shape outright;
        // legitimate URL patterns never chain ambiguous groups.
        quantifiedLeadingGroup = null
        ambiguousAlternationGroups += 1
        if (ambiguousAlternationGroups >= 2) return true
      } else {
        quantifiedLeadingGroup = null
        ambiguousAlternationGroups = 0
      }
      continue
    }
    if (isQuantifierChar(char) && opens.length === 0 && quantifiedLeadingGroup) {
      // A quantified atom right after a group that itself starts quantified
      // (`(a+)b+`): the two quantifiers split the SAME span at an
      // undecidable boundary (the atom can start wherever the group's run
      // ends) — always ambiguous, reject without further analysis.
      return true
    }
    if (!isQuantifierChar(char) && char !== '|') quantifiedLeadingGroup = null
  }
  return false
}

export function validateUrlRegex(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('urlRegex must be a nonempty string')
  if (value.length > 2000 || !value.startsWith('^') || !value.endsWith('$'))
    throw new Error('urlRegex must start with ^, end with $, and contain at most 2000 characters')
  if (hasNestedQuantifier(value))
    throw new Error('urlRegex must not contain nested quantifiers (they allow catastrophic backtracking)')
  try { new RegExp(value) } catch (error) { throw new Error(`Invalid urlRegex: ${String(error)}`) }
  return value
}

/** Matching also verifies the complete match, including expressions with alternation. */
export function matchesToolUrl(pattern: string, href: string): boolean {
  // An over-long URL cannot be a real tab URL and only feeds a pathological
  // pattern more backtracking work.
  if (href.length > MAX_MATCH_URL_LENGTH) return false
  const url = new URL(href)
  if (!['https:', 'http:'].includes(url.protocol)) return false
  const match = new RegExp(pattern).exec(url.href)
  return match !== null && match.index === 0 && match[0].length === url.href.length
}
