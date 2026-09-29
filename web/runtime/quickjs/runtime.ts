import { QuickJS, type Deferred } from 'quickjs-wasi'
import { preflight, wrapCode } from '@/runtime/quickjs/preflight'
import {
  failure,
  jsonText,
  type ExecuteRequest,
  type ExecutionResult,
  type RuntimeBindings,
} from '@/runtime/quickjs/types'

/** No agent, storage, or browser capabilities are installed implicitly. */
export async function executeQuickJs(
  wasm: WebAssembly.Module,
  request: ExecuteRequest,
  bindings: RuntimeBindings,
  signal: AbortSignal
): Promise<ExecutionResult> {
  const diagnostics = preflight(request.code)
  if (diagnostics.length)
    return {
      ok: false,
      error: {
        code: 'JS_PREFLIGHT_FAILED',
        message: diagnostics
          .map((d) => `${d.message} at ${d.line}:${d.column}\n${d.frame}`)
          .join('\n'),
      },
    }
  const { limits } = request
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error('Execution limits must be positive integers')
  signal.throwIfAborted()
  const deadline = Date.now() + limits.timeoutMs
  let remainingCpu = limits.cpuTimeMs
  let cpuDeadline = Infinity
  const guest = <T>(execute: () => T): T => {
    const start = Date.now()
    cpuDeadline = start + remainingCpu
    try {
      return execute()
    } finally {
      remainingCpu -= Date.now() - start
    }
  }
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  let closed = false
  let calls = 0
  const pending = new Set<Deferred>()
  let vm: QuickJS | null = null
  try {
    vm = await QuickJS.create({
      wasm,
      memoryLimit: limits.memoryBytes,
      interruptHandler: () =>
        controller.signal.aborted || Date.now() >= deadline || Date.now() >= cpuDeadline,
    })
    const runtime = vm
    const set = (name: string, value: unknown) => {
      const handle = runtime.hostToHandle(value)
      try {
        runtime.setProp(runtime.global, name, handle)
      } finally {
        handle.dispose()
      }
    }
    for (const [name, value] of Object.entries(bindings.globals)) {
      if (name.startsWith('__qjs') || Object.hasOwn(bindings.functions, name))
        throw new Error(`Binding name collision: ${name}`)
      set(name, JSON.parse(jsonText(value, limits.maxTransferBytes)))
    }
    const bridge = runtime.newFunction('__qjsHost', (nameHandle, argsHandle) => {
      const deferred = runtime.newPromise()
      pending.add(deferred)
      const name = runtime.dump(nameHandle) as string
      const args = runtime.dump(argsHandle) as string
      const settle = (result: ExecutionResult) => {
        if (closed) return
        const handle = runtime.newString(jsonText(result, limits.maxTransferBytes))
        try {
          deferred.resolve(handle)
        } finally {
          handle.dispose()
          pending.delete(deferred)
          deferred.handle.dispose()
        }
      }
      void (async () => {
        if (closed || controller.signal.aborted) throw new Error('Execution canceled')
        if (++calls > limits.maxHostCalls || pending.size > limits.maxConcurrentCalls)
          throw new Error('Host call limit exceeded')
        if (!Object.hasOwn(bindings.functions, name))
          throw new Error(`Unknown host function: ${name}`)
        jsonText(args, limits.maxTransferBytes)
        const value = await bindings.functions[name]!(JSON.parse(args), controller.signal)
        return JSON.parse(jsonText(value, limits.maxTransferBytes))
      })()
        .then(
          (value) => settle({ ok: true, value }),
          (error) =>
            settle({
              ok: false,
              error:
                remainingCpu <= 0
                  ? { code: 'JS_CPU_LIMIT', message: 'CPU time limit exceeded' }
                  : failure(error),
            })
        )
        .catch(() => {
          // Oversized replies must settle, too; never leave a guest Promise hanging.
          settle({
            ok: false,
            error: { code: 'JS_TRANSFER_LIMIT', message: 'Host result exceeds transfer limit' },
          })
        })
      return deferred.handle
    })
    runtime.setProp(runtime.global, '__qjsHost', bridge)
    bridge.dispose()
    // All crossings use JSON strings so functions, cycles and non-finite numbers
    // fail inside the guest instead of being silently changed by vm.dump().
    guest(() =>
      runtime.evalCode(`
      globalThis.__qjsJson = value => JSON.stringify(value, function (key, item) {
        const original = this[key];
        if (original !== null && typeof original === 'object' && !Array.isArray(original) && Object.getPrototypeOf(original) !== Object.prototype && Object.getPrototypeOf(original) !== null) throw new TypeError('Expected plain JSON objects and arrays');
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' || (typeof item === 'number' && !Number.isFinite(item))) throw new TypeError('Expected lossless JSON data');
        return item;
      });
    `)
    ).dispose()
    for (const name of Object.keys(bindings.functions)) {
      if (name.startsWith('__qjs')) throw new Error(`Reserved binding: ${name}`)
      guest(() =>
        runtime.evalCode(`globalThis[${JSON.stringify(name)}] = async (...args) => {
        const reply = JSON.parse(await __qjsHost(${JSON.stringify(name)}, __qjsJson(args)));
        if (!reply.ok) throw Object.assign(new Error(reply.error.message), reply.error);
        return reply.value;
      };`)
      ).dispose()
    }
    if (request.setup) guest(() => runtime.evalCode(request.setup, 'setup.js')).dispose()
    const result = guest(() =>
      runtime.evalCode(
        `${wrapCode(request.code)}.then(value => __qjsJson(value === undefined ? null : value))`,
        request.filename
      )
    )
    try {
      while (true) {
        if (controller.signal.aborted)
          throw Object.assign(new Error('Execution canceled'), { code: 'JS_CANCELED' })
        if (Date.now() >= deadline)
          throw Object.assign(new Error('Execution timed out'), { code: 'JS_TIMEOUT' })
        if (remainingCpu <= 0)
          throw Object.assign(new Error('CPU time limit exceeded'), { code: 'JS_CPU_LIMIT' })
        guest(() => runtime.executePendingJobs())
        if (result.promiseState !== 0) break
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      const settled = await runtime.resolvePromise(result)
      if ('error' in settled) {
        try {
          const message = settled.error.getProp('message')
          const code = settled.error.getProp('code')
          try {
            return {
              ok: false,
              error: {
                code: String(runtime.dump(code) || 'JS_EXECUTION_FAILED'),
                message: String(runtime.dump(message) || runtime.dump(settled.error)),
              },
            }
          } finally {
            message.dispose()
            code.dispose()
          }
        } finally {
          settled.error.dispose()
        }
      }
      try {
        const text = runtime.dump(settled.value) as string
        if (new TextEncoder().encode(text).byteLength > limits.maxTransferBytes)
          throw new Error('Return value exceeds transfer limit')
        return { ok: true, value: JSON.parse(text) }
      } finally {
        settled.value.dispose()
      }
    } finally {
      result.dispose()
    }
  } catch (error) {
    return {
      ok: false,
      error: controller.signal.aborted
        ? { code: 'JS_CANCELED', message: 'Execution canceled' }
        : Date.now() >= deadline
          ? { code: 'JS_TIMEOUT', message: 'Execution timed out' }
          : remainingCpu <= 0
            ? { code: 'JS_CPU_LIMIT', message: 'CPU time limit exceeded' }
            : failure(error),
    }
  } finally {
    closed = true
    controller.abort()
    signal.removeEventListener('abort', onAbort)
    for (const deferred of pending) deferred.handle.dispose()
    pending.clear()
    vm?.dispose()
  }
}
