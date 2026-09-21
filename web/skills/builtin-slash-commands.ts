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
  /** Build the final prompt sent through the agent pipeline */
  buildPrompt: (ctx: SlashPromptContext) => string
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
    buildPrompt: (ctx) => {
      const subject = resolveSubject(ctx)
      if (!subject) return ''
      return [
        '请总结以下内容，用中文输出。先给一句话结论，再列 3-7 个要点（每点一行，可加粗关键词），最后用一行给出原文的核心目的。不要编造内容中没有的信息。',
        '',
        subjectHeader(ctx),
        subject,
      ].join('\n')
    },
  },
  {
    id: 'translate',
    i18nKey: 'translate',
    icon: 'Languages',
    takesLangArg: true,
    buildPrompt: (ctx) => {
      const subject = resolveSubject(ctx)
      if (!subject) return ''
      const lang = normalizeLang(ctx.langArg)
      return [
        `请将以下内容翻译为${lang}。要求：保留原有格式（Markdown/代码块/列表）；专有名词、代码标识符不翻译；译文自然流畅，不要逐字直译。只输出译文。`,
        '',
        subjectHeader(ctx),
        subject,
      ].join('\n')
    },
  },
  {
    id: 'explain',
    i18nKey: 'explain',
    icon: 'Lightbulb',
    buildPrompt: (ctx) => {
      const subject = resolveSubject(ctx)
      if (!subject) return ''
      return [
        '请解释以下内容：先用一句大白话概括它在说什么；然后逐个解释其中的关键概念/术语/代码（若有代码，说明每段做什么、为什么这样写）；最后给一个便于理解的类比或示例。用中文输出。',
        '',
        subjectHeader(ctx),
        subject,
      ].join('\n')
    },
  },
  {
    id: 'polish',
    i18nKey: 'polish',
    icon: 'Sparkles',
    buildPrompt: (ctx) => {
      const subject = resolveSubject(ctx)
      if (!subject) return ''
      return [
        '请润色以下文字：保持原意和语气风格不变，提升流畅度、精炼度和表达力；修正错别字与语病。输出：1) 润色后的全文；2) 用简短列表说明主要改动点。不要改写原意。',
        '',
        subjectHeader(ctx),
        subject,
      ].join('\n')
    },
  },
  {
    id: 'titles',
    i18nKey: 'titles',
    icon: 'Heading',
    buildPrompt: (ctx) => {
      const subject = resolveSubject(ctx)
      if (!subject) return ''
      return [
        '基于以下内容生成 5 个备选标题，用中文。要求：每个标题一行、不超过 20 字、风格各异（至少包含：信息型、悬念型、利益型各一个）；按吸引力排序；只输出标题列表。',
        '',
        subjectHeader(ctx),
        subject,
      ].join('\n')
    },
  },
]

// ============================================================================
// Helpers
// ============================================================================

/** Selection wins over page body; returns null when neither exists. */
function resolveSubject(ctx: SlashPromptContext): string | null {
  if (ctx.selection && ctx.selection.trim()) return ctx.selection.trim()
  if (ctx.pageText && ctx.pageText.trim()) {
    return truncatePageText(ctx.pageText)
  }
  return null
}

function subjectHeader(ctx: SlashPromptContext): string {
  const source = ctx.selection?.trim() ? '选中的文本' : '页面内容'
  if (ctx.pageTitle) {
    return `【${source}｜${ctx.pageTitle}】`
  }
  return `【${source}】`
}

/** Hard-truncate page text with an explicit marker so the model knows. */
export function truncatePageText(text: string): string {
  const t = text.trim()
  if (t.length <= PAGE_TEXT_MAX_CHARS) return t
  return `${t.slice(0, PAGE_TEXT_MAX_CHARS)}\n\n[...内容过长已截断]`
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
