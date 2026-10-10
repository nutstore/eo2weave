import { QuickJS, type Deferred } from 'quickjs-wasi'
import { preflightFailure, wrapCode } from './preflight'
import {
  failure,
  jsonText,
  type ExecuteRequest,
  type ExecutionResult,
  type RuntimeBindings,
  type RuntimeFailure,
  type JsonValue,
} from './types'

export interface QuickJsSession {
  /** JSON-only evaluations share globals, closures and resource budgets. Await every call. */
  evaluate(code: string, filename?: string): Promise<JsonValue>
  call(name: string, args?: JsonValue[]): Promise<JsonValue>
  readonly signal: AbortSignal
}

/** Own a VM for the duration of a host callback; always dispose it when the callback ends. */
export async function withQuickJsSession(
  wasm: WebAssembly.Module,
  request: Omit<ExecuteRequest, 'code'>,
  bindings: RuntimeBindings,
  signal: AbortSignal,
  use: (session: QuickJsSession) => Promise<JsonValue>,
): Promise<ExecutionResult> {
  const { limits } = request
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error('Execution limits must be positive integers')
  if (signal.aborted)
    return { ok: false, error: { code: 'JS_CANCELED', message: 'Execution canceled' } }
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
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs)
  signal.addEventListener('abort', onAbort, { once: true })
  const interruption = (): RuntimeFailure | null =>
    Date.now() >= deadline
      ? { code: 'JS_TIMEOUT', message: 'Execution timed out' }
      : controller.signal.aborted
        ? { code: 'JS_CANCELED', message: 'Execution canceled' }
        : remainingCpu <= 0
          ? { code: 'JS_CPU_LIMIT', message: 'CPU time limit exceeded' }
          : null
  let closed = false
  let calls = 0
  const pending = new Set<Deferred>()
  let vm: QuickJS | null = null
  let activeEvaluation: Promise<JsonValue> | undefined
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
      if (name.startsWith('__qjs') || (bindings.onEvent && name === 'emitEvent') || Object.hasOwn(bindings.functions, name))
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
          (error) => settle({ ok: false, error: interruption() ?? failure(error) })
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
    if (bindings.onEvent) {
      const eventBridge = runtime.newFunction('__qjsEvent', (valueHandle) => {
        try {
          if (closed || controller.signal.aborted) throw new Error('Execution canceled')
          const value = JSON.parse(runtime.dump(valueHandle) as string)
          jsonText(value, limits.maxTransferBytes)
          bindings.onEvent!(value)
          return runtime.newString('{"ok":true}')
        } catch (error) {
          return runtime.newString(jsonText({ ok: false, error: failure(error) }, limits.maxTransferBytes))
        }
      })
      runtime.setProp(runtime.global, '__qjsEvent', eventBridge)
      eventBridge.dispose()
      guest(() => runtime.evalCode(`globalThis.emitEvent = value => {
        const reply = JSON.parse(__qjsEvent(__qjsJson(value)));
        if (!reply.ok) throw Object.assign(new Error(reply.error.message), reply.error);
      };`)).dispose()
    }
    for (const name of Object.keys(bindings.functions)) {
      if (name.startsWith('__qjs') || (bindings.onEvent && name === 'emitEvent')) throw new Error(`Reserved binding: ${name}`)
      guest(() =>
        runtime.evalCode(`globalThis[${JSON.stringify(name)}] = async (...args) => {
        const reply = JSON.parse(await __qjsHost(${JSON.stringify(name)}, __qjsJson(args)));
        if (!reply.ok) throw Object.assign(new Error(reply.error.message), reply.error);
        return reply.value;
      };`)
      ).dispose()
    }
    if (request.setup) guest(() => runtime.evalCode(request.setup, 'setup.js')).dispose()
    let evaluating = false
    const runEvaluation: QuickJsSession['evaluate'] = async (code, filename = request.filename) => {
      if (closed) throw new Error('QuickJS session is closed')
      if (evaluating) throw new Error('Await the current QuickJS evaluation before starting another')
      const interrupted = interruption()
      if (interrupted) throw Object.assign(new Error(interrupted.message), interrupted)
      const invalid = preflightFailure(code)
      if (invalid && !invalid.ok) throw Object.assign(new Error(invalid.error.message), invalid.error)
      evaluating = true
      try {
        const result = guest(() =>
          runtime.evalCode(
            `${wrapCode(code)}.then(value => __qjsJson(value === undefined ? null : value))`,
            filename
          )
        )
        try {
          for (;;) {
            // The outer catch reports the specific interruption reason.
            if (interruption()) throw new Error('Execution interrupted')
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
                throw Object.assign(new Error(String(runtime.dump(message) || runtime.dump(settled.error))), {
                  code: String(runtime.dump(code) || 'JS_EXECUTION_FAILED'),
                })
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
            return JSON.parse(text)
          } finally {
            settled.value.dispose()
          }
        } finally {
          result.dispose()
        }
      } finally { evaluating = false }
    }
    const evaluate: QuickJsSession['evaluate'] = (code, filename) => {
      if (activeEvaluation) return Promise.reject(new Error('Await the current QuickJS evaluation before starting another'))
      const operation = runEvaluation(code, filename)
      activeEvaluation = operation
      // Attach both handlers immediately, including for accidentally unawaited evaluations.
      void operation.then(
        () => { if (activeEvaluation === operation) activeEvaluation = undefined },
        () => { if (activeEvaluation === operation) activeEvaluation = undefined },
      )
      return operation
    }
    const value = await use({
      evaluate,
      call: async (name, args = []) => evaluate(`return await globalThis[${JSON.stringify(name)}](...JSON.parse(${JSON.stringify(jsonText(args, limits.maxTransferBytes))}))`),
      signal: controller.signal,
    })
    const interrupted = interruption()
    if (interrupted) return { ok: false, error: interrupted }
    return { ok: true, value: JSON.parse(jsonText(value, limits.maxTransferBytes)) }
  } catch (error) {
    return { ok: false, error: interruption() ?? failure(error) }
  } finally {
    closed = true
    clearTimeout(timer)
    controller.abort()
    // Let an unawaited evaluation observe cancellation before freeing its VM.
    await activeEvaluation?.catch(() => undefined)
    signal.removeEventListener('abort', onAbort)
    for (const deferred of pending) deferred.handle.dispose()
    pending.clear()
    vm?.dispose()
  }
}

/** Execute in a fresh VM using only caller-supplied WASM and explicit bindings. */
export async function executeQuickJs(
  wasm: WebAssembly.Module,
  request: ExecuteRequest,
  bindings: RuntimeBindings,
  signal: AbortSignal,
): Promise<ExecutionResult> {
  const invalid = preflightFailure(request.code)
  if (invalid) return invalid
  return withQuickJsSession(wasm, request, bindings, signal, session => session.evaluate(request.code))
}
