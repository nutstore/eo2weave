import { getWebMCPToolDescription } from '@creatorweave/i18n'
import { useI18nStore } from '@/i18n/store'

/**
 * Package ids shipped under browser-extension/builtin-webmcp/. Builtin
 * adapter tools enter page discovery under their package-qualified raw name
 * (`<packageId>.<toolName>`, see adapter-service buildRoutes), while a page
 * can register ANY raw tool name — including one colliding with a translated
 * builtin tool. Translations are therefore trusted only for raw names
 * qualified by one of these ids. Keep in sync with the directories in
 * browser-extension/builtin-webmcp/ (enforced by webmcp-tools.test.ts).
 */
export const WEBMCP_BUILTIN_PACKAGE_IDS = [
  'com.discord.main',
  'com.douban.movie',
  'com.douban.search',
  'com.xiaohongshu.main',
  'world.jmail.archive',
  'world.jmail.messages',
] as const

/**
 * Strip the builtin package qualifier from a raw tool name, or return null
 * when the name is not qualified by a known builtin package (page tools,
 * MCP tools). The qualification is what keeps a page-registered
 * `send_message` from receiving the builtin package's translated copy.
 */
function builtinPackageToolName(name: string): string | null {
  for (const packageId of WEBMCP_BUILTIN_PACKAGE_IDS) {
    if (name.startsWith(`${packageId}.`)) return name.slice(packageId.length + 1)
  }
  return null
}

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
 *
 * Builtin translations apply ONLY to tools whose raw name is qualified by a
 * builtin package id (`com.discord.main.send_message`) — the shape adapter
 * tools carry through discovery. A page-registered tool with a bare
 * colliding name keeps its own description, so the authorization UI cannot
 * be made to display a benign builtin description for a different action.
 */
export function localizedToolDescription(tool: {
  source: string
  sourceId: string
  name: string
  description?: string | null
}): string | null {
  const english = tool.description?.trim() || null
  if (tool.source !== 'webmcp') return english
  const builtinToolName = builtinPackageToolName(tool.name)
  if (!builtinToolName) return english
  const localized = getWebMCPToolDescription(
    useI18nStore.getState().locale,
    tool.sourceId,
    builtinToolName
  )
  return localized ?? english
}
