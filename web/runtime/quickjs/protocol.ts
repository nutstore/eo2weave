import type {
  ExecuteRequest,
  ExecutionResult,
  JsonValue,
} from '@creatorweave/quickjs-runtime'

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
