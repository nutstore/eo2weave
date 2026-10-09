// ============================================================
// WebMCP page agent — STATIC MAIN-world content script.
//
// mcp-b style push discovery (docs.mcp-b.ai/packages/webmcp-extension):
// instead of the popup scanning every tab on demand (5s-per-tab
// executeScript probe), this agent runs permanently in each page,
// resolves document/navigator.modelContext, and pushes a `ready`
// snapshot + `snapshot` updates to the ISOLATED-world relay
// (webmcp.content.ts) whenever the toolset changes — via the page
// API's toolchange event when available, plus a conservative
// diff-polling loop as a safety net (SPA hydration patterns don't
// always fire events; modelContext may also appear only after
// document_idle, so resolution itself is retried).
//
// It also receives invoke-requests relayed from the background
// (webmcp_invoke_in_tab → relay → window.postMessage here), which
// replaces the old executeScript-per-invoke path.
//
// Security: this runs in the page's JS world. Treat everything
// from the page as untrusted; never touch chrome.* APIs here.
// The relay validates events (parseAgentEvent) before forwarding.
// ============================================================

import { stageXiaohongshuImage, discardXiaohongshuImage } from './webmcp/recipes/xiaohongshu-publish-transfer'
import {
  CW_WEBMCP_AGENT_MARKER,
  buildAgentEnvelope,
  parseRelayCommand,
} from './webmcp/relay-protocol'
import { resolveAgentApi, type ResolvedAgentApi } from './webmcp/agent-core'

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  world: 'MAIN',

  main() {
    type AgentRuntimeState = {
      dispose?: () => void
    }

    // If a newer copy of this script was injected (extension reload /
    // duplicate injection), tear down the previous instance first —
    // same pattern as injected.content.ts's __agentWebBridgeState.
    const existing = (window as any).__cwWebmcpAgentState as AgentRuntimeState | undefined
    if (existing?.dispose) {
      try {
        existing.dispose()
      } catch {
        // ignore stale cleanup errors
      }
    }

    const state: AgentRuntimeState = {}
    ;(window as any).__cwWebmcpAgentState = state

    // modelContext may not exist yet at document_idle (SPA registers
    // tools after hydration, or the page loads @mcp-b/global late).
    // Re-resolve on every poll until it appears.
    let api: ResolvedAgentApi | null = resolveAgentApi()
    let unsubscribeChanges: (() => void) | null = null
    let lastFingerprint = ''
    let disposed = false

    const post = (event: Record<string, unknown>) => {
      window.postMessage(buildAgentEnvelope(event as any), window.location.origin)
    }

    // ── Snapshot fingerprinting (suppress no-op churn) ──
    function toolsFingerprint(tools: Array<{ name: string; inputSchema?: unknown }>): string {
      const parts = tools
        .map((tool) => `${tool.name}:${JSON.stringify(tool.inputSchema || null)}`)
        .sort()
        .join('|')
      let hash = 2166136261
      for (let i = 0; i < parts.length; i++) {
        hash ^= parts.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
      }
      return (hash >>> 0).toString(16)
    }

    const emit = (kind: 'ready' | 'snapshot', tools: Awaited<ReturnType<ResolvedAgentApi['getTools']>>) => {
      post({ kind, tools, apiMode: api!.mode })
      lastFingerprint = toolsFingerprint(tools)
    }

    const poll = async () => {
      if (disposed) return

      if (!api) {
        // Late-init: retry surface resolution.
        const resolved = resolveAgentApi()
        if (!resolved) return
        api = resolved
        subscribeChanges()
        try {
          emit('ready', await api.getTools())
        } catch {
          emit('ready', [])
        }
        return
      }

      try {
        const tools = await api.getTools()
        // The polyfill's getTools() projection drops `annotations`; the app
        // publishes the authoritative map on a page global (register.ts).
        // Merge it back so readOnlyHint/untrustedContentHint survive discovery.
        const annotations = (globalThis as any).__eo2weaveToolAnnotations as
          | Record<string, Record<string, boolean>>
          | undefined
        const merged = annotations
          ? tools.map((t) =>
              annotations[t.name] ? { ...t, annotations: { ...annotations[t.name] } } : t,
            )
          : tools
        if (toolsFingerprint(merged) !== lastFingerprint) {
          emit('snapshot', merged)
        }
      } catch {
        // transient getTools() failure — next poll retries; don't flush
        // the registry on a single hiccup
      }
    }

    const subscribeChanges = () => {
      if (!api || unsubscribeChanges) return
      unsubscribeChanges = api.onToolsChanged(() => void poll())
    }

    if (api) {
      subscribeChanges()
      api
        .getTools()
        .then((tools) => {
          if (!disposed) emit('ready', tools)
        })
        .catch(() => {
          if (!disposed) emit('ready', [])
        })
    } else {
      // No modelContext at boot. Report an EMPTY ready anyway: the registry
      // must know this tab HAS the static scripts (so legacy probe skips it).
      // If the page registers tools later, the poll loop below resolves the
      // surface and emits a non-empty `ready` — registry updates then.
      post({ kind: 'ready', tools: [], apiMode: undefined })
    }

    // Event-driven when possible; polling is the safety net for both
    // late modelContext installation and missing toolchange events.
    const POLL_INTERVAL_MS = 2_000
    const pollTimer = window.setInterval(() => void poll(), POLL_INTERVAL_MS)

    state.dispose = () => {
      disposed = true
      window.clearInterval(pollTimer)
      try {
        unsubscribeChanges?.()
      } catch {
        // ignore
      }
      unsubscribeChanges = null
    }

    // ── Invoke requests from the relay (background-initiated) ──
    window.addEventListener('message', (event) => {
      if (event.source !== window) return
      const data = event.data as Record<string, unknown> | null
      if (!data || data[CW_WEBMCP_AGENT_MARKER] !== true) return

      const command = parseRelayCommand(data)
      if (!command) return

      if (command.kind === 'ping') {
        void poll()
        return
      }

      if (command.kind === 'invoke-request') {
        const respond = (payload: Record<string, unknown>) =>
          post({ kind: 'invoke-response', requestId: command.requestId, ...payload })

        if (!api) {
          // One last resolution attempt right now — covers the case
          // where the page just registered tools between polls.
          const resolved = resolveAgentApi()
          if (resolved) {
            api = resolved
            subscribeChanges()
            void resolved
              .getTools()
              .then((tools) => emit('ready', tools))
              .catch(() => {})
          } else {
            respond({
              ok: false,
              errorCode: 'WEBMCP_UNAVAILABLE',
              error: 'WebMCP APIs are not available in this tab',
            })
            return
          }
        }

        void (async () => {
          try {
            const publicArgs = command.toolName === 'xhs_publish_content' ? stageXiaohongshuImage(command.args || {}) : command.args || {}
            const result = await api!.executeToolByName(command.toolName, publicArgs)
            const normalized =
              result === null ||
              result === undefined ||
              typeof result === 'string' ||
              typeof result === 'number' ||
              typeof result === 'boolean'
                ? result
                : (() => {
                    try {
                      return JSON.parse(JSON.stringify(result))
                    } catch {
                      return String(result)
                    }
                  })()
            respond({ ok: true, result: normalized, apiMode: api!.mode })
          } catch (error: any) {
            const message = typeof error?.message === 'string' ? error.message : String(error)
            // The @mcp-b/global polyfill cancels an invocation when the
            // tool's definition is replaced mid-flight. The dominant cause
            // is the page navigating DURING the tool (form submit, router.push,
            // window.location.assign) — the tool's handleClick ran and likely
            // completed its work (POST succeeded), but the page tore itself
            // down and re-registered the tool with a fresh signature before
            // the polyfill could hand the result back. Reporting this as a
            // hard failure makes the popup/side panel say "tool failed" even
            // though the operation silently succeeded on the server.
            //
            // Surface it as a soft-success with a `note` so the UI can show
            // "tool likely succeeded — page changed; verify on the destination
            // page" instead of a red error. The `result` field carries the
            // marker so callers can branch on it without parsing strings.
            if (message.includes('Tool execution cancelled, since tool definition was updated')) {
              if (command.toolName === 'xhs_publish_content') {
                respond({ ok: false, errorCode: 'PUBLISH_RESULT_UNKNOWN', error: 'Publication invocation was interrupted by a page change. Rediscover this tab and query status with the same operation_id; never automatically resubmit.', apiMode: api!.mode })
                return
              }
              respond({
                ok: true,
                result: {
                  _toolExecutionStatus: 'tool_likely_succeeded_after_navigation',
                  note: 'The tool call appears to have completed; the page navigated before the result stream came back. Verify the operation on the destination page.',
                },
                apiMode: api!.mode,
              })
              return
            }
            respond({
              ok: false,
              errorCode: message.startsWith('Tool not found in tab:') ? 'TOOL_NOT_FOUND' : 'INVOKE_FAILED',
              error: message,
              apiMode: api!.mode,
            })
          } finally {
            if (command.toolName === 'xhs_publish_content') discardXiaohongshuImage(command.args || {})
          }
        })()
      }
    })
  },
})
