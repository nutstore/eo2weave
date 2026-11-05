/**
 * Skill Parser - parses SKILL.md format (YAML frontmatter + Markdown body).
 *
 * Format:
 * ```
 * ---
 * name: My Skill
 * version: "1.0.0"
 * description: Does something useful
 * author: Author Name
 * category: general
 * tags: [tag1, tag2]
 * triggers:
 *   keywords: [keyword1, keyword2]
 *   fileExtensions: [".ts", ".js"]
 * ---
 *
 * # Instruction
 * Main instruction content here...
 *
 * # Examples
 * Example content here...
 *
 * # Templates
 * Template content here...
 * ```
 */

import yaml from 'js-yaml'
import type { Skill, SkillCategory, SkillSecret, SkillSource, SkillTrigger } from './skill-types'

/** Parse result */
interface ParseResult {
  skill: Skill | null
  error?: string
}

/**
 * Parse a SKILL.md string into a Skill object.
 *
 * Tolerates common hand-written YAML mistakes: unquoted scalars containing
 * `: ` (or a trailing `:`) and naively nested double quotes are auto-repaired
 * before the final parse error is reported (see `repairFrontmatter`).
 */
export function parseSkillMd(content: string, source: SkillSource = 'import'): ParseResult {
  const trimmed = content.trim()
  if (!trimmed.startsWith('---')) {
    return { skill: null, error: 'Missing YAML frontmatter (must start with ---)' }
  }

  const endIndex = trimmed.indexOf('---', 3)
  if (endIndex === -1) {
    return { skill: null, error: 'Unclosed YAML frontmatter (missing closing ---)' }
  }

  const yamlBlock = trimmed.substring(3, endIndex).trim()
  const body = trimmed.substring(endIndex + 3).trim()

  // Parse YAML frontmatter
  let meta: Record<string, unknown>
  try {
    meta = yaml.load(yamlBlock) as Record<string, unknown>
  } catch (e) {
    // Strict YAML rejects several patterns that hand-written SKILL.md files
    // produce constantly (`description: Use when: X`, naively nested quotes).
    // Repair the ambiguous lines and retry before giving up — an unregistered
    // skill is much worse than a conservatively re-quoted scalar.
    const repaired = repairFrontmatter(yamlBlock)
    if (repaired === yamlBlock) {
      return frontmatterError(e)
    }
    try {
      meta = yaml.load(repaired) as Record<string, unknown>
    } catch (e2) {
      return frontmatterError(e2)
    }
  }
  if (!meta || typeof meta !== 'object') {
    return { skill: null, error: 'Invalid YAML frontmatter (not a mapping)' }
  }
  if (!meta.name) {
    return { skill: null, error: 'Missing required field: name' }
  }

  // Parse markdown body into sections
  const sections = parseMarkdownSections(body)

  const now = Date.now()
  const name = String(meta.name)
  const id = meta.id ? String(meta.id) : slugify(name)

  const triggers = parseTriggers(meta.triggers)
  const secrets = parseSecrets(meta.secrets)

  const skill: Skill = {
    id,
    name,
    version: meta.version ? String(meta.version) : '1.0.0',
    description: meta.description ? String(meta.description) : '',
    description_i18n: parseDescriptionI18n(meta),
    author: meta.author ? String(meta.author) : 'Unknown',
    category: validateCategory(meta.category),
    tags: parseStringArray(meta.tags),
    source,
    triggers,
    secrets: secrets.length > 0 ? secrets : undefined,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    instruction: sections.instruction || body, // fallback: entire body is instruction
    examples: sections.examples || undefined,
    templates: sections.templates || undefined,
  }

  return { skill }
}

/**
 * Collect `description.<locale>:` frontmatter values — display-only
 * translations of the skill description. The base `description` stays the
 * agent-facing trigger text.
 *
 * A locale is a BCP-47-ish tag with any number of subtags (`ja`, `zh-CN`,
 * `zh-Hant-TW`); anything else under a `description.` prefix is ignored rather
 * than surfaced as a locale.
 */
export function parseDescriptionI18n(
  meta: Record<string, unknown>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(meta)) {
    const match = /^description\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.exec(key)
    if (!match || typeof value !== 'string') continue
    const text = value.trim()
    if (text) out[match[1]] = text
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Extract only the `description.<locale>` map from raw SKILL.md text.
 *
 * The cheap path for callers that already store the raw file (SQLite rows) and
 * need the translations without a full parse. Unreadable frontmatter yields
 * undefined — translations are display-only, never load-blocking.
 */
export function parseDescriptionI18nFromSkillMd(
  content: string,
): Record<string, string> | undefined {
  const trimmed = content.trim()
  if (!trimmed.startsWith('---')) return undefined
  const end = trimmed.indexOf('---', 3)
  if (end === -1) return undefined
  const yamlBlock = trimmed.substring(3, end).trim()
  const read = (block: string): Record<string, unknown> | null => {
    const meta = yaml.load(block)
    return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null
  }
  try {
    const meta = read(yamlBlock)
    return meta ? parseDescriptionI18n(meta) : undefined
  } catch {
    // Hand-written frontmatter routinely trips strict YAML (`description: Use
    // when: X`). parseSkillMd repairs and retries, so this path must too —
    // otherwise those files simply lose their translations.
    try {
      const repaired = repairFrontmatter(yamlBlock)
      if (repaired === yamlBlock) return undefined
      const meta = read(repaired)
      return meta ? parseDescriptionI18n(meta) : undefined
    } catch {
      return undefined
    }
  }
}

/**
 * Serialize a Skill back to SKILL.md format.
 */
export function serializeSkillMd(skill: Skill): string {
  const lines: string[] = ['---']

  lines.push(`name: "${escapeYamlString(skill.name)}"`)
  lines.push(`version: "${skill.version}"`)
  if (skill.description) {
    lines.push(`description: "${escapeYamlString(skill.description)}"`)
  }
  // Localized descriptions round-trip, so editing a skill does not silently
  // drop the translations that ship in its SKILL.md.
  if (skill.description_i18n) {
    for (const [locale, text] of Object.entries(skill.description_i18n)) {
      if (!text) continue
      lines.push(`description.${locale}: "${escapeYamlString(text)}"`)
    }
  }
  lines.push(`author: "${escapeYamlString(skill.author)}"`)
  lines.push(`category: ${skill.category}`)
  if (skill.tags.length > 0) {
    lines.push(`tags: [${skill.tags.map((t) => `"${escapeYamlString(t)}"`).join(', ')}]`)
  }

  // Triggers
  lines.push('triggers:')
  if (skill.triggers.keywords.length > 0) {
    lines.push(
      `  keywords: [${skill.triggers.keywords.map((k) => `"${escapeYamlString(k)}"`).join(', ')}]`
    )
  }
  if (skill.triggers.fileExtensions && skill.triggers.fileExtensions.length > 0) {
    lines.push(
      `  fileExtensions: [${skill.triggers.fileExtensions.map((e) => `"${e}"`).join(', ')}]`
    )
  }

  // Secrets
  if (skill.secrets && skill.secrets.length > 0) {
    lines.push(`secrets:`)
    for (const secret of skill.secrets) {
      const desc = secret.description ? escapeYamlString(secret.description) : ''
      const required = secret.required === false ? 'false' : 'true'
      if (desc) {
        lines.push(`  - name: "${escapeYamlString(secret.name)}"`)
        lines.push(`    description: "${desc}"`)
        lines.push(`    required: ${required}`)
      } else {
        // Compact form when no description
        lines.push(`  - name: "${escapeYamlString(secret.name)}"`)
        if (secret.required === false) {
          lines.push(`    required: false`)
        }
      }
    }
  }

  lines.push('---')
  lines.push('')

  // Body sections
  lines.push('# Instruction')
  lines.push(skill.instruction)

  if (skill.examples) {
    lines.push('')
    lines.push('# Examples')
    lines.push(skill.examples)
  }

  if (skill.templates) {
    lines.push('')
    lines.push('# Templates')
    lines.push(skill.templates)
  }

  return lines.join('\n') + '\n'
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** Build the parse error for frontmatter failures, with an actionable hint. */
function frontmatterError(e: unknown): ParseResult {
  const detail = e instanceof Error ? e.message : String(e)
  return {
    skill: null,
    error:
      `YAML frontmatter parse error: ${detail}. ` +
      'Hint: quote field values that contain special characters, e.g. ' +
      'description: "text with: colons or \\"quotes\\""',
  }
}

/** A complete, properly escaped double-quoted YAML scalar. */
const DOUBLE_QUOTED_SCALAR = /^"(?:[^"\\]|\\.)*"$/

/** A complete single-quoted YAML scalar ('' escapes a literal quote). */
const SINGLE_QUOTED_SCALAR = /^'(?:[^']|'')*'$/

/** Matches `key: value` lines (indent allowed; value must be non-empty). */
const FRONTMATTER_KEY_LINE = /^([ \t]*)([A-Za-z_][\w.-]*):[ \t](.+)$/

/** Block scalar headers: `>`, `|-`, `>2`, `|2-`, ... */
const BLOCK_SCALAR_HEADER = /^[|>][0-9]*[+-]?$/

/**
 * Decide whether an unquoted/naively-quoted scalar value needs repair.
 *
 * Only called when strict YAML parsing of the whole block already failed, so
 * being liberal here cannot break a file that currently works.
 */
function needsQuoteRepair(value: string): boolean {
  if (DOUBLE_QUOTED_SCALAR.test(value) || SINGLE_QUOTED_SCALAR.test(value)) return false
  if (/:\s/.test(value)) return true // ": " — mapping-value indicator mid-scalar
  if (/:$/.test(value)) return true // trailing colon acts as a value indicator
  if (/^#/.test(value) || /\s#/.test(value)) return true // would start a YAML comment
  if (value.startsWith('"') || value.startsWith("'")) return true // broken quoting
  return false
}

/**
 * Re-quote a raw scalar value as a properly escaped YAML double-quoted
 * string. One layer of broken wrapping quotes is stripped first, so
 * `"say "hi""` becomes `"say \\"hi\\""` (parses back to `say "hi"`).
 */
function quoteYamlScalar(raw: string): string {
  let v = raw
  const wrappedDQ = v.length >= 2 && v.startsWith('"') && v.endsWith('"')
  const wrappedSQ = v.length >= 2 && v.startsWith("'") && v.endsWith("'")
  if (wrappedDQ) {
    v = v.slice(1, -1).replace(/\\(["\\])/g, '$1')
  } else if (wrappedSQ) {
    v = v.slice(1, -1).replace(/''/g, "'")
  }
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/**
 * Tolerant repair for hand-written SKILL.md frontmatter.
 *
 * Wraps ambiguous scalar values in escaped double quotes so that strings
 * containing `: `, trailing colons, ` #`, or naively nested quotes parse as
 * literal text instead of aborting registration. Line-based and conservative:
 *
 * - values that are already valid quoted scalars are left untouched
 * - block scalars (`description: >` + indented lines) are skipped entirely
 * - `required: false` and other pattern-free lines are never touched, so
 *   boolean/array semantics survive the repair
 *
 * Only invoked after strict `yaml.load` has failed.
 */
function repairFrontmatter(yamlBlock: string): string {
  const out: string[] = []
  // Indent of the key line that opened a block scalar, while inside one.
  let blockScalarIndent: number | null = null

  for (const rawLine of yamlBlock.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const indent = line.length - line.trimStart().length

    if (blockScalarIndent !== null) {
      // Blank or more-indented lines belong to the block scalar — verbatim.
      if (line.trim() === '' || indent > blockScalarIndent) {
        out.push(line)
        continue
      }
      blockScalarIndent = null // dedented — the block scalar ended
    }

    const m = FRONTMATTER_KEY_LINE.exec(line)
    if (!m) {
      out.push(line)
      continue
    }
    const [, lead, key, rawValue] = m
    const value = rawValue.replace(/[ \t]+$/, '')
    if (BLOCK_SCALAR_HEADER.test(value)) {
      blockScalarIndent = indent
      out.push(line)
      continue
    }
    if (!needsQuoteRepair(value)) {
      out.push(line)
      continue
    }
    out.push(`${lead}${key}: ${quoteYamlScalar(value)}`)
  }

  return out.join('\n')
}

/** Parse Markdown into named sections by H1 headings */
function parseMarkdownSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {}
  const headingRegex = /^#\s+(.+)$/gm
  const matches: { name: string; start: number; end: number }[] = []

  let match: RegExpExecArray | null
  while ((match = headingRegex.exec(body)) !== null) {
    matches.push({
      name: match[1].trim().toLowerCase(),
      start: match.index + match[0].length,
      end: body.length, // will be updated
    })
  }

  // Set end positions
  for (let i = 0; i < matches.length - 1; i++) {
    matches[i].end = matches[i + 1].start - matches[i + 1].name.length - 2 // account for "# "
    // Find the actual position of next heading
    const nextHeadingPos = body.lastIndexOf('#', matches[i + 1].start)
    if (nextHeadingPos > matches[i].start) {
      matches[i].end = nextHeadingPos
    }
  }

  for (const section of matches) {
    sections[section.name] = body.substring(section.start, section.end).trim()
  }

  return sections
}

/**
 * Convert a skill name to a filesystem-safe directory slug.
 *
 * Skill names use a `cw-` prefix with kebab-case (e.g. `cw-brainstorm`).
 * Since the name is already filesystem-safe (no colons or special chars),
 * this function primarily handles edge cases: trimming, lowercasing, and
 * collapsing non-alphanumeric runs (excluding CJK) into dashes.
 *
 * Exported so that migration, import, and scan all derive the same directory
 * name from a given skill name — preventing duplicate directories.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Validate and normalize category */
function validateCategory(value: unknown): SkillCategory {
  const valid: SkillCategory[] = [
    'code-review',
    'testing',
    'debugging',
    'refactoring',
    'documentation',
    'security',
    'performance',
    'architecture',
    'general',
  ]
  if (typeof value === 'string' && valid.includes(value as SkillCategory)) {
    return value as SkillCategory
  }
  return 'general'
}

/** Parse a value as string array */
function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return value.split(',').map((s) => s.trim())
  return []
}

/** Parse triggers from frontmatter */
function parseTriggers(value: unknown): SkillTrigger {
  const defaultTrigger: SkillTrigger = { keywords: [] }
  if (!value || typeof value !== 'object') return defaultTrigger

  const obj = value as Record<string, unknown>
  return {
    keywords: parseStringArray(obj.keywords),
    fileExtensions: obj.fileExtensions ? parseStringArray(obj.fileExtensions) : undefined,
  }
}

/**
 * Parse the `secrets:` frontmatter field.
 *
 * Supports two forms:
 * ```yaml
 * # Simple list — just names (all required, no description)
 * secrets: [API_KEY, TOKEN]
 *
 * # Detailed list — objects with name / description / required
 * secrets:
 *   - name: API_KEY
 *     description: The main API token
 *   - name: OPTIONAL_PROXY
 *     required: false
 * ```
 */
function parseSecrets(value: unknown): SkillSecret[] {
  if (!Array.isArray(value)) return []

  const result: SkillSecret[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      if (item.trim()) result.push({ name: item.trim(), required: true })
      continue
    }
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      const name = obj.name !== undefined ? String(obj.name) : ''
      if (!name.trim()) continue
      const secret: SkillSecret = {
        name: name.trim(),
        required: obj.required === undefined ? true : Boolean(obj.required),
      }
      if (obj.description !== undefined) {
        secret.description = String(obj.description)
      }
      result.push(secret)
    }
  }
  return result
}

/** Escape special characters for YAML double-quoted string output.
 *  Handles backslash, double-quote, and control chars (\n, \t, \r) to
 *  keep the writer and the SkillEditor's yamlEscape in sync. */
function escapeYamlString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
}
