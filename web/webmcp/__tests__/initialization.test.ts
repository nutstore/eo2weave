import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const installWebMCP = vi.hoisted(() => vi.fn())
vi.mock('@mcp-b/webmcp-polyfill', () => ({ installWebMCP }))
vi.mock('@/store/conversation.store', () => {
  expect(installWebMCP).toHaveBeenCalledTimes(1)
  return { get useConversationStore() { throw new Error('Dependency loading reached') } }
})

beforeEach(() => {
  vi.resetModules()
  installWebMCP.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

describe('WebMCP initialization', () => {
  it('initializes the extension page API in MAIN at document_start', async () => {
    const { default: script } = await import('../../../browser-extension/entrypoints/webmcp-bootstrap.content')
    expect(script).toMatchObject({ world: 'MAIN', runAt: 'document_start', matches: ['<all_urls>'] })
    expect(installWebMCP).not.toHaveBeenCalled()
    script.main({} as never)
    expect(installWebMCP).toHaveBeenCalledTimes(1)
  })

  it('explicitly initializes the app API before loading registration dependencies', async () => {
    const { registerAppTools } = await import('../app-tools/register')
    expect(installWebMCP).not.toHaveBeenCalled()
    await expect(registerAppTools()).rejects.toThrow('Dependency loading reached')
    expect(installWebMCP).toHaveBeenCalledTimes(1)
  })
})
