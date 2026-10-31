import { getWebMCPToolDescription } from '@creatorweave/i18n'
import { useI18nStore } from '@/i18n/store'

/**
 * Package ids shipped under browser-extension/builtin-webmcp/. Builtin
 * adapter tools enter page discovery under their package-qualified raw name
 * (`<packageId>.<toolName>`, see adapter-service buildRoutes), while a page
 * can register ANY raw tool name — including one qualified by a builtin
 * package id (e.g. the real package site registering a colliding
 * `com.discord.main.send_message`). Keep in sync with the directories in
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
 * MCP tools). NAME PARSER ONLY: a matching prefix alone proves nothing
 * about provenance — callers must gate on `adapterServed === true` before
 * trusting the result (see localizedToolDescription).
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
 * The TRUST ROOT is adapter provenance: `adapterServed` is set only by the
 * service-worker adapter catalog merge (browser-extension
 * entrypoints/webmcp/discovery.ts, after the persisted registerTab write)
 * and the registry sanitizer strips it from page-reported tool snapshots,
 * so a page can never forge it.
 *
 * STRICT gating — translation requires EXPLICIT provenance:
 *
 * - `adapterServed === true`: the tool was served by a builtin adapter —
 *   translate when the raw name is qualified by a builtin package id and a
 *   translation exists for the active locale.
 * - `adapterServed === false`: the tool is page-registered — NEVER
 *   translate, even when the raw name carries a builtin package qualifier
 *   (a page on a host matching a builtin package's hostname could otherwise
 *   register `com.discord.main.send_message` and have the authorization UI
 *   display the builtin's benign translated copy for a different action).
 * - `adapterServed === undefined`: no provenance evidence at all — NEVER
 *   translate. Extensions predating the flag (douban/xiaohongshu/jmail
 *   adapter tools already shipped in earlier releases) fall into this
 *   branch: users on those builds see the manifest English description
 *   until they update. Accepted product trade-off — the exploit window
 *   (a page registering a builtin-qualified name inheriting the benign
 *   translated copy in the authorization modal) outweighs the cosmetic
 *   loss, and the old prefix-based fallback is exactly the hole this gate
 *   closes: no prefix check alone can prove a tool is builtin.
 */
export function localizedToolDescription(tool: {
  source: string
  sourceId: string
  name: string
  description?: string | null
  /** Adapter provenance — set only by the SW adapter catalog merge. */
  adapterServed?: boolean
}): string | null {
  const english = tool.description?.trim() || null
  if (tool.source !== 'webmcp') return english
  // Only tools with EXPLICIT adapter provenance may receive builtin
  // translations. `false` (page-reported) and `undefined` (no evidence —
  // pre-flag extensions, MCP-style rows) both keep the provider's own
  // description, no matter what their raw name looks like.
  if (tool.adapterServed !== true) return english
  const builtinToolName = builtinPackageToolName(tool.name)
  if (!builtinToolName) return english
  const localized = getWebMCPToolDescription(
    useI18nStore.getState().locale,
    tool.sourceId,
    builtinToolName
  )
  return localized ?? english
}
