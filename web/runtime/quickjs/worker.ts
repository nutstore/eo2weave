/// <reference lib="webworker" />
import { executeQuickJs, failure, type ExecutionResult, type JsonValue } from '@creatorweave/quickjs-runtime'
import type { WorkerRequest, WorkerResponse } from '@/runtime/quickjs/protocol'

declare const self: DedicatedWorkerGlobalScope
let started = false
let nextId = 0
const pending = new Map<number, (result: ExecutionResult) => void>()
const send = (message: WorkerResponse) => self.postMessage(message)

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data
  if (message.type === 'reply') {
    pending.get(message.id)?.(message.result)
    pending.delete(message.id)
    return
  }
  if (started) return
  started = true
  try {
    const functions = Object.fromEntries(
      message.functions.map((name) => [
        name,
        (args: JsonValue[]) =>
          new Promise<JsonValue>((resolve, reject) => {
            const id = ++nextId
            pending.set(id, (result) =>
              result.ok
                ? resolve(result.value)
                : reject(Object.assign(new Error(result.error.message), result.error))
            )
            send({ type: 'invoke', id, name, args })
          }),
      ])
    )
    const result = await executeQuickJs(
      message.wasm,
      message.request,
      {
        globals: message.globals, functions,
        ...(message.events ? { onEvent: (value: JsonValue) => send({ type: 'event', value }) } : {}),
      },
      new AbortController().signal
    )
    send({ type: 'result', result })
  } catch (error) {
    send({ type: 'result', result: { ok: false, error: failure(error) } })
  } finally {
    pending.clear()
  }
}
