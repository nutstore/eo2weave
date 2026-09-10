/**
 * Side panel recipe opt-in prompt — decision logic.
 *
 * When CreatorWeave runs as the extension side panel, the upstream tab may
 * host one of the extension's built-in "recipes" (jmail.world archive /
 * JMessage): opt-in tool packs that expose MCP tools on sites which don't
 * ship native WebMCP. Historically the ONLY way to enable one was the
 * extension's recipes.html management page — buried, and users opening the
 * side panel on those sites never find it.
 *
 * This module asks the extension (via the page bridge
 * `window.__agentWeb.recipeCheckStatus`) whether the BOUND upstream tab
 * hosts a recipe, and whether it is already enabled:
 *
 *   side panel (web app)
 *     → window.__agentWeb.recipeCheckStatus(binding)      [MAIN world]
 *     → content.ts (ISOLATED relay)                        [postMessage]
 *     → background: resolveBoundSidePanelTab + recipes map [consent store]
 *     → { applicable, recipe?, enabled? }
 *
 * Consent is stored extension-side (chrome.storage.local) — the same map the
 * recipes.html management page writes. The web app NEVER persists "enabled"
 * itself; it only records a local dismissal cooldown so a "not now" answer
 * does not nag on every side-panel open. Dismissal lives in localStorage
 * (per browser profile, fine-grained per recipe id) and is deliberately NOT
 * synced anywhere: the authoritative opt-in state stays with the extension.
 */

export interface RecipePromptInfo {
  id: string
  displayName: string
  description: string
  glyph: string
  hostname: string
  toolCount: number
}

export interface RecipePromptStatus {
  /** Bridge reachable AND a recipe exists for the bound tab's location. */
  applicable: boolean
  recipe?: RecipePromptInfo
  /** Recipe exists and the user already enabled it extension-side. */
  enabled?: boolean
  /** Bridge-level failure flag ({ok:false} from the background handlers). */
  ok?: boolean
  /** Structured failure (bridge unavailable, unauthorized binding, …). */
  errorCode?: string
}

const DISMISS_STORAGE_KEY = 'cw_sidepanel_recipe_dismissed_v1'
/** "Not now" cooldown: re-prompt after 1 day, not on every panel open. */
const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000

function readDismissedMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(DISMISS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [id, ts] of Object.entries(parsed)) {
      if (typeof ts === 'number' && Number.isFinite(ts)) out[id] = ts
    }
    return out
  } catch {
    return {}
  }
}

/** True when the user said "not now" for this recipe within the cooldown window. */
export function isRecipePromptDismissed(recipeId: string): boolean {
  const dismissedAt = readDismissedMap()[recipeId]
  if (typeof dismissedAt !== 'number') return false
  return Date.now() - dismissedAt < DISMISS_COOLDOWN_MS
}

/** Record a "not now" answer for the recipe (1-day cooldown). */
export function dismissRecipePrompt(recipeId: string): void {
  try {
    const map = readDismissedMap()
    map[recipeId] = Date.now()
    localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // localStorage unavailable (quota / privacy mode) — cooldown silently
    // degrades to "prompt may reappear next session". Never fatal.
  }
}

/** Test seam: clear all dismissal records. */
export function resetRecipePromptDismissals(): void {
  try {
    localStorage.removeItem(DISMISS_STORAGE_KEY)
  } catch {
    // localStorage unavailable — nothing to reset, and tests stub it anyway.
  }
}

interface AgentWebRecipeBridge {
  recipeCheckStatus?: (binding: string) => Promise<RecipePromptStatus>
}

/**
 * Ask the extension whether the bound upstream tab hosts an UNENABLED
 * recipe worth prompting for. Resolves `null` when:
 *   - not in side-panel mode (no binding id)
 *   - the extension bridge is missing (no plugin / ordinary tab)
 *   - no recipe matches the tab's current URL (nothing to offer)
 *   - the recipe is already enabled
 *   - the user dismissed the prompt within the cooldown window
 *
 * Bridge failures resolve `null` as well (never throw) — this prompt is a
 * nice-to-have and must not disturb side-panel startup.
 */
export async function getPendingRecipePrompt(): Promise<RecipePromptStatus | null> {
  const { getSidePanelBindingId } = await import('@/agent/workspace-assistant-context')
  const binding = getSidePanelBindingId()
  if (!binding) {
    console.info('[SidePanelRecipePrompt] skip: no side-panel binding (not side-panel mode)')
    return null
  }

  const agentWeb = (globalThis as { __agentWeb?: AgentWebRecipeBridge }).__agentWeb
  if (!agentWeb?.recipeCheckStatus) {
    console.warn('[SidePanelRecipePrompt] skip: extension bridge unavailable', {
      hasAgentWeb: !!agentWeb,
      hasRecipeCheckStatus: !!agentWeb?.recipeCheckStatus,
      hint: 'Extension needs a rebuild/update (recipe bridge methods added 2026-08-31)',
    })
    return null
  }

  let status: RecipePromptStatus | null = null
  try {
    // Bounded wait: side-panel startup must never hang on this probe. The
    // bridge itself has a 35s timeout; 4s covers cold service-worker starts
    // without stalling the modal long when the extension is half-dead.
    status = await Promise.race([
      agentWeb.recipeCheckStatus(binding),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ])
  } catch {
    return null
  }
  if (!status || status.ok === false) {
    console.warn('[SidePanelRecipePrompt] skip: bridge returned failure/timeout', {
      status,
      hint: 'UNAUTHORIZED_TARGET = binding/trusted-origin check failed in background; null = 4s probe timeout',
    })
    return null
  }
  if (!status.applicable || !status.recipe || typeof status.recipe.id !== 'string') {
    console.info('[SidePanelRecipePrompt] skip: no recipe matches bound tab URL', {
      status,
    })
    return null
  }
  if (status.enabled) {
    console.info('[SidePanelRecipePrompt] skip: recipe already enabled', status.recipe?.id)
    return null
  }
  if (isRecipePromptDismissed(status.recipe.id)) {
    console.info('[SidePanelRecipePrompt] skip: within dismissal cooldown', status.recipe.id)
    return null
  }

  return {
    applicable: true,
    recipe: status.recipe,
    enabled: false,
  }
}

/**
 * One-shot enable flow behind the modal's primary button:
 * flip the extension-side consent switch AND reload the upstream page so
 * injection is guaranteed (storage.onChanged alone cannot reach pages whose
 * content scripts were never injected — e.g. loaded before the extension
 * install/update). Returns the bridge's ok flag.
 */
export async function enableRecipeAndReload(recipeId: string): Promise<boolean> {
  const { getSidePanelBindingId } = await import('@/agent/workspace-assistant-context')
  const binding = getSidePanelBindingId()
  if (!binding) return false

  const agentWeb = (
    globalThis as {
      __agentWeb?: AgentWebRecipeBridge & {
        recipeEnable?: (binding: string, recipeId: string) => Promise<{ ok?: boolean; error?: string }>
      }
    }
  ).__agentWeb
  if (!agentWeb?.recipeEnable) return false

  try {
    const result = await Promise.race([
      agentWeb.recipeEnable(binding, recipeId),
      new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), 8000)),
    ])
    return result?.ok === true
  } catch {
    return false
  }
}

/**
 * Re-probe cadence for HOST-CHANGE detection. The upstream tab can
 * navigate to a DIFFERENT hostname after the side panel opened (e.g.
 * movie.douban.com redirects its search to search.douban.com — two
 * hosts, two separate recipes). The initial probe at panel open only
 * saw the first host, so we re-probe periodically and on window focus.
 *
 * 15s is a deliberate trade-off:
 *  - slow enough that the probe (postMessage → background → storage)
 *    is negligible overhead,
 *  - fast enough that the user typically sees the consent modal within
 *    one focus cycle after the upstream site navigated away.
 * Abuse is bounded by the 1-day dismissal cooldown: a host the user
 * already declined NEVER re-prompts.
 */
export const RECIPE_REPROBE_INTERVAL_MS = 15_000

/**
 * Dev/diagnostic helper: run the FULL probe chain step by step and
 * return a structured trace of where it bails. Exposed on window as
 * __cwDebugRecipeProbe() by AppBootstrap in side-panel mode so a
 * missing opt-in prompt can be diagnosed with one console command.
 */
export async function debugRecipeProbe(): Promise<Record<string, unknown>> {
  const trace: Record<string, unknown> = {}
  const { getSidePanelBindingId } = await import('@/agent/workspace-assistant-context')
  trace.binding = getSidePanelBindingId()
  trace.inSessionStorage = (() => {
    try { return sessionStorage.getItem('__cw_workspace_assistant_binding') } catch { return 'err' }
  })()
  const agentWeb = (globalThis as { __agentWeb?: AgentWebRecipeBridge }).__agentWeb
  trace.hasAgentWeb = !!agentWeb
  trace.hasRecipeCheckStatus = !!agentWeb?.recipeCheckStatus
  if (!trace.binding || !agentWeb?.recipeCheckStatus) return trace
  try {
    trace.status = await Promise.race([
      agentWeb.recipeCheckStatus(String(trace.binding)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ])
  } catch (e) {
    trace.status = `threw: ${String(e)}`
  }
  trace.dismissedMap = (() => {
    try { return JSON.parse(localStorage.getItem(DISMISS_STORAGE_KEY) || '{}') } catch { return 'err' }
  })()
  return trace
}

if (typeof window !== 'undefined') {
  (window as unknown as { __cwDebugRecipeProbe?: typeof debugRecipeProbe }).__cwDebugRecipeProbe = debugRecipeProbe
}
