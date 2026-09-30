import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdapterInjector } from '../../../browser-extension/entrypoints/webmcp/adapter-injector'

vi.mock('../../../browser-extension/entrypoints/webmcp/register-tools', () => ({ registerPageTools: vi.fn(async () => {}) }))
import { registerPageTools } from '../../../browser-extension/entrypoints/webmcp/register-tools'
const source = `export default [{description:'Read',inspect(){return {status:'ready'}},run(){return 'title'}}]`
const adapter = { origin: 'https://example.com', name: 'title', description: 'Read title', inputSchema: { type: 'object' }, source }

beforeEach(() => vi.clearAllMocks())

describe('adapter injection', () => {
  it('matches exact origins and preserves unchanged registrations', async () => {
    const sync = createAdapterInjector('https://example.com')
    await sync([{ ...adapter, origin: 'https://other.example.com' }])
    expect(registerPageTools).not.toHaveBeenCalled()
    await sync([adapter])
    await sync([adapter])
    expect(registerPageTools).toHaveBeenCalledTimes(1)
    const [tools] = vi.mocked(registerPageTools).mock.calls[0]
    expect(await tools[0].execute({})).toEqual({ status: 'completed', result: 'title' })
  })
  it('withdraws removed and changed adapters', async () => {
    const sync = createAdapterInjector(adapter.origin)
    await sync([adapter])
    const first = vi.mocked(registerPageTools).mock.calls[0][1]
    await sync([{ ...adapter, description: 'Updated' }])
    expect(first.signal.aborted).toBe(true)
    const second = vi.mocked(registerPageTools).mock.calls[1][1]
    await sync([])
    expect(second.signal.aborted).toBe(true)
  })
  it('serializes overlapping updates and retries failed registrations', async () => {
    const sync = createAdapterInjector(adapter.origin)
    vi.mocked(registerPageTools).mockRejectedValueOnce(new Error('Name collision'))
    await expect(sync([adapter])).rejects.toThrow('Name collision')
    const pending = sync([adapter])
    const removal = sync([])
    await Promise.all([pending, removal])
    expect(vi.mocked(registerPageTools).mock.calls[1][1].signal.aborted).toBe(true)
  })
})
