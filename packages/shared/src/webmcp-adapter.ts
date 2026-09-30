import { parse } from '@babel/parser'
import type { Node } from '@babel/types'
import { validateUrlRegex } from './webmcp-url'
export { matchesToolUrl } from './webmcp-url'
import { createSchemaValidator, type JsonSchema } from './webmcp-schema'

export interface WebMCPToolManifest {
  name: string
  description: string
  urlRegex: string
  path: string
}
export interface WebMCPPackageManifest {
  id: string
  version: string
  description: string
  tools: WebMCPToolManifest[]
}
export interface WebMCPPackage {
  manifest: WebMCPPackageManifest
  sources: Record<string, string>
}
export interface WorkflowContract {
  inputSchema: JsonSchema
  outputSchema: JsonSchema
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function fields(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some(key => !(key in value)))
    throw new Error(`${label} requires exactly ${keys.join(', ')}`)
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`)
}

export function toolSourcePath(value: unknown): string {
  text(value, 'Tool path')
  const path = value.startsWith('./') ? value.slice(2) : value
  if (!path.endsWith('.js') || path.split('/').some(part => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9_.-]+$/.test(part)))
    throw new Error('Tool path must be a relative .js file inside the package')
  return path
}

export function validateManifest(value: unknown, directoryId: string): WebMCPPackageManifest {
  fields(value, ['id', 'version', 'description', 'tools'], 'manifest.json')
  const { id, version, description, tools } = value
  text(id, 'Package id')
  if (id.length > 128 || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(id))
    throw new Error('Package id must be a reverse-domain namespace, such as com.example.tools')
  if (id !== directoryId) throw new Error(`Package id ${id} must match directory ${directoryId}`)
  text(version, 'Package version')
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version))
    throw new Error('Package version must be a semantic version')
  text(description, 'Package description')
  if (!Array.isArray(tools) || tools.length === 0 || tools.length > 100) throw new Error('Package must contain 1–100 tools')
  const names = new Set<string>()
  const parsed = tools.map((tool, index): WebMCPToolManifest => {
    fields(tool, ['name', 'description', 'urlRegex', 'path'], `Tool ${index + 1}`)
    text(tool.name, 'Tool name')
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name)) throw new Error('Tool name must start with a letter and contain at most 64 letters, digits, underscores or hyphens')
    if (`${id}.${tool.name}`.length > 128) throw new Error('Qualified tool name (package id + name) must be at most 128 characters')
    if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`)
    names.add(tool.name)
    text(tool.description, 'Tool description')
    return { name: tool.name, description: tool.description, urlRegex: validateUrlRegex(tool.urlRegex), path: toolSourcePath(tool.path) }
  })
  return { id, version, description, tools: parsed }
}

/** Read only JSON literals from schema ASTs; adapter functions are never evaluated here. */
function jsonLiteral(node: Node): unknown {
  if (node.type === 'StringLiteral' || node.type === 'BooleanLiteral' || node.type === 'NumericLiteral') return node.value
  if (node.type === 'NullLiteral') return null
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral') return -node.argument.value
  if (node.type === 'ArrayExpression') return node.elements.map(item => {
    if (!item || item.type === 'SpreadElement') throw new Error('Schema arrays must contain JSON literals')
    return jsonLiteral(item)
  })
  if (node.type === 'ObjectExpression') {
    const value: Record<string, unknown> = Object.create(null)
    for (const property of node.properties) {
      if (property.type !== 'ObjectProperty' || property.computed || property.shorthand) throw new Error('Schemas must use JSON literal properties')
      const key = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'StringLiteral' ? property.key.value : null
      if (key === null || key in value) throw new Error('Invalid or duplicate schema property')
      value[key] = jsonLiteral(property.value)
    }
    return value
  }
  throw new Error('Schemas must be JSON literals, without expressions or references to variables')
}

export function parseWorkflow(source: string): { expression: string; contracts: WorkflowContract[] } {
  if (typeof source !== 'string' || source.length > 256_000) throw new Error('Tool source must be at most 256000 characters')
  const ast = parse(source, { sourceType: 'module', createImportExpressions: true })
  const statement = ast.program.body[0]
  if (ast.program.body.length !== 1 || statement?.type !== 'ExportDefaultDeclaration' || statement.declaration.type !== 'ArrayExpression')
    throw new Error('Tool source must contain only export default [{ description, inputSchema, outputSchema, inspect, run }, ...]')
  const array = statement.declaration
  if (array.elements.length === 0) throw new Error('Workflow must contain at least one step')
  const contracts = array.elements.map((step, index): WorkflowContract => {
    const label = `Step ${index + 1}`
    if (step?.type !== 'ObjectExpression') throw new Error(`${label} must be an object literal`)
    const properties = new Map<string, typeof step.properties[number]>()
    for (const prop of step.properties) {
      if (prop.type === 'SpreadElement' || prop.computed) throw new Error(`${label}: use literal step properties`)
      const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.type === 'StringLiteral' ? prop.key.value : ''
      if (properties.has(key) || !['description', 'inputSchema', 'outputSchema', 'inspect', 'run'].includes(key)) throw new Error(`${label}: invalid or duplicate ${key}`)
      properties.set(key, prop)
      if (key === 'description') {
        if (prop.type !== 'ObjectProperty' || prop.value.type !== 'StringLiteral' || !prop.value.value.trim()) throw new Error(`${label}: description must be a nonempty string`)
      } else if (key === 'inspect' || key === 'run') {
        if (prop.type === 'ObjectMethod' ? prop.kind !== 'method' || prop.generator :
          !['ArrowFunctionExpression', 'FunctionExpression'].includes(prop.value.type) || ('generator' in prop.value && prop.value.generator))
          throw new Error(`${label}: ${key} must be a function`)
      }
    }
    if (properties.size !== 5) throw new Error(`${label}: description, inputSchema, outputSchema, inspect and run are required`)
    const schema = (key: 'inputSchema' | 'outputSchema'): JsonSchema => {
      const property = properties.get(key)!
      if (property.type !== 'ObjectProperty') throw new Error(`${label} ${key} must be a JSON schema literal`)
      const value = jsonLiteral(property.value)
      if (typeof value !== 'boolean' && !record(value)) throw new Error(`${label} ${key} must be a JSON schema`)
      createSchemaValidator(value, `${label} ${key}`)
      return value
    }
    return { inputSchema: schema('inputSchema'), outputSchema: schema('outputSchema') }
  })
  if (typeof contracts[0].inputSchema !== 'object' || contracts[0].inputSchema.type !== 'object')
    throw new Error('First step inputSchema must be an object schema for WebMCP arguments')
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
  return { expression: source.slice(array.start!, array.end!), contracts }
}

export function validatePackage(manifest: unknown, sources: unknown, directoryId: string): WebMCPPackage {
  const parsed = validateManifest(manifest, directoryId)
  if (!record(sources)) throw new Error('Package sources must be an object')
  const files: Record<string, string> = Object.create(null)
  for (const tool of parsed.tools) {
    const source = sources[tool.path]
    if (typeof source !== 'string') throw new Error(`Missing tool source: ${tool.path}`)
    try { parseWorkflow(source) } catch (error) { throw new Error(`${tool.path}: ${error instanceof Error ? error.message : String(error)}`) }
    files[tool.path] = source
  }
  return { manifest: parsed, sources: files }
}

export function validatePackageSnapshot(value: unknown): WebMCPPackage[] {
  if (!Array.isArray(value) || value.length > 100 || JSON.stringify(value).length > 2_000_000)
    throw new Error('Package snapshot exceeds limits (100 packages, 2000000 characters)')
  const ids = new Set<string>()
  return value.map(item => {
    fields(item, ['manifest', 'sources'], 'Package snapshot')
    if (!record(item.manifest) || typeof item.manifest.id !== 'string') throw new Error('Missing package id')
    const pkg = validatePackage(item.manifest, item.sources, item.manifest.id)
    if (ids.has(pkg.manifest.id)) throw new Error(`Duplicate package id: ${pkg.manifest.id}`)
    ids.add(pkg.manifest.id)
    return pkg
  })
}
