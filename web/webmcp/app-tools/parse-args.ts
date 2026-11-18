/**
 * parse-args.ts — the app-tools execution boundary.
 *
 * External callers (the in-app agent, the extension relay) hand us untyped
 * JSON. Arguments are normalized and checked here against the SAME
 * `APP_TOOLS` schemas the tools register with, so a handler never sees a
 * historically-coerced value (`wait: "false"`, `limit: "20"`).
 *
 * Only the declared shape is enforced: object-ness, required fields, and the
 * declared primitive type of supplied fields. Extra fields stay allowed — the
 * schemas do not forbid them, and handlers ignore what they do not read.
 */

import type { AppToolDefinition } from './schemas'

export type ToolArgs = Record<string, unknown>

type DeclaredType = 'string' | 'number' | 'boolean'

type ToolHandler = (args: ToolArgs) => Promise<{ content: string }>

export type ParsedToolArgs = { ok: true; value: ToolArgs } | { ok: false; error: string }

function declaredType(schema: unknown): DeclaredType | null {
  if (!schema || typeof schema !== 'object') return null
  const type = (schema as { type?: unknown }).type
  return type === 'string' || type === 'number' || type === 'boolean' ? type : null
}

function matchesType(value: unknown, expected: DeclaredType): boolean {
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === expected
}

export function parseToolArgs(def: AppToolDefinition, raw: unknown): ParsedToolArgs {
  // Omitted / explicit null arguments mean "no options"; tools that declare
  // required fields then fail the required-field check below.
  const input = raw ?? {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: `${def.name}: arguments must be an object` }
  }

  const args = input as ToolArgs

  for (const field of def.inputSchema.required ?? []) {
    if (args[field] == null) {
      return { ok: false, error: `${def.name}: missing required field "${field}"` }
    }
  }

  for (const [field, schema] of Object.entries(def.inputSchema.properties)) {
    const value = args[field]
    if (value == null) continue
    const expected = declaredType(schema)
    if (expected && !matchesType(value, expected)) {
      return { ok: false, error: `${def.name}: field "${field}" must be a ${expected}` }
    }
  }

  return { ok: true, value: args }
}

/**
 * Run one registered tool: validate at the boundary, then invoke the handler.
 * Returns the tool's JSON content — boundary and handler errors keep the
 * existing `{ "error": "..." }` shape.
 */
export async function runAppTool(
  def: AppToolDefinition,
  handler: ToolHandler,
  raw: unknown,
): Promise<string> {
  const parsed = parseToolArgs(def, raw)
  if (!parsed.ok) return JSON.stringify({ error: parsed.error })
  try {
    const out = await handler(parsed.value)
    return out.content
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
  }
}
