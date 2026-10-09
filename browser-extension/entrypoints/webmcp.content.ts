// ============================================================
// WebMCP relay — STATIC ISOLATED-world content script.
//
// Bridge between the MAIN-world page agent (webmcp-injected.content.ts)
// and the extension background's tab registry (webmcp/registry.ts):
//   page agent ⇄ window.postMessage ⇄ here ⇄ chrome.runtime ⇄ background
//
// Downstream (page → background):
//   ready / snapshot → webmcp_tab_report (one runtime message each).
//   invoke-response → resolved via the stored sendResponse handle.
//
// Upstream (background → page):
//   webmcp_invoke_in_tab / webmcp_ping_in_tab (tabs.sendMessage)
//   → window.postMessage into the page (relay envelope).
//
// Spoofing resistance: hostname/tabId/tabTitle/tabUrl/windowId are
// taken from the browser's sender object in the background, never
// from page-provided values. This script only relays validated
// envelopes (parseAgentEvent) and tool lists — a hostile page
// cannot forge a report about a different tab.
// ============================================================

import {
  WEBMCP_INVOKE_IN_TAB_TYPE,
  WEBMCP_INVOKE_RELAY_TIMEOUT_MS,
  WEBMCP_PING_IN_TAB_TYPE,
  WEBMCP_TAB_REPORT_TYPE,
  buildRelayEnvelope,
  parseAgentEvent,
} from './webmcp/relay-protocol'
import { XHS_INPUT_RESPONSE, XHS_OPERATION_TIMEOUT_MS, isXhsInputRequest, isXhsPreparationTool } from './webmcp/xiaohongshu-input-protocol'
import { ENABLED_RECIPES_STORAGE_KEY, findRecipeForLocation, findRecipesForHostname } from './webmcp/recipes'

type InvokeWaiter = {
  resolve: (value: {
    kind: 'invoke-response'
    requestId: string
    ok: boolean
    result?: unknown
    apiMode?: string
    errorCode?: string
    error?: string
  }) => void
  timeoutId: number
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',

  main() {
    const invokeWaiters = new Map<string, InvokeWaiter>()

    // ── Recipe activation (consent-gated) ──
    // storage.local holds the user's enabled-recipe map. When a
    // recipe matches this page's hostname AND is enabled, send a
    // recipe-activate command into the MAIN world. The MAIN-side
    // injector re-validates everything before registering tools.
    function postRecipeCommand(kind: 'recipe-activate' | 'recipe-deactivate', recipeId?: string): void {
      if (kind === 'recipe-activate' && recipeId) {
        window.postMessage(
          buildRelayEnvelope({ kind: 'recipe-activate', recipeId }),
          window.location.origin,
        )
      } else if (kind === 'recipe-deactivate') {
        window.postMessage(buildRelayEnvelope({ kind: 'recipe-deactivate' }), window.location.origin)
      }
    }

    async function syncRecipeState(): Promise<void> {
      try {
        const stored = await chrome.storage.local.get(ENABLED_RECIPES_STORAGE_KEY)
        const enabled = (stored?.[ENABLED_RECIPES_STORAGE_KEY] || {}) as Record<string, unknown>
        // Path-scoped: a hostname may host several apps with different
        // recipes (e.g. jmail.world archive vs JMessage /messages). Only
        // the recipe matching the CURRENT path activates here. The
        // injector's activate() already unregisters the previous recipe,
        // so exactly one command is sent — never an activate followed by
        // a blanket deactivate (which would abort the fresh registration).
        const active = findRecipeForLocation(location.hostname, location.pathname)
        if (!active && findRecipesForHostname(location.hostname).length === 0) return
        if (active && enabled[active.id]) {
          postRecipeCommand('recipe-activate', active.id)
          // Retry once after a delay: the MAIN-world injector may still be
          // booting (both scripts run at document_idle; ordering is not
          // guaranteed) and its message listener would miss the first send.
          setTimeout(() => postRecipeCommand('recipe-activate', active.id), 1500)
        } else {
          // No recipe for this path (other apps on the hostname) or
          // disabled by the user — clear anything a previous path
          // activated.
          postRecipeCommand('recipe-deactivate')
        }
      } catch {
        // storage unavailable — stay inactive, never auto-enable
      }
    }

    void syncRecipeState()
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[ENABLED_RECIPES_STORAGE_KEY]) {
        void syncRecipeState()
      }
    })

    // ── SPA route changes ──
    // Same-hostname apps navigate client-side (no page reload, no new
    // document_idle), so the recipe for the previous path keeps running.
    // NOTE: patching history.pushState here would be useless — the page
    // calls ITS OWN (MAIN-world) history object, invisible to this
    // ISOLATED world. `location`, however, IS synchronized across
    // worlds, so a light poll + popstate catches every route change.
    let lastPath = location.pathname
    const onRouteChange = () => {
      if (location.pathname === lastPath) return
      lastPath = location.pathname
      void syncRecipeState()
    }
    window.addEventListener('popstate', onRouteChange)
    window.setInterval(onRouteChange, 1000)

    // ── Downstream: page agent → background ──
    window.addEventListener('message', (event) => {
      if (event.source !== window) return
      const agentEvent = parseAgentEvent(event.data)
      if (!agentEvent) return

      if (agentEvent.kind === 'ready' || agentEvent.kind === 'snapshot') {
        try {
          // Callback form: no promise is created, so no unhandled
          // rejection when the background is momentarily unavailable.
          chrome.runtime.sendMessage(
            {
              type: WEBMCP_TAB_REPORT_TYPE,
              tools: agentEvent.tools,
              apiMode: agentEvent.apiMode,
              // Empty snapshot = tab no longer exposes tools (page
              // unregistered everything or getTools started failing)
              // → background drops the entry, keeps the "seen" marker.
            },
            () => {
              // Swallow chrome.runtime.lastError deliberately: during
              // extension updates the context is gone and that is normal.
              void chrome.runtime.lastError
            },
          )
        } catch {
          // extension context gone (update/reload) — nothing to relay to
        }
        return
      }

      // invoke-response: deliver via the stored sendResponse handle
      const waiter = invokeWaiters.get(agentEvent.requestId)
      if (waiter) {
        invokeWaiters.delete(agentEvent.requestId)
        clearTimeout(waiter.timeoutId)
        waiter.resolve(agentEvent)
      }
    })

    // Relay only requests belonging to an invocation delivered by the background.
    // The background additionally binds the capability to the sender's own tab.
    const inputSessions = new Set<string>()
    window.addEventListener('message', (event) => {
      if (event.source !== window || !isXhsInputRequest(event.data) || !inputSessions.has(event.data.session)) return
      const request = event.data
      void chrome.runtime.sendMessage(request).then((response) => {
        window.postMessage({ type: XHS_INPUT_RESPONSE, session: request.session, requestId: request.requestId, ...response }, location.origin)
      }).catch((error: Error) => {
        window.postMessage({ type: XHS_INPUT_RESPONSE, session: request.session, requestId: request.requestId, ok: false, error: error.message }, location.origin)
      })
    })

    // ── Upstream: background → page agent ──
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === WEBMCP_INVOKE_IN_TAB_TYPE) {
        const inputSession = isXhsPreparationTool(message.toolName) && typeof message.args?._eo2_input_session === 'string' ? message.args._eo2_input_session : undefined
        if (inputSession) inputSessions.add(inputSession)
        const finish = (response: unknown) => { if (inputSession) inputSessions.delete(inputSession); sendResponse(response) }
        const timeoutMs = isXhsPreparationTool(message.toolName) ? XHS_OPERATION_TIMEOUT_MS + WEBMCP_INVOKE_RELAY_TIMEOUT_MS : WEBMCP_INVOKE_RELAY_TIMEOUT_MS
        const requestId = `cw_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
        const timeoutId = window.setTimeout(() => {
          const waiter = invokeWaiters.get(requestId)
          if (waiter) {
            invokeWaiters.delete(requestId)
            waiter.resolve({
              kind: 'invoke-response',
              requestId,
              ok: false,
              errorCode: 'RELAY_TIMEOUT',
              error: `No invoke-response from the page agent within ${timeoutMs}ms`,
            })
          }
        }, timeoutMs)

        invokeWaiters.set(requestId, { resolve: finish, timeoutId })

        window.postMessage(
          buildRelayEnvelope({
            kind: 'invoke-request',
            requestId,
            toolName: String(message.toolName || ''),
            args:
              message.args && typeof message.args === 'object' && !Array.isArray(message.args)
                ? message.args
                : {},
          }),
          window.location.origin,
        )
        return true // async sendResponse
      }

      if (message?.type === WEBMCP_PING_IN_TAB_TYPE) {
        window.postMessage(buildRelayEnvelope({ kind: 'ping' }), window.location.origin)
        sendResponse({ ok: true })
        return false
      }

      return false
    })
  },
})
