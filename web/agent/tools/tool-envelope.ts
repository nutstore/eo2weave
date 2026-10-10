export interface ToolEnvelopeSuccess<T = unknown> {
  ok: true
  tool: string
  version: 2
  data: T
  /**
   * Optional multimodal content parts (text + image). When present, the
   * agent loop renders the tool result as a multimodal message instead of
   * a flat text block. Used by page_screenshot to deliver images to
   * vision-capable models. Nested code calls receive data only; this field
   * never forwards context through an enclosing execution automatically.
   */
  contentParts?: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  meta?: Record<string, unknown>
}

export interface ToolEnvelopeError {
  code: string
  message: string
  retryable: boolean
  hint?: string
  details?: Record<string, unknown>
}

export interface ToolEnvelopeFailure {
  ok: false
  tool: string
  version: 2
  error: ToolEnvelopeError
  meta?: Record<string, unknown>
}

export type ToolEnvelopeV2<T = unknown> = ToolEnvelopeSuccess<T> | ToolEnvelopeFailure

type ToolOkOptions = {
  meta?: Record<string, unknown>
  contentParts?: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
}

export function toolOkJson<T>(
  tool: string,
  data: T,
  options?: ToolOkOptions | Record<string, unknown>
): string {
  // The previous API accepted metadata directly as the third argument.
  // Preserve that contract while allowing the new contentParts wrapper.
  const wrappedOptions: ToolOkOptions = options &&
    (Object.prototype.hasOwnProperty.call(options, 'meta') || Object.prototype.hasOwnProperty.call(options, 'contentParts'))
    ? options as ToolOkOptions
    : { meta: options as Record<string, unknown> | undefined }
  const payload: ToolEnvelopeSuccess<T> = {
    ok: true,
    tool,
    version: 2,
    data,
    ...(wrappedOptions.contentParts ? { contentParts: wrappedOptions.contentParts } : {}),
    ...(wrappedOptions.meta ? { meta: wrappedOptions.meta } : {}),
  }
  return JSON.stringify(payload)
}

export function toolErrorJson(
  tool: string,
  code: string,
  message: string,
  options?: {
    retryable?: boolean
    hint?: string
    details?: Record<string, unknown>
    meta?: Record<string, unknown>
  }
): string {
  const payload: ToolEnvelopeFailure = {
    ok: false,
    tool,
    version: 2,
    error: {
      code,
      message,
      retryable: options?.retryable ?? false,
      ...(options?.hint ? { hint: options.hint } : {}),
      ...(options?.details ? { details: options.details } : {}),
    },
    ...(options?.meta ? { meta: options.meta } : {}),
  }
  return JSON.stringify(payload)
}

export function isToolEnvelopeV2(value: unknown): value is ToolEnvelopeV2 {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ToolEnvelopeV2>
  if (candidate.version !== 2) return false
  if (typeof candidate.tool !== 'string') return false
  if (candidate.ok === true) return true
  if (candidate.ok === false) {
    return (
      !!candidate.error &&
      typeof candidate.error === 'object' &&
      typeof (candidate.error as { code?: unknown }).code === 'string' &&
      typeof (candidate.error as { message?: unknown }).message === 'string'
    )
  }
  return false
}
