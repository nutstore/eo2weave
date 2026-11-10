/** Byte-preserving MCP HTTP relay. A port owns exactly one upstream request. */
export interface MCPNetworkPort {
  postMessage(message: unknown): void
  disconnect(): void
  onDisconnect: { addListener(listener: () => void): void }
  onMessage: { addListener(listener: (message: { type?: string }) => void): void }
}
export function relayMCPNetwork(port: MCPNetworkPort, request: {
  url: string; method?: string; headers?: Record<string, string>; body?: string | null
  timeoutMs?: number
}): void {
  const abort = new AbortController()
  let ended = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const stop = () => {
    if (ended) return
    ended = true
    clearTimeout(timer)
    abort.abort()
    void reader?.cancel().catch(() => {})
  }
  const post = (message: unknown) => {
    if (ended) return
    try { port.postMessage(message) } catch { stop() }
  }
  // This deadline bounds response headers, not the lifetime of an SSE connection.
  const timer = setTimeout(() => {
    post({ type: 'error', errorCode: 'TIMEOUT', message: 'MCP response headers timed out' })
    stop()
    try { port.disconnect() } catch {}
  }, Math.max(1000, Math.min(request.timeoutMs ?? 30000, 300000)))
  port.onDisconnect.addListener(stop)
  port.onMessage.addListener(message => { if (message.type === 'cancel') stop() })
  void (async () => {
    try {
      const url = new URL(request.url)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('MCP requires HTTP(S)')
      const method = request.method ?? 'POST'
      if (!['GET', 'POST', 'DELETE'].includes(method)) throw new Error('Unsupported MCP HTTP method')
      const response = await fetch(url, {
        method, headers: request.headers, body: method === 'GET' ? undefined : request.body,
        // SECURITY: redirects are never followed. The caller's URL is the only
        // one validated (assertValidMcpEndpointUrl in the background handler),
        // so following a 3xx would let a public endpoint bounce the privileged
        // fetch into an intranet/metadata host. Same policy as
        // fetchMcpEndpointNoRedirects on the mcp_proxy_fetch_stream path.
        signal: abort.signal, redirect: 'error', credentials: 'omit',
      })
      clearTimeout(timer)
      post({ type: 'chunk', data: {
        type: 'response_start', status: response.status, statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      } })
      reader = response.body?.getReader()
      if (reader) {
        while (!ended) {
          const chunk = await reader.read()
          if (chunk.done) break
          // Avoid spreading large arrays into a function's argument list.
          for (let offset = 0; offset < chunk.value.length; offset += 32768) {
            const bytes = chunk.value.subarray(offset, offset + 32768)
            post({ type: 'chunk', data: { type: 'bytes', data: btoa(String.fromCharCode(...bytes)) } })
          }
        }
      }
      post({ type: 'done' })
    } catch (error) {
      post({ type: 'error', errorCode: 'NETWORK_ERROR', message: error instanceof Error ? error.message : String(error) })
    } finally {
      stop()
      try { port.disconnect() } catch {}
    }
  })()
}
