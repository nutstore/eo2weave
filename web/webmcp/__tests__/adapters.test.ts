import { describe, expect, it, vi } from 'vitest'
import { validateAdapter, workflowExpression } from '@creatorweave/shared/webmcp-adapter'
import { runWorkflow, type WorkflowStep } from '@creatorweave/shared/webmcp-workflow'
import { readAdapterCatalog } from '../adapters'
import { webmcpCommand } from '@/agent/tools/bash-worker/webmcp-command'

const metadata = { origin: 'https://example.com', name: 'read-title', description: 'Read title', inputSchema: { type: 'object' } }
const source = `export default [{ description: 'Read', inspect() { return { status: 'ready' } }, run() { return document.title } }]`

describe('adapter validation', () => {
  it('accepts the single module export without executing page code', () => {
    expect(validateAdapter(metadata, source).source).toBe(source)
    expect(workflowExpression(source)).toMatch(/^\[/)
  })
  it.each([
    `export default []`,
    source + '; alert("executed")',
    `export default [{description:'x', inspect:42, run(){}}]`,
    `export default [{description:'x', inspect(){}, run(){return import('x')}}]`,
    `export default [{description:'x', get inspect(){return ()=>{}}, run(){}}]`,
    `export default [{description:'x', inspect(){}, run(){}, run(){}}]`,
  ])('rejects malformed modules: %s', code => {
    expect(() => validateAdapter(metadata, code)).toThrow()
  })
  it.each(['https://example.com/path', 'https://example.com/', 'file:///tmp/x', 'https://user:pass@example.com'])('rejects non-origins %s', origin => {
    expect(() => validateAdapter({ ...metadata, origin }, source)).toThrow()
  })
  it('omits broken packages and both sides of a name collision', async () => {
    const result = await readAdapterCatalog({
      directories: async () => ['a', 'b', 'broken'],
      readFile: async path => {
        if (path.startsWith('broken')) throw new Error('Missing file')
        return path.endsWith('.json') ? JSON.stringify(metadata) : source
      },
    })
    expect(result.adapters).toEqual([])
    expect(result.errors).toHaveLength(3)
  })
  it('provides actionable validation errors and shell exit codes', async () => {
    const context = { cwd: '/webmcp', fs: { resolvePath: (_: string, p: string) => p, readFile: async (p: string) => p.endsWith('.json') ? JSON.stringify(metadata) : source } }
    expect((await webmcpCommand.execute(['validate', '/webmcp/example'], context as never)).exitCode).toBe(0)
    expect((await webmcpCommand.execute([], context as never)).exitCode).toBe(2)
    context.fs.readFile = async () => 'invalid'
    expect((await webmcpCommand.execute(['validate', 'example'], context as never)).exitCode).toBe(1)
  })
})

describe('workflow execution', () => {
  it('runs sequentially with shared state and returns the last result', async () => {
    const steps: WorkflowStep[] = [
      { description: 'first', inspect: () => ({ status: 'ready' }), run: ({ args, state }) => { state.value = args.value } },
      { description: 'second', inspect: ({ state }) => state.value === 42 ? { status: 'ready' } : { status: 'blocked', message: 'Missing' }, run: ({ state }) => state.value },
    ]
    expect(await runWorkflow(steps, { value: 42 }, new AbortController().signal)).toEqual({ status: 'completed', result: 42 })
    expect(await runWorkflow(steps.slice(1), {}, new AbortController().signal)).toMatchObject({ status: 'blocked', message: 'Missing' })
  })
  it('stops before run and later inspections when blocked', async () => {
    const run = vi.fn()
    const inspect = vi.fn()
    expect(await runWorkflow([
      { description: 'Login', inspect: () => ({ status: 'blocked', message: 'Please log in' }), run },
      { description: 'Later', inspect, run },
    ], {}, new AbortController().signal)).toEqual({ status: 'blocked', step: 1, description: 'Login', message: 'Please log in' })
    expect(run).not.toHaveBeenCalled()
    expect(inspect).not.toHaveBeenCalled()
  })
  it('rejects invalid inspection results and propagates exceptions', async () => {
    const run = vi.fn()
    await expect(runWorkflow([{ description: 'Bad', inspect: () => ({ status: 'skip' }) as never, run }], {}, new AbortController().signal)).rejects.toThrow('inspect must return')
    expect(run).not.toHaveBeenCalled()
    await expect(runWorkflow([{ description: 'Bad', inspect: () => { throw new Error('boom') }, run }], {}, new AbortController().signal)).rejects.toThrow('boom')
  })
  it('honors cancellation between inspect and run', async () => {
    const controller = new AbortController()
    const run = vi.fn()
    await expect(runWorkflow([{ description: 'cancel', inspect: () => { controller.abort(); return { status: 'ready' } }, run }], {}, controller.signal)).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
})
