import type {
  ExecuteRequest,
  ExecutionResult,
  JsonValue,
  RuntimeFailure,
} from '@/runtime/quickjs/types'

export type WorkerRequest =
  | {
      type: 'execute'
      request: ExecuteRequest
      wasm: WebAssembly.Module
      globals: Record<string, JsonValue>
      functions: string[]
    }
  | { type: 'reply'; id: number; result: ExecutionResult }

export type WorkerResponse =
  | { type: 'invoke'; id: number; name: string; args: JsonValue[] }
  | { type: 'result'; result: ExecutionResult }

export function rejected(error: RuntimeFailure): ExecutionResult {
  return { ok: false, error }
}
