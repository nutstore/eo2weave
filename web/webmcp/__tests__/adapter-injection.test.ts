import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdapterInjector } from '../../../browser-extension/entrypoints/webmcp/adapter-injector'
import { pkg, manifest } from './fixtures'

vi.mock('../../../browser-extension/entrypoints/webmcp/register-tools', () => ({ registerPageTools: vi.fn(async () => {}) }))
import { registerPageTools } from '../../../browser-extension/entrypoints/webmcp/register-tools'
beforeEach(() => vi.clearAllMocks())

describe('package injection', () => {
  it('matches URL regexes, namespaces names, and preserves unchanged registrations', async () => {
    let href = 'https://other.test/articles'
    const sync = createAdapterInjector(() => href)
    await sync([pkg])
    expect(registerPageTools).not.toHaveBeenCalled()
    href = 'https://example.com/articles'
    await sync([pkg])
    await sync([pkg])
    expect(registerPageTools).toHaveBeenCalledTimes(1)
    const [tools] = vi.mocked(registerPageTools).mock.calls[0]
    expect(tools[0].name).toBe('com.example.tools.read-title')
    expect(tools[0].inputSchema).toEqual({ type: 'object' })
    expect(await tools[0].execute({})).toEqual({ status: 'completed', result: 'title' })
    href = 'https://example.com/other'
    expect(() => tools[0].execute({})).toThrow('no longer matches')
    await sync([pkg])
    expect(vi.mocked(registerPageTools).mock.calls[0][1].signal.aborted).toBe(true)
  })
  it('withdraws removed or changed tools and allows the same name in different packages', async () => {
    const sync = createAdapterInjector(() => 'https://example.com/articles')
    await sync([pkg, { ...pkg, manifest: { ...manifest, id: 'com.other.tools' } }])
    expect(registerPageTools).toHaveBeenCalledTimes(2)
    const first = vi.mocked(registerPageTools).mock.calls[0][1]
    await sync([{ ...pkg, manifest: { ...manifest, tools: [{ ...manifest.tools[0], description: 'Updated' }] } }])
    expect(first.signal.aborted).toBe(true)
    const updated = vi.mocked(registerPageTools).mock.calls[2][1]
    await sync([])
    expect(updated.signal.aborted).toBe(true)
  })
  it('serializes overlapping updates and retries failed registrations', async () => {
    const sync = createAdapterInjector(() => 'https://example.com/articles')
    vi.mocked(registerPageTools).mockRejectedValueOnce(new Error('Name collision'))
    await expect(sync([pkg])).rejects.toThrow('Name collision')
    await Promise.all([sync([pkg]), sync([])])
    expect(vi.mocked(registerPageTools).mock.calls[1][1].signal.aborted).toBe(true)
  })
})
