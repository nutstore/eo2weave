export class BrowserError extends Error {
  constructor(message: string, readonly details?: unknown) { super(message); this.name = 'BrowserError' }
}
export function serializeError(error: unknown) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof BrowserError && error.details !== undefined ? { details: error.details } : {}),
  }
}
