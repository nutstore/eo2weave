// ============================================================
// Recipe injector — STATIC MAIN-world content script.
//
// Waits for an activate command from the ISOLATED bridge
// (webmcp.content.ts, which watches storage + hostname match),
// then:
//   1. installs @mcp-b/webmcp-polyfill (only when the page has
//      no native document.modelContext),
//   2. registers the enabled recipe's tools via
//      modelContext.registerTool(tool, { signal }),
//   3. relies on the existing webmcp-injected agent's 2s poll
//      to discover the new tools and push them to the registry
//      → popup shows them within seconds (zero pipeline changes).
//
// Security: runs in the page's MAIN world but is driven ONLY by
// the ISOLATED bridge, which checks user consent in
// storage.local before sending the activate command. The page
// cannot forge the activate command's origin check — the bridge
// sends it via window.postMessage with a one-time token minted
// per activation.
// ============================================================

import { registerPageTools } from './webmcp/register-tools'
import { createAdapterInjector } from './webmcp/adapter-injector'
import { CW_WEBMCP_AGENT_MARKER, parseRelayCommand } from './webmcp/relay-protocol'
import { findRecipeForLocation } from './webmcp/recipes'
import { jmailToolImplementations } from './webmcp/recipes/jmail-tools'
import { jmessageToolImplementations } from './webmcp/recipes/jmessage-tools'
import { doubanToolImplementations } from './webmcp/recipes/douban-movie-tools'

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  world: 'MAIN',

  main() {
    // ── implementation registry keyed by recipe id ──
    // Static imports keep the bundle simple; recipes for other
    // hosts are simply never activated there.
    const implementations: Record<string, Record<string, (args: Record<string, unknown>) => Promise<unknown>>> = {
      'jmail-world': jmailToolImplementations,
      'jmessage-world': jmessageToolImplementations,
      'douban-movie': doubanToolImplementations,
      'douban-search': doubanToolImplementations,
    }

    let activeRecipeId: string | null = null
    let activeController: AbortController | null = null

    function unregisterCurrent(): void {
      if (activeController) {
        activeController.abort()
        activeController = null
      }
      activeRecipeId = null
    }

    async function activate(recipeId: string): Promise<void> {
      // Path-scoped lookup: the recipe must match BOTH the hostname
      // and the current path (jmail.world runs several apps).
      const recipe = findRecipeForLocation(location.hostname, location.pathname)
      if (!recipe || recipe.id !== recipeId) return

      const impl = implementations[recipe.id]
      if (!impl) return

      unregisterCurrent()
      const controller = new AbortController()
      activeController = controller
      activeRecipeId = recipe.id

      await registerPageTools(recipe.tools.filter(tool => impl[tool.name]).map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: true },
        execute: (args: Record<string, unknown>) => impl[tool.name](args),
      })), controller).catch(error => {
        activeRecipeId = null
        console.warn(`[cw recipe] ${recipe.id}: registration failed`, error)
      })
    }

    const syncAdapters = createAdapterInjector(() => location.href)

    window.addEventListener('message', (event) => {
      if (event.source !== window) return
      const data = event.data as Record<string, unknown> | null
      if (!data || data[CW_WEBMCP_AGENT_MARKER] !== true) return

      const command = parseRelayCommand(data)
      if (!command) return

      if (command.kind === 'packages-sync') {
        void syncAdapters(command.packages).catch(error => console.warn('[WebMCP adapters] Injection failed:', error))
      } else if (command.kind === 'recipe-activate') {
        // Idempotent: same-app SPA route changes re-run the bridge's
        // syncRecipeState and re-send activate for the SAME recipe.
        // Re-registering would abort + re-register every tool, and the
        // page agent's poll could snapshot that empty window (popup
        // flicker). Skip when this recipe is already active — the
        // bridge's boot-time retry is likewise absorbed after the
        // first successful activation.
        if (activeRecipeId === command.recipeId) return
        void activate(command.recipeId)
      } else if (command.kind === 'recipe-deactivate') {
        unregisterCurrent()
      }
    })
  },
})
