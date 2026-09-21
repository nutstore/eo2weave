/**
 * Builtin slash command execution helpers — bridge between the input layer
 * (useConversationLogic.handleSend) and the command pack templates.
 *
 * Subject resolution order (works in BOTH main-app and side-panel modes):
 *   1. Inline subject after the command — "/polish 文字", "/translate en 文字"
 *   2. Live page selection (side-panel mode)
 *   3. Page body text (side-panel mode; page-mode toast keeps it perceivable)
 */

import type { SlashPromptContext } from './builtin-slash-commands'
import { BUILTIN_SLASH_COMMANDS } from './builtin-slash-commands'

/** ids of the P0 builtin command pack */
const BUILTIN_IDS = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.id))

/**
 * True when the trimmed input is exactly '/<builtinId>' or
 * '/<builtinId> <args…>' — only then does handleSend intercept it.
 * Unknown '/xyz' inputs fall through to the agent as plain text.
 */
export function matchesBuiltinCommand(inputTrimmed: string): boolean {
  if (!inputTrimmed.startsWith('/')) return false
  const id = inputTrimmed.slice(1).split(/\s+/)[0]?.toLowerCase()
  return id !== undefined && BUILTIN_IDS.has(id)
}

async function fetchLivePageInfo(): Promise<{
  selectedText: string | null
  pageText: string | null
  pageTitle: string | null
  pageUrl: string | null
} | null> {
  try {
    const { isSidePanelMode, fetchSidePanelContext } = await import(
      '@/agent/workspace-assistant-context'
    )
    if (!isSidePanelMode()) return null
    const upstream = (await fetchSidePanelContext()) as Record<string, unknown> | null
    if (!upstream || typeof upstream !== 'object') return null
    const pickStr = (k: string): string | null =>
      typeof upstream[k] === 'string' && (upstream[k] as string).length > 0
        ? (upstream[k] as string)
        : null

    const selectedText = pickStr('selectedText')
    // Page body only needed in page mode (no selection) — separate bridge call.
    let pageText: string | null = null
    if (!selectedText) {
      pageText = await fetchPageBodyText()
    }
    return {
      selectedText,
      pageText,
      pageTitle: pickStr('title'),
      pageUrl: pickStr('url'),
    }
  } catch {
    return null
  }
}

/** Page body text through the __agentWeb bridge (extension executes in tab). */
async function fetchPageBodyText(): Promise<string | null> {
  try {
    const { getSidePanelBindingId } = await import('@/agent/workspace-assistant-context')
    const binding = getSidePanelBindingId()
    if (!binding) return null
    const agentWeb = (
      globalThis as {
        __agentWeb?: {
          fetchPageBodyText?: (binding: string) => Promise<unknown>
        }
      }
    ).__agentWeb
    if (!agentWeb?.fetchPageBodyText) return null
    const result = await Promise.race([
      agentWeb.fetchPageBodyText(binding),
      new Promise<unknown>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ])
    return typeof result === 'string' && result.trim() ? result : null
  } catch {
    return null
  }
}

/**
 * Build the final prompt for a builtin command. Returns null (after showing
 * a user-facing toast) when no subject is available.
 *
 * Subject resolution order (works in BOTH main-app and side-panel modes):
 *   1. Inline subject typed after the command — "/polish 这段文字" or
 *      "/translate en 这段文字" (translate: first token = target lang)
 *   2. Live page selection (side-panel mode)
 *   3. Page body text (side-panel mode, surfaced with a page-mode toast)
 */
export async function assembleBuiltinCommandPrompt(inputTrimmed: string): Promise<string | null> {
  const { toast } = await import('sonner')
  const { t } = await import('@creatorweave/i18n')
  const { useI18nStore } = await import('@/i18n/store')
  const locale = useI18nStore.getState().locale
  const parts = inputTrimmed.slice(1).split(/\s+/)
  const id = (parts[0] ?? '').toLowerCase()
  const def = BUILTIN_SLASH_COMMANDS.find((c) => c.id === id)
  if (!def) return null

  // ── 1. Inline subject (any mode) ──
  let inlineSubject: string | null = null
  let langArg: string | undefined
  if (def.takesLangArg) {
    // /translate [lang] [text…] — lang optional, remaining tokens = subject
    const rest = parts.slice(1)
    const first = (rest[0] ?? '').toLowerCase()
    const knownLang = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru'].includes(first)
    if (rest.length > 0 && knownLang) {
      langArg = rest[0]
      inlineSubject = rest.slice(1).join(' ').trim() || null
    } else {
      inlineSubject = rest.join(' ').trim() || null
    }
  } else if (def.takesInlineSubject) {
    inlineSubject = parts.slice(1).join(' ').trim() || null
  }

  let selection: string | null = null
  let pageText: string | null = null
  let pageTitle: string | null = null
  let pageUrl: string | null = null

  // ── 2/3. Page context (side-panel only) — skipped when inline subject exists ──
  if (!inlineSubject) {
    const info = await fetchLivePageInfo()
    selection = info?.selectedText ?? null
    pageText = info?.pageText ?? null
    pageTitle = info?.pageTitle ?? null
    pageUrl = info?.pageUrl ?? null
  }

  const hasInline = !!(inlineSubject && inlineSubject.trim())
  const hasSelection = !!(selection && selection.trim())
  const hasPage = !!(pageText && pageText.trim())

  if (!hasInline && !hasSelection && !hasPage) {
    toast.info(t(locale, `conversation.input.slashCommands.${def.i18nKey}.noContent`))
    return null
  }
  // Requirement: the page-body fallback must be user-perceivable.
  if (!hasInline && !hasSelection && hasPage) {
    toast.info(t(locale, `conversation.input.slashCommands.${def.i18nKey}.chipPageMode`))
  }

  const ctx: SlashPromptContext = {
    selection: hasInline ? inlineSubject : hasSelection ? selection : null,
    pageText: !hasInline && !hasSelection ? pageText : null,
    pageTitle,
    pageUrl,
    langArg: def.takesLangArg ? langArg : undefined,
  }
  return def.buildPrompt(ctx)
}
