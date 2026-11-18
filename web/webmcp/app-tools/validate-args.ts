/**
 * App-tool argument validation — the boundary between untrusted tool-call
 * arguments and the handlers in `handlers.ts`.
 *
 * Ground rules (see issue #247):
 * - The rules come from the SAME `inputSchema` fragments the tools register
 *   with: required fields and declared primitive field types. There is no
 *   second copy of the contract and no JSON-Schema library.
 * - Omitted / null top-level arguments normalize to `{}` and then go through
 *   required-field validation, so tools without required fields still work.
 * - Arrays and non-object primitives are rejected explicitly — an array would
 *   otherwise be index-coerced into an object with no declared fields.
 * - Supplied optional fields must match their declared primitive type:
 *   `wait: "false"` and `limit: "20"` are rejected rather than coerced.
 * - Additional fields stay allowed (the schemas do not set
 *   `additionalProperties: false`).
 * - Handler-level business validation (trimming, defaults, caps, path checks)
 *   is untouched — this boundary only guards shape.
 *
 * Pure module: no store/service imports, so it is unit-testable on its own.
 */

import type { AppToolDefinition } from './schemas'

/** JSON-schema primitive types this boundary enforces. */
type DeclaredPrimitiveType = 'string' | 'number' | 'boolean'

export type ParseToolArgumentsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `typeof` a value the way the schemas mean it (undefined for omitted). */
function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function matchesDeclaredType(
  value: unknown,
  declared: DeclaredPrimitiveType
): boolean {
  if (declared === 'number') {
    // NaN/Infinity are not JSON numbers a schema can express; reject them so a
    // "number" field can never silently become NaN in a handler default.
    return typeof value === 'number' && Number.isFinite(value)
  }
  return typeof value === declared
}

function declaredTypeOf(propertySchema: unknown): DeclaredPrimitiveType | null {
  if (!isPlainObject(propertySchema)) return null
  const type = propertySchema.type
  if (type === 'string' || type === 'number' || type === 'boolean') return type
  return null
}

/**
 * Validate raw tool-call arguments against a tool definition.
 *
 * Returns the normalized argument object on success, or a message naming the
 * tool, the offending field (when there is one) and the reason.
 */
export function parseToolArguments(
  def: AppToolDefinition,
  raw: unknown
): ParseToolArgumentsResult {
  // Omitted / null top-level arguments normalize to {} and then go through the
  // same required-field validation as every other argument object.
  const normalized: unknown = raw === undefined || raw === null ? {} : raw
  if (!isPlainObject(normalized)) {
    return {
      ok: false,
      error: `Tool ${def.name}: arguments must be a JSON object, got ${describeValue(normalized)}`,
    }
  }

  const properties = def.inputSchema.properties
  for (const field of def.inputSchema.required ?? []) {
    const value = normalized[field]
    if (value === undefined || value === null) {
      return { ok: false, error: `Tool ${def.name}: missing required field "${field}"` }
    }
  }

  for (const [field, propertySchema] of Object.entries(properties)) {
    const value = normalized[field]
    // Omitted fields (undefined) and explicit nulls are treated as "not
    // supplied" — handlers apply their own `??` defaults. A supplied value must
    // match the declared type.
    if (value === undefined || value === null) continue
    const declared = declaredTypeOf(propertySchema)
    if (!declared) continue
    if (!matchesDeclaredType(value, declared)) {
      return {
        ok: false,
        error:
          `Tool ${def.name}: field "${field}" must be a ${declared}, ` +
          `got ${describeValue(value)}`,
      }
    }
  }

  return { ok: true, args: normalized }
}
