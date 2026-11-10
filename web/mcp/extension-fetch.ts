/** Fetch contract consumed by the SDK; HTTP errors remain HTTP responses. */
type NetworkFrame =
  | {
      type: 'response_start'
      status: number
      statusText?: string
      headers?: Record<string, string>
    }
  | { type: 'bytes'; data: string }
type NetworkStream = AsyncIterable<NetworkFrame> & { cancel(): void }
export interface MCPNetworkBridge {
  ready: boolean
  mcpNetworkCapabilities?: { version: number }
  mcpNetworkFetch?: (request: Record<string, unknown>) => NetworkStream
  mcpProxyFetch?: (request: Record<string, unknown>) => Promise<{
    status?: number
    statusText?: string
    headers?: Record<string, string>
    text?: string
    error?: string
  }>
}
export function getMCPNetworkBridge(): MCPNetworkBridge | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as unknown as { __agentWeb?: MCPNetworkBridge }).__agentWeb
}
export function hasMCPNetworkV2(): boolean {
  const bridge = getMCPNetworkBridge()
  return (
    bridge?.ready === true &&
    bridge.mcpNetworkCapabilities?.version === 2 &&
    !!bridge.mcpNetworkFetch
  )
}

export function createExtensionFetch(
  timeoutMs = 30000,
  getBridge = getMCPNetworkBridge
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    request.signal.throwIfAborted()
    const bridge = getBridge()
    if (!bridge?.ready) throw new Error('Browser extension MCP bridge unavailable')
    const payload = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: request.method === 'GET' || request.method === 'HEAD' ? null : await request.text(),
      timeoutMs,
      // No `redirect` field: the relay never follows redirects (the extension
      // validates only this URL, so a 3xx would escape the endpoint policy).
    }
    request.signal.throwIfAborted()
    if (bridge.mcpNetworkCapabilities?.version !== 2 || !bridge.mcpNetworkFetch) {
      if (!bridge.mcpProxyFetch || request.method === 'GET') {
        throw new Error(
          'Upgrade the browser extension for MCP streaming, background Tasks and cancellation'
        )
      }
      const response = await bridge.mcpProxyFetch(payload)
      request.signal.throwIfAborted()
      if (!response.status) throw new Error(response.error || 'MCP network request failed')
      return new Response(
        [204, 205, 304].includes(response.status) ? null : (response.text ?? ''),
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }
      )
    }
    const source = bridge.mcpNetworkFetch(payload)
    const iterator = source[Symbol.asyncIterator]()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let stopped = false
    let rejectStart: (reason: unknown) => void = () => {}
    const cleanup = () => {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', abort)
    }
    const stop = (reason: unknown) => {
      if (stopped) return
      stopped = true
      cleanup()
      source.cancel()
      rejectStart(reason)
      controller?.error(reason)
    }
    const abort = () => stop(request.signal.reason)
    const timer = setTimeout(
      () => stop(new DOMException('MCP response headers timed out', 'TimeoutError')),
      timeoutMs
    )
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) abort()
    try {
      const first = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          rejectStart = reject
        }),
      ])
      if (first.done || first.value.type !== 'response_start')
        throw new Error('MCP bridge omitted response headers')
      clearTimeout(timer)
      const frame = first.value
      if ([204, 205, 304].includes(frame.status)) {
        stopped = true
        cleanup()
        source.cancel()
        return new Response(null, frame)
      }
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value
        },
        async pull(value) {
          try {
            const next = await iterator.next()
            if (stopped) return
            if (next.done) {
              stopped = true
              cleanup()
              value.close()
            } else if (next.value.type === 'bytes') {
              value.enqueue(Uint8Array.from(atob(next.value.data), (byte) => byte.charCodeAt(0)))
            } else throw new Error('Unexpected MCP network frame')
          } catch (error) {
            stop(error)
          }
        },
        cancel() {
          stopped = true
          cleanup()
          source.cancel()
        },
      })
      if (request.signal.aborted) stop(request.signal.reason)
      return new Response(body, frame)
    } catch (error) {
      stop(error)
      throw error
    }
  }
}
