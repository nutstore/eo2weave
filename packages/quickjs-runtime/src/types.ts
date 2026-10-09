export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface ExecutionLimits {
  timeoutMs: number
  cpuTimeMs: number
  memoryBytes: number
  maxHostCalls: number
  maxConcurrentCalls: number
  maxTransferBytes: number
}

export const DEFAULT_LIMITS: ExecutionLimits = {
  timeoutMs: 600_000,
  cpuTimeMs: 10_000,
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
  /** Copied into a fresh VM for each execution; native host objects are rejected. */
  globals: Record<string, JsonValue>
  /** JSON-only asynchronous calls; the signal is aborted when execution ends. */
  functions: Record<string, (args: JsonValue[], signal: AbortSignal) => Promise<JsonValue>>
}

export interface RuntimeFailure {
  code: string
  message: string
  /** Caller-owned, lossless JSON error metadata. */
  [key: string]: JsonValue
}

export type ExecutionResult = { ok: true; value: JsonValue } | { ok: false; error: RuntimeFailure }

export function failure(error: unknown): RuntimeFailure {
  const metadata: Record<string, JsonValue> = Object.create(null)
  if (error && typeof error === 'object') {
    for (const [key, value] of Object.entries(error)) {
      if (key === 'code' || key === 'message') continue
      try {
        metadata[key] = JSON.parse(jsonText(value, Infinity))
      } catch {
        // Preserve JSON metadata without allowing native objects to cross the boundary.
      }
    }
  }
  return {
    ...metadata,
    code:
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'JS_EXECUTION_FAILED',
    message: error instanceof Error ? error.message : String(error),
  }
}

/** Reject lossy values instead of silently altering a host-call contract. */
export function jsonText(value: unknown, maxBytes: number): string {
  const text = JSON.stringify(value, function (key, item) {
    const original = this[key]
    if (
      original !== null &&
      typeof original === 'object' &&
      !Array.isArray(original) &&
      Object.getPrototypeOf(original) !== Object.prototype &&
      Object.getPrototypeOf(original) !== null
    ) {
      throw new Error('Expected plain JSON objects and arrays')
    }
    if (
      item === undefined ||
      typeof item === 'function' ||
      typeof item === 'symbol' ||
      typeof item === 'bigint' ||
      (typeof item === 'number' && !Number.isFinite(item))
    )
      throw new Error('Expected lossless JSON data')
    return item
  })
  if (typeof text !== 'string') throw new Error('Expected JSON data')
  if (new TextEncoder().encode(text).byteLength > maxBytes)
    throw new Error('JSON transfer limit exceeded')
  return text
}
