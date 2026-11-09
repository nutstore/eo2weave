import type { RawClientDispatch, JsonRpcResponse } from '@modelcontextprotocol/ext-tasks/client'
import type { JsonValue } from '@modelcontextprotocol/ext-tasks/core'

function record(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Owns an independent string-ID namespace; never touches SDK protocol internals. */
export function createRawDispatch(
  url: string,
  fetcher: typeof fetch,
  headers: () => Record<string, string>
): RawClientDispatch {
  const namespace = `cw-tasks:${crypto.randomUUID()}:`
  let sequence = 0
  return async (request, options) => {
    if (!record(request) || typeof request.method !== 'string')
      throw new Error('Invalid raw MCP request')
    const id = `${namespace}${++sequence}`
    const params = record(request.params) ? request.params : {}
    const name =
      typeof params.taskId === 'string'
        ? params.taskId
        : typeof params.name === 'string'
          ? params.name
          : undefined
    const controller = new AbortController()
    const abort = () => controller.abort(options?.signal?.reason)
    options?.signal?.addEventListener('abort', abort, { once: true })
    if (options?.signal?.aborted) abort()
    const timer = setTimeout(
      () => controller.abort(new DOMException('MCP request timed out', 'TimeoutError')),
      options?.context?.requestTimeoutMs ?? 30000
    )
    const decode = (message: unknown): JsonRpcResponse | undefined => {
      if (!record(message) || message.jsonrpc !== '2.0') throw new Error('Invalid raw MCP response')
      if (message.id !== id) {
        if ('result' in message || 'error' in message)
          throw new Error('Raw MCP response ID mismatch')
        return undefined
      }
      if (
        record(message.error) &&
        typeof message.error.code === 'number' &&
        typeof message.error.message === 'string'
      ) {
        return {
          kind: 'error',
          error: {
            code: message.error.code,
            message: message.error.message,
            ...(message.error.data === undefined ? {} : { data: message.error.data }),
          },
        }
      }
      if ('result' in message) return { kind: 'result', result: message.result }
      throw new Error('Raw MCP response has no result or error')
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await fetcher(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          ...headers(),
          ...options?.context?.headers,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Method': request.method,
          ...(name === undefined ? {} : { 'Mcp-Name': name }),
        },
        body: JSON.stringify({ ...request, jsonrpc: '2.0', id }),
      })
      if (!response.ok)
        throw Object.assign(new Error(`MCP HTTP ${response.status}`), { status: response.status })
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        const result = decode(await response.json())
        if (!result) throw new Error('Missing raw MCP response')
        return result
      }
      reader = response.body?.getReader()
      if (!reader) throw new Error('Missing raw MCP SSE response')
      const decoder = new TextDecoder()
      let buffer = ''
      let data: string[] = []
      while (!controller.signal.aborted) {
        const chunk = await reader.read()
        buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
        // Treat CRLF as one delimiter, including when split across byte chunks.
        let end: number
        while ((end = buffer.search(/[\r\n]/)) >= 0) {
          if (buffer[end] === '\r' && end === buffer.length - 1 && !chunk.done) break
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + (buffer.slice(end, end + 2) === '\r\n' ? 2 : 1))
          if (!line) {
            if (data.length) {
              const result = decode(JSON.parse(data.join('\n')))
              data = []
              if (result) return result
            }
          } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        }
        if (chunk.done) throw new Error('MCP SSE ended without a matching response')
      }
      throw controller.signal.reason ?? new Error('MCP request aborted')
    } finally {
      clearTimeout(timer)
      options?.signal?.removeEventListener('abort', abort)
      await reader?.cancel().catch(() => {})
      controller.abort()
    }
  }
}
