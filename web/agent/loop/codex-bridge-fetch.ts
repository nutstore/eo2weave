/**
 * Codex Bridge Fetch — permanently wraps globalThis.fetch to route
 * Codex API requests through the browser extension bridge.
 *
 * The openai-responses handler (from @earendil-works/pi-ai) handles all SSE parsing,
 * tool call streaming, and message assembly. It calls fetch() internally.
 * For codex-oauth, fetch() can't reach chatgpt.com directly (CORS + no token),
 * so this wrapper intercepts those requests and routes them through the extension's
 * background service worker.
 *
 * Installation is idempotent — call installCodexBridgeFetch() once at app startup.
 */

import { AGENT_ABORT_PREFIX, registerAgentAbortError } from '@/lib/agent-abort'

interface AgentWebBridge {
  ready: boolean
  codexProxyFetchStream(body: Record<string, unknown>): AsyncIterable<string> & { cancel: () => void }
  codexProxyFetch(body: Record<string, unknown>): Promise<{
    ok: boolean
    status?: number
    text?: string
    errorCode?: string
    message?: string
  }>
}

function getBridge(): AgentWebBridge | null {
  const w = window as unknown as { __agentWeb?: AgentWebBridge }
  return w.__agentWeb?.ready ? w.__agentWeb : null
}

const CODEX_HOST = 'chatgpt.com'

let installed = false
let originalFetch: typeof globalThis.fetch | null = null

/**
 * Install a permanent fetch wrapper that intercepts Codex API requests.
 * Must be called once at app startup. Idempotent.
 */
export function installCodexBridgeFetch(): void {
  if (installed) return
  installed = true
  originalFetch = globalThis.fetch.bind(globalThis)

  globalThis.fetch = async function codexBridgeFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url

    // Only intercept Codex API requests when bridge is available
    if (url.includes(CODEX_HOST)) {
      const bridge = getBridge()
      if (bridge) {
        return handleCodexRequest(bridge, input, init)
      }
    }

    // All other requests: pass through to original fetch
    return originalFetch!(input, init)
  }
}

async function handleCodexRequest(
  bridge: AgentWebBridge,
  _input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const body = init?.body ? JSON.parse(init.body as string) : {}

  // Prefer streaming for real-time token delivery
  if (bridge.codexProxyFetchStream && body.stream !== false) {
    const sseIterable = bridge.codexProxyFetchStream(body)
    const encoder = new TextEncoder()
    const requestSignal = init?.signal

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const abortStream = () => sseIterable.cancel()
        if (requestSignal?.aborted) {
          abortStream()
          // Forward the loop's semantic reason when present; the bare-prefix
          // fallback is registered so the filter still recognizes it.
          controller.error(
            requestSignal.reason ??
              registerAgentAbortError(new DOMException(AGENT_ABORT_PREFIX, 'AbortError')),
          )
          return
        }
        requestSignal?.addEventListener('abort', abortStream, { once: true })

        try {
          for await (const chunk of sseIterable) {
            controller.enqueue(encoder.encode(chunk))
          }
          controller.close()
        } catch (err) {
          // Stop raced the stream: reject with the signal's semantic reason so
          // the resulting error is recognized as an expected cancellation.
          if (requestSignal?.aborted) {
            controller.error(
              requestSignal.reason ??
                registerAgentAbortError(new DOMException(AGENT_ABORT_PREFIX, 'AbortError')),
            )
          } else {
            controller.error(err)
          }
        } finally {
          requestSignal?.removeEventListener('abort', abortStream)
        }
      },
      cancel() {
        sseIterable.cancel()
      },
    })

    return new Response(stream, {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  // Fallback: non-streaming
  const resp = await bridge.codexProxyFetch(body)
  return new Response(resp.text || '', {
    status: resp.ok ? (resp.status || 200) : (resp.status || 500),
    statusText: resp.ok ? 'OK' : 'Error',
    headers: { 'Content-Type': 'application/json' },
  })
}
