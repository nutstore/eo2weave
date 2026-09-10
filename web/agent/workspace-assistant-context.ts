/**
 * Workspace Assistant — Side Panel Context
 *
 * CreatorWeave mounts inside the browser extension's side panel (per-tab —
 * each tab has its own CreatorWeave instance).
 *
 * Architecture:
 *   - CreatorWeave runs in side panel mode, identified by URL hash params.
 *   - When active, CreatorWeave pulls page context from the upstream tab
 *     AT SYSTEM PROMPT BUILD TIME (not at load time). This avoids the
 *     race / stale-data problem entirely: every LLM call gets fresh context.
 *   - The pull goes through the existing browser extension bridge:
 *       CreatorWeave → window.__agentWeb.fetchBoundPageContext()
 *         → injected.content.ts (MAIN world content script, matches <all_urls>)
 *           posts window.postMessage({__agentWebBridge:true,...})
 *         → content.ts (ISOLATED world content script) calls
 *             chrome.runtime.sendMessage({type:'requestBoundPageContext'})
 *         → background.ts handles it, executes
 *             `window.__sidePanelContextProvider.getContext()` in the upstream tab
 *             via chrome.scripting.executeScript({world:'MAIN'})
 *         → result flows back the same chain.
 *   - CreatorWeave itself never touches `chrome.runtime` — that's only
 *     available in extension pages, not in the web page context where
 *     CreatorWeave loads (even when displayed inside a side panel iframe).
 *
 * Provider convention (NOT CreatorWeave's concern — anyone can implement):
 *   The upstream page (or a userscript like Tampermonkey) is expected to
 *   expose:
 *     window.__sidePanelContextProvider = {
 *       getContext: () => any  // any shape; CreatorWeave does NOT parse
 *     }
 *   This is a soft convention between the upstream site and the browser
 *   extension — neither this file nor CreatorWeave enforces it.
 *
 * Why pull (not push):
 *   - Context is fetched fresh on every LLM call, so user changes on the
 *     upstream page (e.g. switching tabs in the workspace) are reflected
 *     immediately.
 *   - No module-level context state to manage or invalidate.
 *
 * Why NOT WebMCP:
 *   - WebMCP tools are visible to the LLM in its tool catalog. The agent
 *     would call them itself. We want CreatorWeave to inject context once
 *     into the system prompt, not expose it as a re-callable tool.
 */

const SIDE_PANEL_FLAG_KEY = '__cw_workspace_assistant_pending'
const SIDE_PANEL_HOSTNAME_KEY = '__cw_workspace_assistant_hostname'
const SIDE_PANEL_MODE_KEY = '__cw_workspace_assistant_mode'
const SIDE_PANEL_BINDING_KEY = '__cw_workspace_assistant_binding'

//=============================================================================
// Module-level state
//=============================================================================
//
// We only remember the side-panel mode and routing hostname. Page context
// is NOT stored here — it's fetched fresh each time fetchSidePanelContext()
// is called.

let _sidePanelBindingId: string | null = null
let _sidePanelHostname: string | null = null

export function isSidePanelMode(): boolean {
  return _sidePanelBindingId !== null
}

/** Opaque extension-generated binding; never expose the target tab id. */
export function getSidePanelBindingId(): string | null {
  return _sidePanelBindingId
}

export function getSidePanelHostname(): string | null {
  return _sidePanelHostname
}

/**
 * Whether this page load still has a one-shot hostname → project routing
 * request waiting to be consumed. This intentionally reads sessionStorage
 * rather than module state so the root App Router page can defer its ordinary
 * redirect even while the storage bootstrap is still in progress.
 */
export function hasPendingSidePanelProjectRoute(): boolean {
  try {
    return sessionStorage.getItem(SIDE_PANEL_FLAG_KEY) === '1'
  } catch {
    return false
  }
}


//=============================================================================
// Recovery from sessionStorage
//=============================================================================
//
// Vite HMR can re-evaluate this module AFTER the IIFE below has already
// run and stripped `?tabId=&origin=` from the URL hash. Without this
// backstop, the module-level state resets to null and isSidePanelMode()
// would falsely report false even though CreatorWeave is genuinely
// running in a side panel — causing enhancements.ts to skip the page
// context block silently.
//
// We restore the mode + hostname from sessionStorage BEFORE the IIFE runs.
// Then the IIFE either:
//   - finds fresh side-panel metadata in the URL (normal first load), OR
//   - sees a clean URL (HMR re-eval) and returns early, leaving the
//     recovered state intact.
//
// SIDE_PANEL_FLAG_KEY is NOT restored here — handleWorkspaceAssistantOnReady
// owns its lifecycle (it consumes + removes that key after project routing).
function recoverFromSessionStorage() {
  try {
    _sidePanelBindingId = sessionStorage.getItem(SIDE_PANEL_BINDING_KEY)
    const persistedHostname = sessionStorage.getItem(SIDE_PANEL_HOSTNAME_KEY)
    if (persistedHostname) _sidePanelHostname = persistedHostname
  } catch { /* ignore: sessionStorage unavailable, defaults are fine */ }
}
recoverFromSessionStorage()

//=============================================================================
// Runtime context fetch
//=============================================================================

/**
 * Fetch the upstream tab's context by asking the browser extension to
 * pull it. Returns whatever the provider's `getContext()` returns (any
 * shape). Returns `null` if:
 *   - not in side panel mode
 *   - the browser extension bridge is unavailable (no content script
 *     injected on this page, e.g. CreatorWeave opened in a regular tab
 *     without the extension being active on that origin)
 *   - the upstream tab did not expose a provider
 *   - the request times out or fails for any reason
 *
 * The pull goes through the existing `window.__agentWeb.fetchSidePanelContext`
 * bridge — NOT `chrome.runtime.sendMessage` directly. CreatorWeave always
 * runs in a regular web page context (localhost:5173 in dev, the prod
 * domain in prod), even when the page is displayed inside a Chrome
 * extension side panel iframe. Web pages don't have access to the
 * `chrome.runtime` API; the only legitimate way to talk to the extension
 * from CreatorWeave is via the content-script bridge that `injected.content.ts`
 * (MAIN world) and `content.ts` (ISOLATED world, matches <all_urls>)
 * set up — relay: window.postMessage ↔ chrome.runtime.sendMessage.
 *
 * `background.ts` resolves the opaque binding sent with this request, then
 * `chrome.scripting.executeScript({world:'MAIN'})` on the upstream tab
 * to read `window.__sidePanelContextProvider.getContext()`.
 *
 * 3-second timeout: extensions that hang (e.g. page in a weird state)
 * must not block LLM calls indefinitely.
 */
const CONTEXT_FETCH_TIMEOUT_MS = 3000

export async function fetchSidePanelContext(): Promise<unknown | null> {
  if (_sidePanelBindingId === null) return null

  const agentWeb = (
    globalThis as {
      __agentWeb?: {
        fetchBoundPageContext?: (binding: string) => Promise<unknown>
      }
    }
  ).__agentWeb
  if (!agentWeb?.fetchBoundPageContext) {
    console.warn(
      '[Workspace Assistant] window.__agentWeb.fetchBoundPageContext not available',
      {
        hasAgentWeb: !!agentWeb,
        hasMethod: !!agentWeb?.fetchBoundPageContext,
        hint: 'Is the eo2weave browser extension installed and active on this origin?',
      },
    )
    return null
  }

  try {
    const result = await Promise.race([
      agentWeb.fetchBoundPageContext(_sidePanelBindingId),
      new Promise<unknown>((_, reject) =>
        setTimeout(
          () => reject(new Error('context fetch timeout')),
          CONTEXT_FETCH_TIMEOUT_MS,
        ),
      ),
    ])
    return (result as unknown) ?? null
  } catch (err) {
    console.warn('[Workspace Assistant] fetch context failed:', err)
    return null
  }
}

//=============================================================================
// URL capture — runs synchronously at module load (before React Router
// can modify the hash). Records tabId + hostname, then strips params.
//=============================================================================

function extractHostname(originLike: string | null): string | null {
  if (!originLike) return null
  try {
    return new URL(originLike).hostname || null
  } catch {
    return null
  }
}

function captureTriggerOnLoad() {
  if (typeof window === 'undefined') return

  const url = new URL(window.location.href)
  const hash = url.hash || ''
  const legacyQueryStart = hash.indexOf('?')
  // Support both normal-query and hash-query launch URLs while migrating
  // extension builds. Both are cleared after this initial capture.
  const params = url.searchParams.size > 0
    ? url.searchParams
    : legacyQueryStart !== -1
      ? new URLSearchParams(hash.slice(legacyQueryStart + 1))
      : null

  if (!params || params.get('source') !== 'side_panel') return

  const bindingId = params.get('binding')
  if (!bindingId) return
  _sidePanelBindingId = bindingId
  try {
    sessionStorage.setItem(SIDE_PANEL_MODE_KEY, '1')
    sessionStorage.setItem(SIDE_PANEL_BINDING_KEY, bindingId)
  } catch { /* ignore: sessionStorage unavailable, context stays in-memory only */ }

  const hostname = extractHostname(params.get('origin'))
  if (hostname) {
    _sidePanelHostname = hostname
    sessionStorage.setItem(SIDE_PANEL_FLAG_KEY, '1')
    sessionStorage.setItem(SIDE_PANEL_HOSTNAME_KEY, hostname)
  }

  // The binding is now in sessionStorage. Remove all transient metadata from
  // the URL; `sender.url` is never used as binding state.
  const cleanHash = legacyQueryStart === -1 ? hash : hash.slice(0, legacyQueryStart)
  window.history.replaceState(
    {},
    document.title,
    window.location.pathname + cleanHash,
  )
}

captureTriggerOnLoad()

//=============================================================================
// AppReady handler — find-or-create the per-hostname project.
//=============================================================================
//
// Per-hostname project routing (refactored 2026-07-13): one upstream
// hostname maps to one CreatorWeave project, regardless of how many tabs
// the user has open on that site. Rationale:
//   - hostname is stable across navigations; tabId is ephemeral
//   - matches user mental model: "the workspace.jianguoyun.com project"
//   - avoids cluttering the sidebar with one project per tab
//   - the new pull-based context architecture (`fetchSidePanelContext`
//     pulls fresh page context from the *current* upstream tab at every
//     LLM call) means a shared project doesn't leak page content across
//     tabs — the prompt always reflects the page the user is currently
//     looking at. Conversation history is shared, page context isn't.
//
// `tabId` is still captured (needed for the context-pull bridge) but it
// no longer participates in project routing. Falls back to tabId only
// when the user opened CreatorWeave directly without going through the
// extension (rare — no upstream origin → no hostname).

const HOSTNAME_TO_PROJECT_KEY = 'cw_side_panel_hostname_project_map_v1'

export async function handleWorkspaceAssistantOnReady(
  navigate: (path: string) => void,
): Promise<void> {
  if (!sessionStorage.getItem(SIDE_PANEL_FLAG_KEY)) return
  sessionStorage.removeItem(SIDE_PANEL_FLAG_KEY)

  const hostname = sessionStorage.getItem(SIDE_PANEL_HOSTNAME_KEY)
  sessionStorage.removeItem(SIDE_PANEL_HOSTNAME_KEY)

  // Prefer hostname. A panel opened without an origin has no deterministic
  // routing key, so leave the current project unchanged.
  const projectKey = hostname
  if (!projectKey) return

  try {
    const { useProjectStore } = await import('@/store/project.store')
    const store = useProjectStore.getState()

    let projectId: string | null = null

    // Try saved id
    try {
      const raw = localStorage.getItem(HOSTNAME_TO_PROJECT_KEY)
      if (raw) {
        const map = JSON.parse(raw) as Record<string, string>
        if (map[projectKey] && store.projects.some((p) => p.id === map[projectKey])) {
          projectId = map[projectKey]
        }
      }
    } catch { /* ignore: corrupt/unavailable storage, fall through to name lookup */ }

    if (!projectId) {
      const existing = store.projects.find((p) => p.name === projectKey)
      if (existing) projectId = existing.id
    }

    if (!projectId) {
      const project = await store.createProject(projectKey)
      if (!project) return
      projectId = project.id
    }

    try {
      const raw = localStorage.getItem(HOSTNAME_TO_PROJECT_KEY)
      const map = raw ? (JSON.parse(raw) as Record<string, string>) : {}
      map[projectKey] = projectId!
      localStorage.setItem(HOSTNAME_TO_PROJECT_KEY, JSON.stringify(map))
    } catch { /* ignore: best-effort persistence, routing still proceeds */ }

    // Bare project URL (workspace resolved from store state by the route
    // sync hook). NOTE: this module intentionally has no top-level imports
    // (kept out of the startup bundle), so the path builder is imported here.
    const { projectWorkspacePath } = await import('@/lib/route-paths')
    navigate(projectWorkspacePath(projectId!))
  } catch (err) {
    console.warn('[Workspace Assistant] Failed to handle side panel open:', err)
  }
}

//=============================================================================
// Page context capture + rendering
//=============================================================================
//
// These helpers replaced the old system-prompt injection (which broke prompt
// caching). Now the page context is captured per-user-message (like image OCR
// text) and rendered into the user message text only at LLM-send time.

export interface PageContextSnapshot {
  hostname?: string | null
  url?: string | null
  title?: string | null
  selectedText?: string | null
  providerContext?: unknown
  webmcpTools?: Array<{ name: string; description: string; fullName: string }>
}

/**
 * Read the WebMCP tool list for an upstream hostname from the web app's
 * discovery cache (useWebMCPStore — populated by the agent loop via
 * discoverWebMCPCatalog, TTL 8s, authorized tools only).
 *
 * Purpose: give the LLM tool NAMES + descriptions in the page-context
 * block so `search_tools` is no longer a blind guess (BM25 needs keywords;
 * before this, the LLM did not even know what tools existed here).
 * Schemas are deliberately NOT included — search_tools already returns
 * search + schema in one call, and embedding schemas would bloat every
 * message by KBs.
 *
 * Store read (not fresh discovery) by design: capturePageContext runs on
 * the message-send path and must stay fast; the agent loop refreshes the
 * catalog right before tool use anyway.
 */
async function readWebmcpToolsForHost(
  hostname: string | null,
  tabId: number | null,
): Promise<
  Array<{ name: string; description: string; fullName: string }>
> {
  if (!hostname) return []
  const { useWebMCPStore } = await import('@/webmcp/store')
  const collect = (): Array<{ name: string; description: string; fullName: string }> => {
    const tools = useWebMCPStore.getState().getAllTools()
    const host = hostname.trim().toLowerCase()
    const seen = new Set<string>()
    const out: Array<{ name: string; description: string; fullName: string }> = []
    for (const tool of tools) {
      if ((tool.hostname || '').trim().toLowerCase() !== host) continue
      // Tab scoping (when known): same-hostname tabs in different apps
      // (jmail.world / vs /messages) expose disjoint tool groups; only the
      // group backed by the BOUND tab is relevant to this snapshot.
      if (typeof tabId === 'number' && tool.representativeTabId !== tabId) continue
      if (seen.has(tool.fullName)) continue
      seen.add(tool.fullName)
      out.push({
        name: tool.name,
        description: tool.description || '',
        fullName: tool.fullName,
      })
    }
    return out
  }
  try {
    let tools = collect()
    if (tools.length === 0) {
      // Cold start: the message-send path runs BEFORE the agent loop's
      // buildRuntimeEnhancedPrompt() discovery. Trigger one discovery
      // (TTL-cached + inflight-deduped, so warm turns never re-pay this)
      // so the FIRST message's snapshot doesn't falsely say "none".
      try {
        const { discoverWebMCPCatalog } = await import('@/webmcp/manager')
        await Promise.race([
          discoverWebMCPCatalog(),
          new Promise((r) => setTimeout(r, 1500)),
        ])
        tools = collect()
      } catch {
        // bridge unavailable — keep the empty list
      }
    }
    return tools
  } catch {
    // store unavailable (early boot / non-extension context) — degrade to empty
    return []
  }
}

/**
 * Capture a fresh page-context snapshot from the upstream tab, if CreatorWeave
 * is in side-panel mode. Returns null otherwise (non-side-panel sessions).
 */
export async function capturePageContext(): Promise<PageContextSnapshot | null> {
  if (!isSidePanelMode()) return null
  const hostname = getSidePanelHostname()
  try {
    const upstream = await fetchSidePanelContext()
    // Generic over the expected field type so per-field casts live at the call
    // site (where we know the contract) instead of leaking `unknown` through
    // PageContextSnapshot. `providerContext` falls through to `unknown` by
    // default — it has no stable schema.
    const pick = <T = unknown>(key: string): T | null =>
      upstream && typeof upstream === 'object' && key in upstream
        ? ((upstream as Record<string, unknown>)[key] as T)
        : null
    // Share the bound tab id with the get_page_tools / <current_page_webmcp>
    // fast path so it lists only THIS tab's tool group (same-hostname tabs
    // in different apps expose disjoint toolsets).
    const boundTabId = pick<number>('tabId')
    try {
      const { setSidePanelBoundTabId } = await import('./external-tool-bridge')
      setSidePanelBoundTabId(typeof boundTabId === 'number' ? boundTabId : null)
    } catch {
      // bridge module unavailable — fast path falls back to hostname-only
    }
    return {
      hostname,
      url: pick<string>('url'),
      title: pick<string>('title'),
      selectedText: pick<string>('selectedText'),
      providerContext: pick('providerContext'),
      // Scope tools to the BOUND TAB, not just the hostname: same-hostname
      // tabs in different apps (jmail.world / vs /messages) expose disjoint
      // toolsets and hostname-only filtering merges them into garbage.
      webmcpTools: await readWebmcpToolsForHost(hostname, boundTabId),
    }
  } catch (err) {
    console.warn('[Workspace Assistant] capturePageContext failed:', err)
    return { hostname }
  }
}

/**
 * Read the current upstream page URL, as cheaply as possible, for the "has
 * the page changed?" comparison.
 *
 * Bridge capability probing (forward-compatible):
 *   1. If a future plugin build exposes a lightweight `fetchSidePanelUrl`
 *      (reads just window.location via the already-injected __cwUpstreamPage
 *      content script, WITHOUT calling the site's getContext() provider),
 *      we use it — one cheap round-trip, no backend call.
 *   2. Otherwise we fall back to the full `fetchSidePanelContext` and keep
 *      only the url field. This is what current plugin builds (1.1.0+)
 *      support. It does invoke the site's getContext() provider, so the
 *      optimization only fully pays off once the lightweight bridge lands —
 *      but the comparison logic itself is correct regardless.
 *
 * Returns null in non-side-panel mode, or when the read fails.
 */
export async function capturePageUrl(): Promise<string | null> {
  if (!isSidePanelMode()) return null
  try {
    // ── Forward-compatible: prefer a lightweight url-only bridge if present ──
    const agentWeb = (
      globalThis as {
        __agentWeb?: {
          fetchBoundPageUrl?: () => Promise<unknown>
        }
      }
    ).__agentWeb
    if (agentWeb?.fetchBoundPageUrl) {
      const url = await Promise.race([
        agentWeb.fetchBoundPageUrl(),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('url fetch timeout')), 1500),
        ),
      ])
      return typeof url === 'string' && url ? url : null
    }
    // ── Current plugin builds: full pull, keep only the url field ──
    const upstream = await fetchSidePanelContext()
    const url =
      upstream && typeof upstream === 'object' && 'url' in upstream
        ? (upstream as { url?: unknown }).url
        : null
    return typeof url === 'string' && url ? url : null
  } catch (err) {
    console.warn('[Workspace Assistant] capturePageUrl failed:', err)
    return null
  }
}

/**
 * Decide whether the latest user message needs a fresh page-context snapshot
 * attached. Optimization to avoid re-pulling (and re-sending) context on every
 * message when the user is still on the same page.
 *
 * Rules (only the LAST user message with a pageContext is considered):
 *   - No prior message carries a pageContext → must refresh (first send, or
 *     context was dropped by compression) → returns `true`.
 *   - The last pageContext-bearing message's URL differs from the current
 *     upstream URL → user navigated → returns `true`.
 *   - URL unchanged → context is still valid → returns `false` (skip capture).
 *
 * `currentUrl` is the fresh URL just read via capturePageUrl().
 */
export function shouldRefreshPageContext(
  messages: { role: string; pageContext?: PageContextSnapshot | null }[],
  currentUrl: string | null,
): boolean {
  // Walk backwards to find the most recent message that carries a pageContext.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'user') continue
    if (!msg.pageContext) continue
    // Found the most recent page-context snapshot.
    const lastUrl = msg.pageContext.url
    // No URL recorded (legacy/odd snapshot) → refresh to be safe.
    if (typeof lastUrl !== 'string' || !lastUrl) return true
    // Couldn't read the current URL (extension hiccup) → refresh to be safe.
    if (!currentUrl) return true
    // Same URL → context still valid, skip the pull.
    return lastUrl !== currentUrl
  }
  // No pageContext-bearing message at all → must capture.
  return true
}

/**
 * Render a page-context snapshot into a markdown block suitable for appending
 * to a user message (mirrors the old system-prompt block). Returns an empty
 * string when the snapshot is null (non-side-panel mode).
 */
export function renderPageContextBlock(ctx: PageContextSnapshot | null): string {
  if (!ctx) return ''
  const hostname = ctx.hostname || 'an upstream website'
  const urlStr = typeof ctx.url === 'string' && ctx.url ? ctx.url : 'unknown'
  const titleStr = typeof ctx.title === 'string' && ctx.title ? ctx.title : 'unknown'
  const selStr = typeof ctx.selectedText === 'string' ? ctx.selectedText : ''

  let block = '\n\n<current_page_context>\n'
  block += `You are running as a side panel in the browser sidebar, linked to the upstream page the user is browsing. The user invoked you from ${hostname}.\n`
  block += '\n[Source — read live by eo2weave]\n'
  block += `- Website: ${ctx.hostname || 'unknown'}\n`
  block += `- URL: ${urlStr}\n`
  block += `- Title: ${titleStr}\n`
  block += `- Selected text: ${selStr ? selStr : '(none)'}\n`

  if (ctx.providerContext != null) {
    let rendered: string
    if (typeof ctx.providerContext === 'string') {
      rendered = ctx.providerContext
    } else {
      try {
        rendered = JSON.stringify(ctx.providerContext, null, 2)
      } catch (err) {
        console.warn('[Workspace Assistant] Failed to stringify providerContext:', err)
        rendered = '[unserializable provider context]'
      }
    }
    block += '\n[Page details — provided live by ' + hostname + ']\n```\n' + rendered + '\n```\n'
  } else {
    block += `\n[Page details — ${hostname} provided no additional business fields]\n`
  }

  // WebMCP tool awareness: names + descriptions only (no schemas —
  // search_tools returns schema together with search results, so the
  // context block stays lean while the LLM still knows WHAT exists).
  const webmcpTools = Array.isArray(ctx.webmcpTools) ? ctx.webmcpTools : []
  if (webmcpTools.length > 0) {
    block += `\n[WebMCP tools — available on ${hostname} right now]\n`
    for (const tool of webmcpTools) {
      // First-sentence trim, but tolerant of abbreviations: "e.g." and
      // "i.e." must NOT end the sentence (observed live: "…(from
      // list_conversations, e.g. steve-bannon)" was cut at "e").
      const desc = tool.description
        ? tool.description
            .replace(/\b(e\.g|i\.e)\./g, 'ᴇɢ')
            .split(/[.\n]/)[0]
            .replace(/ᴇɢ/g, 'e.g.')
            .trim()
            .slice(0, 160)
        : ''
      block += `- ${tool.fullName}${desc ? ' — ' + desc : ''}\n`
    }
    block += '\nThese names come straight from the site (native WebMCP or an eo2weave recipe). For the EXACT call_tool names with full schemas, call `get_page_tools` (one cheap local read — no search needed); they are also listed in the system prompt\'s <current_page_webmcp> block. Only use `search_tools` for MCP servers or other websites.\n'
  } else {
    block += `\n[WebMCP tools — ${hostname} exposes none at the moment]\n`
  }

  block += '\n**Important — always search before acting (other sites / MCP):** For interacting with OTHER websites or MCP servers, you MUST call `search_tools` first — do NOT guess tool names; they are case-sensitive and vary by provider. For THIS page, prefer the direct path: get_page_tools → call_tool.\n'
  block += '\nWhen the user says "this", "it", or "that one above", they usually mean an element in the context above. When the user navigates to a different page, URL/title/details refresh automatically — the user does not need to restate.\n'
  block += '\nTip: use the `web_fetch` tool on the URL above if you need the full page content.\n'
  block += '</current_page_context>'
  return block
}
