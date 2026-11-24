// ============================================================
// WebMCP argument-format heuristic — single source of truth for
// "does THIS tool call take serialized JSON or an object?".
//
// Consumers:
//   1. agent-core.ts imports this module directly.
//   2. page-api.ts's runWebMCPPageProbe must stay DEPENDENCY-FREE
//      (chrome.scripting.executeScript serializes `func` without
//      module imports), so it keeps an inlined copy of the same
//      predicate — keep the two semantically in sync.
//   3. web/tests/e2e/webmcp/real-workflows.spec.ts inlines the
//      predicate inside page.evaluate for the same reason.
// web/webmcp/__tests__/page-api.test.ts pins the parity of both
// entry points; update all copies together.
//
// Contract matrix (evidence: PR #80 audit, commits 852cf921 and
// upstream/pr38 5bf782b7):
//   - polyfill (@w3c/webmcp-polyfill, installWebMCP()): object input, object
//     schemas, sets NO marker.
//   - legacy v4 polyfill: serialized JSON input, string schemas,
//     sets __isWebMCPPolyfill === true on install.
//   - legacy native Chromium: serialized JSON input, string
//     schemas ("Legacy Chromium exposes serialized schemas and
//     expects JSON input" — 5bf782b7), sets no marker.
//   - current native Chromium: object input, object schemas.
// A string inputSchema therefore implies a serialized-input
// boundary, and the v4 marker implies the same; either signal is
// sufficient (OR merge), so an unmarked legacy native context is
// no longer misrouted after PR #80 dropped the schema check.
// ============================================================

/** Marker set by the legacy v4 polyfill on install (not on native adoption). */
export const WEBMCP_POLYFILL_MARKER = '__isWebMCPPolyfill'

/**
 * Decide the argument boundary for one tool call. `inputSchema` is the
 * RAW schema as returned by `getTools()` (before normalizeSchema/normalizeAgentTools
 * parses it) — a string there means the context hands out serialized schemas
 * and expects serialized input. `polyfillMarker` is the context's marker value.
 */
export function shouldSerializeToolArgs(inputSchema: unknown, polyfillMarker: unknown): boolean {
  return polyfillMarker === true || typeof inputSchema === 'string'
}

/**
 * Errors thrown when an executeTool implementation receives the wrong input
 * format: v6 polyfill rejects non-objects with a TypeError, legacy v4 and
 * legacy native Chromium reject non-strings with a parse DOMException/error.
 */
const FORMAT_REJECTION_PATTERN = /inputObject must be an object|Failed to parse input arguments/i

export function isArgumentFormatRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return FORMAT_REJECTION_PATTERN.test(message)
}
