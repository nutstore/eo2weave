// ============================================================
// Upstream Page Content Script (MAIN world)
//
// Generic "upstream page metadata reader" — runs on ALL URLs because CreatorWeave's
// side panel feature works with any upstream site that opts in
// (workspace.jianguoyun.com today, others later). The injected
// `__cwUpstreamPage` namespace exposes a small, stable API:
//
//   window.__cwUpstreamPage = {
//     getUrl():           string  — current page URL
//     getTitle():         string  — current document.title
//     getSelectedText():  string  — current window.getSelection() (trimmed).
//                                       Empty string if nothing is selected.
//   }
//
// background.ts calls these via chrome.scripting.executeScript({world:'MAIN'})
// to fetch fresh page metadata at every LLM call (never stale). The split
// keeps generic page metadata out of the upstream-specific
// `__sidePanelContextProvider` (which is per-site and carries business
// fields like page_type / public_id / selected_text).
//
// Why MAIN world: needs to read window.location.href / document.title
// from the page itself. ISOLATED world can't access these directly.
//
// Idempotency: we don't overwrite if someone else (e.g. a userscript)
// already defined __cwUpstreamPage — our values are baseline.
// ============================================================

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  world: 'MAIN',

  main() {
    if (!(window as any).__cwUpstreamPage) {
      ;(window as any).__cwUpstreamPage = {
        getUrl: () => window.location.href,
        getTitle: () => document.title,
        getSelectedText: () => {
          // Standard browser selection. Returns '' if nothing is selected.
          // Note: this is *current* selection, not a snapshot at any
          // particular moment — the LLM sees whatever the user has
          // highlighted when the system prompt is being built (which is
          // right before each LLM call).
          const sel = window.getSelection?.()
          return sel ? sel.toString().trim() : ''
        },
      }
      // eslint-disable-next-line no-console
      console.log('[CreatorWeave Upstream Page] ✅ __cwUpstreamPage injected')
    }
  },
})
