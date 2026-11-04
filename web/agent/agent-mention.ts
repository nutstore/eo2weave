export interface MentionTailMatch {
  mentionText: string
  query: string
}

export function findAgentMentionCandidates<T extends { id: string; name?: string }>(agents: readonly T[], query: string): T[] {
  const q = query.toLowerCase().trim()
  return agents.filter((a) => a.id !== 'default')
    .filter((a) => !q || `${a.id} ${a.name || ''}`.toLowerCase().includes(q)).slice(0, 8)
}

const AGENT_MENTION_CHAR_CLASS = '[\\p{L}\\p{N}_-]'
const TRAILING_AGENT_MENTION_REGEX = new RegExp(`(?:^|\\s)@(${AGENT_MENTION_CHAR_CLASS}*)$`, 'u')
const AGENT_MENTION_REGEX = new RegExp(`(?:^|\\s)@(${AGENT_MENTION_CHAR_CLASS}+)`, 'gu')

export function extractMentionContextFromTextTail(textTail: string): MentionTailMatch | null {
  const match = TRAILING_AGENT_MENTION_REGEX.exec(textTail)
  if (!match) return null

  const matched = match[0]
  const atIndex = matched.lastIndexOf('@')
  if (atIndex < 0) return null

  const mentionText = matched.slice(atIndex)
  return {
    mentionText,
    query: match[1] ?? '',
  }
}

export function extractMentionedAgentIds(
  text: string,
  candidateAgentIds: readonly string[],
  options?: { excludeDefault?: boolean }
): string[] {
  const excludeDefault = options?.excludeDefault ?? true
  const canonicalByLower = new Map<string, string>()
  for (const id of candidateAgentIds) {
    canonicalByLower.set(id.toLowerCase(), id)
  }

  const result: string[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null = null
  AGENT_MENTION_REGEX.lastIndex = 0

  while ((match = AGENT_MENTION_REGEX.exec(text)) !== null) {
    const raw = match[1]
    const canonical = canonicalByLower.get(raw.toLowerCase())
    if (!canonical || (excludeDefault && canonical === 'default') || seen.has(canonical)) continue
    seen.add(canonical)
    result.push(canonical)
  }

  return result
}

export function extractFirstMentionedAgentId(content: string | null | undefined): string | null {
  if (!content) return null
  AGENT_MENTION_REGEX.lastIndex = 0
  const match = AGENT_MENTION_REGEX.exec(content)
  if (!match) return null
  const id = (match[1] || '').trim()
  if (!id || id.toLowerCase() === 'default') return null
  return id
}
