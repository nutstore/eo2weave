import { Validator, dereference, type Schema } from '@cfworker/json-schema'
import { draft7MetaSchema } from './webmcp-schema-meta'

export type JsonSchema = boolean | Record<string, unknown>
const meta = new Validator(draft7MetaSchema as Schema, '7', false)

/** Interpret Draft-07 schemas without eval, including in the extension service worker. */
export function createSchemaValidator(schema: JsonSchema, label: string): Validator {
  try {
    assertSchemaValue(meta, schema, 'Invalid Draft-07 schema')
    const copy = structuredClone(schema) as Schema | boolean
    const lookup = dereference(copy)
    for (const node of Object.values(lookup)) {
      if (typeof node !== 'object') continue
      if (node.$schema && !/^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(node.$schema))
        throw new Error('Only JSON Schema Draft-07 is supported')
      if (node.__absolute_ref__ && lookup[node.__absolute_ref__] === undefined)
        throw new Error(`Unresolved schema reference: ${node.$ref}`)
      if (node.pattern) new RegExp(node.pattern, 'u')
      for (const pattern of Object.keys(node.patternProperties ?? {})) new RegExp(pattern, 'u')
    }
    return new Validator(copy, '7', false)
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function assertSchemaValue(validate: Validator, value: unknown, label: string): void {
  const result = validate.validate(value)
  if (!result.valid) throw new Error(`${label}: ${result.errors.map(error => `${error.instanceLocation || '/'} ${error.error}`).join('; ')}`)
}
