/**
 * Builtin slash command pack — high-frequency light operations (P0).
 *
 * Each command = a prompt template + optional page-context injection.
 * Execution assembles the final prompt and routes it through the standard
 * agent message pipeline (NO separate request channel): quota accounting,
 * context compaction and prompt_cache_key all keep working.
 *
 * Page context rules:
 *   - selected text wins over page body when both exist
 *   - falling back to page body is surfaced to the user (chip shows
 *     "page mode") so the scope of the operation is never a surprise
 *
 * These metadata entries are registered into the slash-command-registry with
 * source 'builtin'; the template constants live here so P1 user overrides can
 * swap them without touching UI code.
 */

import { registerSlashCommands } from './slash-command-registry'

// ============================================================================
// Types
// ============================================================================

export interface BuiltinSlashCommandDef {
  id: string
  /** i18n key suffix under conversation.slashCommands.<id> */
  i18nKey: string
  /** Lucide icon name (rendered in the dropdown) */
  icon: string
  /** Builtin-only: command takes a language argument */
  takesLangArg?: boolean
  /**
   * True when trailing text after the command is the SUBJECT itself
   * ("/polish 这段文字" works in ANY mode, no page context needed).
   * When false, trailing text is meaningless (no such command today).
   */
  takesInlineSubject?: boolean
  /** Build the final prompt sent through the agent pipeline */
  buildPrompt: (ctx: SlashPromptContext, tr: (i18nKey: string) => string) => string
}

export interface SlashPromptContext {
  /** User-selected text on the page, if any (side-panel mode) */
  selection: string | null
  /** Page body text (extracted, truncated) — fallback when no selection */
  pageText: string | null
  pageTitle: string | null
  pageUrl: string | null
  /** /translate target language argument (default zh) */
  langArg?: string
}

// ============================================================================
// Constants
// ============================================================================

/** Max page body chars injected into a prompt (keep token cost bounded). */
export const PAGE_TEXT_MAX_CHARS = 8000

/**
 * Ordered builtin commands — registry order == dropdown order.
 * `compact` is registered separately (pre-existing) and is untouched.
 */
export const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommandDef[] = [
  {
    id: 'summary',
    i18nKey: 'summary',
    icon: 'FileText',
    takesInlineSubject: true,
    buildPrompt: (ctx, tr) => {
      const subject = resolveSubject(ctx, tr)
      if (!subject) return ''
      return [tr('summary'), '', subjectHeader(ctx, tr), subject].join('\n')
    },
  },
  {
    id: 'translate',
    i18nKey: 'translate',
    icon: 'Languages',
    takesLangArg: true,
    buildPrompt: (ctx, tr) => {
      const subject = resolveSubject(ctx, tr)
      if (!subject) return ''
      const lang = normalizeLang(ctx.langArg)
      return [tr('translate').replace('{lang}', lang), '', subjectHeader(ctx, tr), subject].join('\n')
    },
  },
  {
    id: 'explain',
    i18nKey: 'explain',
    icon: 'Lightbulb',
    takesInlineSubject: true,
    buildPrompt: (ctx, tr) => {
      const subject = resolveSubject(ctx, tr)
      if (!subject) return ''
      return [
        tr('explain'),
        '',
        subjectHeader(ctx, tr),
        subject,
      ].join('\n')
    },
  },
  {
    id: 'polish',
    i18nKey: 'polish',
    icon: 'Sparkles',
    takesInlineSubject: true,
    buildPrompt: (ctx, tr) => {
      const subject = resolveSubject(ctx, tr)
      if (!subject) return ''
      return [tr('polish'), '', subjectHeader(ctx, tr), subject].join('\n')
    },
  },
  {
    id: 'titles',
    i18nKey: 'titles',
    icon: 'Heading',
    takesInlineSubject: true,
    buildPrompt: (ctx, tr) => {
      const subject = resolveSubject(ctx, tr)
      if (!subject) return ''
      return [tr('titles'), '', subjectHeader(ctx, tr), subject].join('\n')
    },
  },
]

// ============================================================================
// Helpers
// ============================================================================

/** Selection wins over page body; returns null when neither exists. */
function resolveSubject(ctx: SlashPromptContext, tr: (i18nKey: string) => string): string | null {
  if (ctx.selection && ctx.selection.trim()) return ctx.selection.trim()
  if (ctx.pageText && ctx.pageText.trim()) {
    return truncatePageText(ctx.pageText, tr('truncated'))
  }
  return null
}

function subjectHeader(ctx: SlashPromptContext, tr: (i18nKey: string) => string): string {
  const hasPageTitle = !!(ctx.pageTitle && ctx.pageTitle.trim())
  const hasPageMeta = !!(ctx.pageUrl && ctx.pageUrl.trim())
  // Inline subject (typed after the command): no page metadata exists.
  if (!hasPageTitle && !hasPageMeta) {
    return `【${tr('subjectInline')}】`
  }
  const source = ctx.selection?.trim() ? tr('subjectSelection') : tr('subjectPage')
  if (hasPageTitle) {
    return `【${source}｜${ctx.pageTitle}】`
  }
  return `【${source}】`
}

/** Hard-truncate page text with an explicit marker so the model knows. */
export function truncatePageText(
  text: string,
  truncatedMark = '[...内容过长已截断]',
): string {
  const t = text.trim()
  if (t.length <= PAGE_TEXT_MAX_CHARS) return t
  return `${t.slice(0, PAGE_TEXT_MAX_CHARS)}\n\n${truncatedMark}`
}

const LANG_MAP: Record<string, string> = {
  zh: '中文',
  en: '英文',
  ja: '日文',
  ko: '韩文',
  fr: '法文',
  de: '德文',
  es: '西班牙文',
  ru: '俄文',
}

/** /translate zh | /translate en | /translate 简体中文 → canonical name. */
export function normalizeLang(arg?: string): string {
  if (!arg || !arg.trim()) return '中文'
  const key = arg.trim().toLowerCase()
  return LANG_MAP[key] ?? arg.trim()
}

// ============================================================================
// Registry wiring
// ============================================================================

/**
 * Register the P0 builtin pack into the slash-command registry.
 * Called from registerBuiltinSlashCommands() at app startup.
 * Source 'builtin' — visually grouped/flagged separately from skill commands.
 */
export function registerBuiltinCommandPack(): void {
  // label/description are filled by the UI layer via i18n keys
  // (conversation.slashCommands.<id>.label / .description); the registry
  // stores the key so the dropdown can translate at render time.
  registerSlashCommands(
    BUILTIN_SLASH_COMMANDS.map((def) => ({
      id: def.id,
      // i18n keys — UI layer resolves via conversation.slashCommands.<id>.*
      label: def.i18nKey,
      description: def.i18nKey,
      source: 'builtin' as const,
      takesArg: def.takesLangArg ?? false,
    })),
  )
}
