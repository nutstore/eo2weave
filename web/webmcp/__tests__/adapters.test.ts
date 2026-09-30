import { describe, expect, it, vi } from 'vitest'
import { validateManifest, validatePackage, validatePackageSnapshot, parseWorkflow, matchesToolUrl } from '@creatorweave/shared/webmcp-adapter'
import { createWorkflow, type WorkflowStep } from '@creatorweave/shared/webmcp-workflow'
import { readPackage, readPackageCatalog } from '../adapters'
import { webmcpCommand } from '@/agent/tools/bash-worker/webmcp-command'
import { manifest, source, pkg } from './fixtures'

const step = (overrides: Partial<WorkflowStep>): WorkflowStep => ({
  description: 'Read', inputSchema: { type: 'object' }, outputSchema: true,
  inspect: () => ({ status: 'ready' }), run: () => null, ...overrides,
})

describe('package validation', () => {
  it('reads a multi-tool package and normalizes relative source paths', async () => {
    const metadata = { ...manifest, tools: [manifest.tools[0], { ...manifest.tools[0], name: 'other', path: './nested/other.js' }] }
    const readFile = vi.fn(async (path: string) => path.endsWith('.json') ? JSON.stringify(metadata) : source)
    const result = await readPackage({ readFile }, '/webmcp/com.example.tools/')
    expect(result.manifest.tools).toHaveLength(2)
    expect(readFile).toHaveBeenCalledWith('/webmcp/com.example.tools/nested/other.js')
    expect(result.sources['nested/other.js']).toBe(source)
  })
  it.each(['../escape.js', '/absolute.js', './nested/../../escape.js', 'nested\\file.js', 'x.ts'])('rejects unsafe source paths %s', path => {
    expect(() => validateManifest({ ...manifest, tools: [{ ...manifest.tools[0], path }] }, manifest.id)).toThrow()
  })
  it('requires all manifest fields, matching id and unique tool names', () => {
    expect(() => validateManifest({ ...manifest, version: undefined }, manifest.id)).toThrow()
    expect(() => validateManifest(manifest, 'com.other.tools')).toThrow('must match directory')
    expect(() => validateManifest({ ...manifest, tools: [manifest.tools[0], manifest.tools[0]] }, manifest.id)).toThrow('Duplicate tool')
    expect(() => validatePackageSnapshot([pkg, pkg])).toThrow('Duplicate package')
  })
  it('rejects an entire package when a tool source is missing', async () => {
    const result = await readPackageCatalog({
      directories: async () => [manifest.id],
      readFile: async path => {
        if (path.endsWith('.json')) return JSON.stringify(manifest)
        throw new Error('Missing file')
      },
    })
    expect(result.packages).toEqual([])
    expect(result.errors).toHaveLength(1)
  })
  it('validates contracts in CSP environments without dynamic code generation', async () => {
    const FunctionConstructor = globalThis.Function
    globalThis.Function = (() => { throw new Error('unsafe-eval forbidden') }) as unknown as typeof FunctionConstructor
    try {
      expect(validatePackage(manifest, pkg.sources, manifest.id).manifest.id).toBe(manifest.id)
      expect(await createWorkflow([step({ run: () => 'ok' })])({}, new AbortController().signal)).toEqual({ status: 'completed', result: 'ok' })
    } finally { globalThis.Function = FunctionConstructor }
  })
  it('parses schemas without executing adapter code', () => {
    const parsed = parseWorkflow(source.replace("return 'title'", 'throw new Error("executed")'))
    expect(parsed.contracts[0].inputSchema).toEqual({ type: 'object' })
    expect(parsed.expression).toMatch(/^\[/)
  })
  it.each([
    `export default []`, source + '; alert("executed")',
    source.replace("inputSchema: { type: 'object' },", ''),
    source.replace("outputSchema: { type: 'string' }", "outputSchema: { type: 'not-a-type' }"),
    source.replace("inputSchema: { type: 'object' }", "inputSchema: (() => ({type:'object'}))()"),
    source.replace("return 'title'", "return import('x')"),
    source.replace('inspect()', 'get inspect()'),
  ])('rejects invalid workflow contracts: %s', code => {
    expect(() => validatePackage(manifest, { 'read-title.js': code }, manifest.id)).toThrow()
  })
  it('supports local schema refs and rejects unresolved external refs', () => {
    expect(() => parseWorkflow(source.replace("outputSchema: { type: 'string' }", "outputSchema: { $ref: '#/definitions/value', definitions: { value: {type:'string'} } }"))).not.toThrow()
    expect(() => parseWorkflow(source.replace("outputSchema: { type: 'string' }", "outputSchema: { $ref: 'https://remote.test/schema' }"))).toThrow()
  })
  it('provides package validation errors and shell exit codes', async () => {
    const context = { cwd: '/webmcp', fs: { resolvePath: (_: string, p: string) => p, readFile: async (p: string) => p.endsWith('.json') ? JSON.stringify(manifest) : source } }
    const result = await webmcpCommand.execute(['validate', '/webmcp/com.example.tools'], context as never)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('com.example.tools@1.0.0')
    expect((await webmcpCommand.execute([], context as never)).exitCode).toBe(2)
    context.fs.readFile = async () => 'invalid'
    expect((await webmcpCommand.execute(['validate', manifest.id], context as never)).exitCode).toBe(1)
  })
})

describe('URL matching', () => {
  it.each(['https://example.com/articles', 'https://example.com/articles/1?sort=asc#top'])('matches full URLs %s', href => {
    expect(matchesToolUrl(manifest.tools[0].urlRegex, href)).toBe(true)
  })
  it.each(['https://example.com/other', 'https://example.com.evil.test/articles', 'http://example.com/articles', 'https://other.test/articles'])('rejects other URLs %s', href => {
    expect(matchesToolUrl(manifest.tools[0].urlRegex, href)).toBe(false)
  })
  it('enforces whole-string matching even when alternation bypasses the anchors', () => {
    expect(matchesToolUrl('^https://example\\.com|/articles$', 'https://example.com/other')).toBe(false)
  })
  it.each(['example.com', '^[$', '^https://example.com'])('rejects invalid patterns %s', urlRegex => {
    expect(() => validateManifest({ ...manifest, tools: [{ ...manifest.tools[0], urlRegex }] }, manifest.id)).toThrow()
  })
})

describe('workflow execution', () => {
  it('passes outputs to subsequent steps and keeps invocation state isolated', async () => {
    const execute = createWorkflow([
      step({ outputSchema: { type: 'integer' }, run: ({ state }) => { state.secret = 1; return 42 } }),
      step({ inputSchema: { type: 'integer' }, outputSchema: { type: 'integer' }, run: ({ input, state }) => Number(input) + Number(state.secret) }),
    ])
    expect(await execute({}, new AbortController().signal)).toEqual({ status: 'completed', result: 43 })
    const state: Record<string, unknown>[] = []
    const isolated = createWorkflow([step({ run: ctx => { state.push(ctx.state) } })])
    await Promise.all([isolated({}, new AbortController().signal), isolated({}, new AbortController().signal)])
    expect(state[0]).not.toBe(state[1])
  })
  it('validates input before inspect and output before the next step', async () => {
    const inspect = vi.fn(() => ({ status: 'ready' as const }))
    await expect(createWorkflow([step({ inspect })])(42, new AbortController().signal)).rejects.toThrow('Step 1 input')
    expect(inspect).not.toHaveBeenCalled()
    await expect(createWorkflow([
      step({ outputSchema: { type: 'integer' }, run: () => 'wrong' }), step({ inspect }),
    ])({}, new AbortController().signal)).rejects.toThrow('Step 1 output')
    expect(inspect).not.toHaveBeenCalled()
    await expect(createWorkflow([
      step({ outputSchema: { type: 'integer' }, run: () => 42 }), step({ inspect }),
    ])({}, new AbortController().signal)).rejects.toThrow('Step 2 input')
    expect(inspect).not.toHaveBeenCalled()
  })
  it('returns blocked messages without applying output schemas or running later steps', async () => {
    const run = vi.fn()
    const inspect = vi.fn()
    const result = await createWorkflow([
      step({ description: 'Login', outputSchema: false, inspect: () => ({ status: 'blocked', message: 'Please log in' }), run }),
      step({ inspect, run }),
    ])({}, new AbortController().signal)
    expect(result).toEqual({ status: 'blocked', step: 1, description: 'Login', message: 'Please log in' })
    expect(run).not.toHaveBeenCalled()
    expect(inspect).not.toHaveBeenCalled()
  })
  it('honors cancellation and rejects invalid inspect states', async () => {
    const controller = new AbortController()
    const run = vi.fn()
    await expect(createWorkflow([step({ inspect: () => { controller.abort(); return { status: 'ready' } }, run })])({}, controller.signal)).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
    await expect(createWorkflow([step({ inspect: () => ({ status: 'skip' }) as never })])({}, new AbortController().signal)).rejects.toThrow('inspect must return')
  })
})
