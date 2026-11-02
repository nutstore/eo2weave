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

import { ADAPTER_PAGE_MARKER } from '@creatorweave/shared/webmcp-adapter-protocol'
import {
  WEBMCP_INVOKE_IN_TAB_TYPE,
  WEBMCP_INVOKE_RELAY_TIMEOUT_MS,
  WEBMCP_PING_IN_TAB_TYPE,
  WEBMCP_TAB_REPORT_TYPE,
  buildRelayEnvelope,
  parseAgentEvent,
} from './webmcp/relay-protocol'

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

    let catalogGeneration = 0
    const syncAdapters = async () => {
      const generation = ++catalogGeneration
      let tools: unknown[] = []
      try {
        const result = await chrome.runtime.sendMessage({ type: 'webmcp_adapter_catalog' })
        if (result?.ok) tools = result.tools
      } catch { /* Withdraw proxies when the extension context is unavailable. */ }
      if (generation !== catalogGeneration) return
      window.postMessage(buildRelayEnvelope({ kind: 'adapters-sync', tools }), location.origin)
    }
    const refreshAdapters = () => { void syncAdapters().catch(() => {}) }
    refreshAdapters()
    setTimeout(refreshAdapters, 1500)
    // Re-discover live hosts after a service-worker restart.
    setInterval(refreshAdapters, 15000)
    window.addEventListener('message', event => {
      const data = event.data
      if (event.source !== window || data?.[ADAPTER_PAGE_MARKER] !== true || typeof data.requestId !== 'string') return
      if (data.kind === 'cancel') {
        void chrome.runtime.sendMessage({ type: 'webmcp_adapter_cancel', requestId: data.requestId }).catch(() => {})
      } else if (data.kind === 'invoke') {
        void chrome.runtime.sendMessage({ type: 'webmcp_adapter_invoke', requestId: data.requestId, routeId: data.routeId, args: data.args })
          .catch(error => ({ ok: false, error: { message: String(error) } }))
          .then(response => {
            if (!response?.ok)
              console.warn('[WebMCP adapters] Invocation failed:', response?.error ?? response)
            window.postMessage({ [ADAPTER_PAGE_MARKER]: true, kind: 'result', requestId: data.requestId, response }, location.origin)
          })
      }
    })

    // ── SPA route changes ──
    // Rematch adapter routes after client-side navigation.
    // NOTE: patching history.pushState here would be useless — the page
    // calls ITS OWN (MAIN-world) history object, invisible to this
    // ISOLATED world. `location`, however, IS synchronized across
    // worlds, so a light poll + popstate catches every route change.
    let lastUrl = location.href
    const onRouteChange = () => {
      if (location.href === lastUrl) return
      lastUrl = location.href
      refreshAdapters()
    }
    window.addEventListener('popstate', onRouteChange)
    window.addEventListener('hashchange', onRouteChange)
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

    // ── Upstream: background → page agent ──
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'webmcp_adapter_changed') { refreshAdapters(); return false }
      if (message?.type === 'webmcp_packages_changed') {
        // Package catalog changed (install/uninstall/opt-in enable in ANOTHER
        // context). Rebroadcast as a window event so page-level UI — e.g. the
        // settings package-registry section — can refresh its installed/
        // activation badges without a remount. A page event is enough: this
        // carries NO package data, just "go re-read".
        window.postMessage({ [ADAPTER_PAGE_MARKER]: true, kind: 'packages-changed' }, window.location.origin)
        return false
      }
      if (message?.type === WEBMCP_INVOKE_IN_TAB_TYPE) {
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
              error: `No invoke-response from the page agent within ${WEBMCP_INVOKE_RELAY_TIMEOUT_MS}ms`,
            })
          }
        }, WEBMCP_INVOKE_RELAY_TIMEOUT_MS)

        invokeWaiters.set(requestId, { resolve: sendResponse, timeoutId })

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
