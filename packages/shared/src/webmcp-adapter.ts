import { parse } from '@babel/parser'

export { WEBMCP_ADAPTERS_STORAGE_KEY } from './webmcp-adapter-storage'
export interface WebMCPAdapter {
  origin: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  source: string
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate without executing adapter code. Also used at the extension boundary. */
export function validateAdapter(metadata: unknown, source: string): WebMCPAdapter {
  if (!record(metadata)) throw new Error('tool.json must contain an object')
  if (Object.keys(metadata).some(key => !['origin', 'name', 'description', 'inputSchema'].includes(key)))
    throw new Error('tool.json accepts only origin, name, description, inputSchema')
  const { origin, name, description, inputSchema } = metadata
  if (typeof origin !== 'string') throw new Error('origin is required')
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
    throw new Error('origin must be an exact HTTP(S) origin, without a path or trailing slash')
  if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name))
    throw new Error('name must start with a letter and contain at most 64 letters, digits, underscores or hyphens')
  if (typeof description !== 'string' || !description.trim()) throw new Error('description is required')
  if (!record(inputSchema) || inputSchema.type !== 'object') throw new Error('inputSchema must be an object schema')
  workflowExpression(source)
  return { origin, name, description, inputSchema, source }
}

/** A single literal export needs no module loader, SDK, or source rewriting heuristics. */
export function workflowExpression(source: string): string {
  if (typeof source !== 'string' || source.length > 256_000) throw new Error('index.js must be at most 256000 characters')
  const ast = parse(source, { sourceType: 'module', createImportExpressions: true })
  const statement = ast.program.body[0]
  if (ast.program.body.length !== 1 || statement?.type !== 'ExportDefaultDeclaration' || statement.declaration.type !== 'ArrayExpression')
    throw new Error('index.js must contain only export default [{ description, inspect, run }, ...]')
  const array = statement.declaration
  if (array.elements.length === 0) throw new Error('Workflow must contain at least one step')
  for (const [index, step] of array.elements.entries()) {
    if (step?.type !== 'ObjectExpression') throw new Error(`Step ${index + 1} must be an object literal`)
    const names = new Set<string>()
    for (const prop of step.properties) {
      if (prop.type === 'SpreadElement' || prop.computed || prop.key.type !== 'Identifier')
        throw new Error(`Step ${index + 1}: use description, inspect, run directly`)
      const key = prop.key.name
      if (names.has(key) || !['description', 'inspect', 'run'].includes(key)) throw new Error(`Step ${index + 1}: invalid or duplicate ${key}`)
      names.add(key)
      if (key === 'description') {
        if (prop.type !== 'ObjectProperty' || prop.value.type !== 'StringLiteral' || !prop.value.value.trim())
          throw new Error(`Step ${index + 1}: description must be a nonempty string`)
      } else if (prop.type === 'ObjectMethod' ? prop.kind !== 'method' || prop.generator :
        !['ArrowFunctionExpression', 'FunctionExpression'].includes(prop.value.type) || ('generator' in prop.value && prop.value.generator)) {
        throw new Error(`Step ${index + 1}: ${key} must be a function`)
      }
    }
    if (names.size !== 3) throw new Error(`Step ${index + 1}: description, inspect and run are required`)
  }
  const visit = (value: unknown): void => {
    if (!record(value)) return
    if (value.type === 'ImportExpression' || value.type === 'MetaProperty') throw new Error('Module imports and import.meta are unavailable')
    for (const [key, child] of Object.entries(value)) {
      if (key === 'loc') continue
      if (Array.isArray(child)) child.forEach(visit)
      else visit(child)
    }
  }
  visit(array)
  return source.slice(array.start!, array.end!)
}

export function validateAdapterSnapshot(value: unknown): WebMCPAdapter[] {
  if (!Array.isArray(value) || value.length > 100 || JSON.stringify(value).length > 2_000_000)
    throw new Error('Adapter snapshot exceeds limits (100 adapters, 2000000 characters)')
  const keys = new Set<string>()
  return value.map(item => {
    if (!record(item)) throw new Error('Invalid adapter')
    const { source, ...metadata } = item
    const adapter = validateAdapter(metadata, source as string)
    const key = `${adapter.origin}/${adapter.name}`
    if (keys.has(key)) throw new Error(`Duplicate adapter: ${key}`)
    keys.add(key)
    return adapter
  })
}
