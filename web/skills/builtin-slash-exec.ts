/**
 * Builtin slash command execution helpers — bridge between the input layer
 * (useConversationLogic.handleSend) and the command pack templates.
 *
 * Resolution order for the subject text:
 *   1. Live selection from the bound page (side-panel mode, fresh pull —
 *      cheaper than a full context refresh: one executeScript round-trip)
 *   2. pageContext.selectedText already in history (rare — selection changes)
 *   3. Page body text via a body-text executeScript (page mode)
 * The chosen scope is surfaced to the user through a toast so "page mode"
 * fallback is never silent (requirement #1).
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
 * a user-facing toast) when neither selection nor page text is available.
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

  const info = await fetchLivePageInfo()
  const selection = info?.selectedText ?? null
  const pageText = info?.pageText ?? null
  const pageTitle = info?.pageTitle ?? null
  const pageUrl = info?.pageUrl ?? null

  const hasSelection = !!(selection && selection.trim())
  const hasPage = !!(pageText && pageText.trim())
  if (!hasSelection && !hasPage) {
    toast.info(t(locale, `conversation.input.slashCommands.${def.i18nKey}.noContent`))
    return null
  }
  // Requirement: the page-body fallback must be user-perceivable.
  if (!hasSelection && hasPage) {
    toast.info(t(locale, `conversation.input.slashCommands.${def.i18nKey}.chipPageMode`))
  }

  const ctx: SlashPromptContext = {
    selection: hasSelection ? selection : null,
    pageText: hasSelection ? null : pageText,
    pageTitle,
    pageUrl,
    langArg: def.takesLangArg ? parts.slice(1).join(' ') : undefined,
  }
  return def.buildPrompt(ctx)
}
