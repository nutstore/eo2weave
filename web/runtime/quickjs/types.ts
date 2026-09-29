export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface ExecutionLimits {
  timeoutMs: number
  memoryBytes: number
  maxHostCalls: number
  maxConcurrentCalls: number
  maxTransferBytes: number
}

export const DEFAULT_LIMITS: ExecutionLimits = {
  timeoutMs: 120_000,
  memoryBytes: 64 * 1024 * 1024,
  maxHostCalls: 200,
  maxConcurrentCalls: 16,
  maxTransferBytes: 8 * 1024 * 1024,
}

export interface ExecuteRequest {
  code: string
  filename: string
  /** Caller-owned initialization, executed before the async function body. */
  setup: string
  limits: ExecutionLimits
}

export interface RuntimeBindings {
  globals: Record<string, JsonValue>
  functions: Record<string, (args: JsonValue[], signal: AbortSignal) => Promise<JsonValue>>
}

export interface RuntimeFailure {
  code: string
  message: string
}

export type ExecutionResult =
  | { ok: true; value: JsonValue }
  | { ok: false; error: RuntimeFailure }

export function failure(error: unknown): RuntimeFailure {
  return {
    code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'JS_EXECUTION_FAILED',
    message: error instanceof Error ? error.message : String(error),
  }
}

/** Reject lossy values instead of silently altering a host-call contract. */
export function jsonText(value: unknown, maxBytes: number): string {
  const text = JSON.stringify(value, (_key, item) => {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' ||
      (typeof item === 'number' && !Number.isFinite(item))) throw new Error('Expected lossless JSON data')
    return item
  })
  if (typeof text !== 'string') throw new Error('Expected JSON data')
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error('JSON transfer limit exceeded')
  return text
}
