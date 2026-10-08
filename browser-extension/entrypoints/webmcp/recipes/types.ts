// ============================================================
// WebMCP recipes — user-enabled tool packs for sites that
// don't ship native WebMCP. A recipe bundles:
//   - metadata (shown on the management page)
//   - tool definitions (name/description/inputSchema)
//   - a `register()` implementation (DOM automation against
//     the live page — recipes never guess private APIs).
//
// Injection is opt-in per hostname: the management page
// (recipes.html) toggles storage, the ISOLATED bridge
// (webmcp.content.ts) forwards an activate command, and the
// MAIN-world injector (recipe-injector.content.ts) installs
// @mcp-b/webmcp-polyfill + registers the tools. Discovery then
// flows through the existing push pipeline (webmcp-injected →
// registry → popup) with zero changes.
// ============================================================

export interface WebMCPRecipeTool {
  /** Tool name exposed on document.modelContext (ASCII [A-Za-z0-9_\-.], ≤128). */
  name: string
  /** Short display title for the management page. */
  title: string
  description: string
  /** False for tools that change account/session state or publish content. */
  readOnlyHint?: boolean
  /** JSON Schema for the tool's input arguments. */
  inputSchema?: Record<string, unknown>
}

export interface WebMCPRecipe {
  id: string
  /** Exact hostname the recipe activates on (no wildcard for v1). */
  hostname: string
  /** Optional path prefixes scoping the recipe to specific app views on
   *  that hostname — one host can run several apps (jmail.world ships a
   *  Gmail-style archive at / and an iMessage view at /messages).
   *  Undefined = all paths. Prefix matching: '/activity' covers
   *  '/activity/2014'; '/' covers only the exact root. */
  pathPrefixes?: string[]
  displayName: string
  description: string
  category: 'archive' | 'reference' | 'productivity' | 'social' | 'media'
  version: string
  /** Emoji or short glyph shown as the card icon. */
  glyph: string
  tools: WebMCPRecipeTool[]
}

/** storage.local key: { [recipeId]: { enabledAt: number } } */
export const ENABLED_RECIPES_STORAGE_KEY = 'webmcp_enabled_recipes'
