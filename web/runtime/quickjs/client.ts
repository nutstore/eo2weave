import {
  preflightFailure,
  failure,
  jsonText,
  type ExecuteRequest,
  type ExecutionResult,
  type RuntimeBindings,
} from '@creatorweave/quickjs-runtime'
import type { WorkerRequest, WorkerResponse } from '@/runtime/quickjs/protocol'

let modulePromise: Promise<WebAssembly.Module> | null = null
function loadModule(): Promise<WebAssembly.Module> {
  modulePromise ??= fetch('/assets/quickjs/quickjs.wasm')
    .then(async (response) => {
      if (!response.ok) throw new Error(`QJS WASM fetch failed: ${response.status}`)
      return WebAssembly.compile(await response.arrayBuffer())
    })
    .catch((error) => {
      modulePromise = null
      throw error
    })
  return modulePromise
}

/** One Worker per execution; terminating it cannot interrupt another caller. */
export async function executeCode(
  request: ExecuteRequest,
  bindings: RuntimeBindings,
  signal: AbortSignal
): Promise<ExecutionResult> {
  const invalid = preflightFailure(request.code)
  if (invalid) return invalid
  if (signal.aborted)
    return { ok: false, error: { code: 'JS_CANCELED', message: 'Execution canceled' } }
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  const controller = new AbortController()
  return new Promise((resolve) => {
    let closed = false
    const finish = (result: ExecutionResult) => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      controller.abort()
      worker.terminate()
      resolve(result)
    }
    const abort = () =>
      finish({
        ok: false,
        error: {
          code: 'JS_CANCELED',
          message: 'Execution canceled; in-flight host operations may have side effects',
        },
      })
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: {
            code: 'JS_TIMEOUT',
            message: 'Execution timed out; in-flight host operations may have side effects',
          },
        }),
      request.limits.timeoutMs + 5000
    )
    signal.addEventListener('abort', abort, { once: true })
    worker.onerror = (event) =>
      finish({ ok: false, error: { code: 'JS_WORKER_FAILED', message: event.message } })
    worker.onmessage = async (event: MessageEvent<WorkerResponse>) => {
      if (closed) return
      const message = event.data
      if (message.type === 'result') {
        finish(message.result)
        return
      }
      let result: ExecutionResult
      try {
        if (!Object.hasOwn(bindings.functions, message.name))
          throw new Error(`Unknown host function: ${message.name}`)
        const value = await bindings.functions[message.name]!(message.args, controller.signal)
        result = { ok: true, value: JSON.parse(jsonText(value, request.limits.maxTransferBytes)) }
      } catch (error) {
        result = { ok: false, error: failure(error) }
      }
      if (!closed)
        worker.postMessage({ type: 'reply', id: message.id, result } satisfies WorkerRequest)
    }
    try {
      jsonText(bindings.globals, request.limits.maxTransferBytes)
      void loadModule()
        .then((wasm) => {
          if (!closed)
            worker.postMessage({
              type: 'execute',
              request,
              wasm,
              globals: bindings.globals,
              functions: Object.keys(bindings.functions),
            } satisfies WorkerRequest)
        })
        .catch((error) => finish({ ok: false, error: failure(error) }))
    } catch (error) {
      finish({ ok: false, error: failure(error) })
    }
  })
}
