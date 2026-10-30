import { getWebMCPToolDescription } from '@creatorweave/i18n'
import { useI18nStore } from '@/i18n/store'

/**
 * Localized tool description for USER-FACING surfaces (tool-auth modal block,
 * search_tools results panel) — display only.
 *
 * WebMCP builtin package manifests (browser-extension/builtin-webmcp/) ship
 * one English description per tool because that text is consumed by the LLM
 * agent through search_tools/call_tool protocol responses. The localized
 * copies (webmcpTools i18n namespace, keyed by package hostname + tool name)
 * are for the human: when the tool comes from a builtin package with
 * translations for the active locale, return the localized description;
 * otherwise (MCP servers, unknown hosts/tools) fall back to the provider's
 * own English description.
 */
export function localizedToolDescription(tool: {
  source: string
  sourceId: string
  name: string
  description?: string | null
}): string | null {
  const english = tool.description?.trim() || null
  if (tool.source !== 'webmcp') return english
  const localized = getWebMCPToolDescription(
    useI18nStore.getState().locale,
    tool.sourceId,
    tool.name
  )
  return localized ?? english
}
