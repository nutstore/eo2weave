import type { StreamableHTTPClientTransport, JSONRPCMessage } from '@modelcontextprotocol/client'
import type {
  ConnectedMcpSessionPort,
  JsonRpcResponse,
  IncomingServerRequest,
  SessionTaskCapabilities,
} from '@modelcontextprotocol/ext-tasks/client'
import { toJsonValue, type JsonValue } from '@modelcontextprotocol/ext-tasks/core'

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Restore an existing legacy session via the public Transport surface, without initialize. */
export async function restoreLegacyTaskPort(
  transport: StreamableHTTPClientTransport,
  endpointId: string,
  taskCapabilities: SessionTaskCapabilities
) {
  const requests = new Set<
    (request: IncomingServerRequest) => Promise<JsonRpcResponse | undefined>
  >()
  const notifications = new Set<(message: ReturnType<typeof toJsonValue>) => void>()
  const invalidations = new Set<(error: unknown) => void>()
  const pending = new Map<
    string,
    { resolve(value: JsonRpcResponse): void; reject(error: unknown): void }
  >()
  const namespace = `cw-resume:${crypto.randomUUID()}:`
  let sequence = 0
  let invalidated = false
  transport.onmessage = (message: JSONRPCMessage) => {
    if ('method' in message) {
      if ('id' in message) {
        void (async () => {
          for (const handler of requests) {
            const response = await handler({ request: toJsonValue(message), requestContext: {} })
            if (response) {
              await transport.send(
                response.kind === 'result'
                  ? { jsonrpc: '2.0', id: message.id, result: { ...Object(response.result) } }
                  : { jsonrpc: '2.0', id: message.id, error: { ...response.error } }
              )
              return
            }
          }
          await transport.send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Uncorrelated input request' },
          })
        })().catch((error) => {
          for (const listener of invalidations) listener(error)
        })
      } else for (const listener of notifications) listener(toJsonValue(message))
    } else {
      const request = pending.get(String(message.id))
      if (!request) return
      pending.delete(String(message.id))
      request.resolve(
        'error' in message
          ? {
              kind: 'error',
              error: {
                ...message.error,
                data:
                  message.error.data === undefined ? undefined : toJsonValue(message.error.data),
              },
            }
          : { kind: 'result', result: toJsonValue(message.result) }
      )
    }
  }
  const invalidate = (error: unknown) => {
    invalidated = true
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
    for (const listener of invalidations) listener(error)
  }
  transport.onerror = (error) => invalidate(error)
  transport.onclose = () => invalidate(new Error('Legacy MCP session disconnected'))
  await transport.start()
  const port: ConnectedMcpSessionPort = {
    endpointId,
    taskCapabilities,
    get invalidated() {
      return invalidated
    },
    async dispatch(request, options) {
      if (!isRecord(request) || typeof request.method !== 'string')
        throw new Error('Invalid MCP request')
      const id = `${namespace}${++sequence}`
      let timer: ReturnType<typeof setTimeout> | undefined
      const controller = new AbortController()
      const abort = () => {
        const reason = options?.signal?.reason ?? new Error('MCP request aborted')
        controller.abort(reason)
        pending.get(id)?.reject(reason)
      }
      try {
        return await new Promise<JsonRpcResponse>((resolve, reject) => {
          pending.set(id, { resolve, reject })
          timer = setTimeout(() => {
            const error = new DOMException('MCP request timed out', 'TimeoutError')
            controller.abort(error)
            reject(error)
          }, options?.context?.requestTimeoutMs ?? 30000)
          options?.signal?.addEventListener('abort', abort, { once: true })
          if (options?.signal?.aborted) {
            abort()
            return
          }
          void transport
            .send(
              {
                jsonrpc: '2.0',
                id,
                method: request.method as string,
                ...(request.params === undefined ? {} : { params: Object(request.params) }),
              },
              { headers: options?.context?.headers, requestSignal: controller.signal }
            )
            .catch(reject)
        })
      } finally {
        clearTimeout(timer)
        controller.abort()
        pending.delete(id)
        options?.signal?.removeEventListener('abort', abort)
      }
    },
    onServerRequest(handler) {
      requests.add(handler)
      return () => {
        requests.delete(handler)
      }
    },
    onNotification(handler) {
      notifications.add(handler)
      return () => {
        notifications.delete(handler)
      }
    },
    onInvalidated(handler) {
      invalidations.add(handler)
      return () => {
        invalidations.delete(handler)
      }
    },
  }
  return port
}
