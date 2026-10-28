// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runBrowserRequest } from '../../../browser-extension/lib/bash-commands/browser/runtime'

/**
 * Eval routing tests: the no-ref form must go through chrome.scripting
 * (no chrome.debugger attach — that is what raises Chrome's "debugging
 * started" banner), while the element-target form keeps the CDP path because
 * objectIds only exist inside a debugger session.
 */

vi.mock('../../../browser-extension/lib/bash-commands/browser/snapshot', () => ({
  getLatestSnapshotForScope: vi.fn(() => ({
    snapshotId: 'snap-1',
    url: 'https://example.com/',
    nodes: [{ ref: 'e12', backendNodeId: 55 }],
  })),
  clearSnapshotsForTab: vi.fn(),
  buildBrowserSnapshot: vi.fn(),
}))

type Callback<T> = (result?: T) => void

const debuggerApi = () => {
  const attach = vi.fn((_t: { tabId: number }, _v: string, done: Callback<void>) => done())
  const detach = vi.fn((_t: { tabId: number }, done: Callback<void>) => done())
  const sendCommand = vi.fn((_target: unknown, _m: string, _p: Record<string, unknown>, done: (r?: unknown) => void) => done({ result: { value: 42, type: 'number' } }))
  const onDetach = { addListener: vi.fn() }
  return { attach, detach, sendCommand, onDetach }
}

const tabsApi = () => ({
  get: vi.fn(async (tabId: number) => ({ id: tabId, url: 'https://example.com/' })),
  query: vi.fn(async () => []),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  onRemoved: { addListener: vi.fn() },
  onUpdated: { addListener: vi.fn() },
})

const storageApi = () => {
  const data = new Map<string, unknown>()
  return {
    session: {
      get: vi.fn(async (key: string) => (data.has(key) ? { [key]: data.get(key) } : {})),
      set: vi.fn(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, v) }),
    },
  }
}

/** Runs the serialized evaluationFunction wrapper like Chrome would. */
const runWrapper = async (details: { args?: unknown[] }) => {
  const wrapper = String(details.args?.[0])
  const fn = new Function(`return (${wrapper})`)() as (arg: unknown) => Promise<{ ok: boolean; message?: string; logs: unknown[]; result: unknown; exception?: unknown }>
  return await fn(undefined)
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { vi.unstubAllGlobals() })

describe('browser eval routing', () => {
  it('routes no-ref eval through chrome.scripting without touching chrome.debugger', async () => {
    const executeScript = vi.fn(async (details: { target: { tabId: number }; world?: string; func?: unknown; args?: unknown[] }) => {
      expect(details.target).toEqual({ tabId: 7 })
      expect(details.world).toBe('MAIN')
      expect(typeof details.func).toBe('function')
      expect(details.args).toHaveLength(1)
      const outcome = await runWrapper(details)
      expect(outcome).toMatchObject({ ok: true, result: 6 })
      return [{ result: outcome }]
    })
    const dbg = debuggerApi()
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await runBrowserRequest('owner', {
      command: 'eval', positionals: ['() => 6'], options: { tab: '7' }, stdin: '',
    })
    expect(result).toEqual({ tabId: 7, logs: [], result: 6 })
    expect(executeScript).toHaveBeenCalledTimes(1)
    expect(dbg.attach).not.toHaveBeenCalled()
    expect(dbg.sendCommand).not.toHaveBeenCalled()
  })

  it('reads eval source from stdin and honors async page functions', async () => {
    const executeScript = vi.fn(async (details: { args?: unknown[] }) => {
      const outcome = await runWrapper(details)
      return [{ result: outcome }]
    })
    const dbg = debuggerApi()
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await runBrowserRequest('owner', {
      command: 'eval', positionals: [], options: { tab: '7' }, stdin: 'async () => (await Promise.resolve("late")) + "!"',
    })
    expect(result).toEqual({ tabId: 7, logs: [], result: 'late!' })
    expect(dbg.attach).not.toHaveBeenCalled()
  })

  it('surfaces page exceptions and console logs from the scripting path without attaching', async () => {
    const executeScript = vi.fn(async (details: { args?: unknown[] }) => {
      const outcome = await runWrapper(details)
      expect(outcome.ok).toBe(false)
      return [{ result: outcome }]
    })
    const dbg = debuggerApi()
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    await expect(runBrowserRequest('owner', {
      command: 'eval', positionals: ['() => { console.warn("careful"); throw new Error("boom") }'], options: { tab: '7' }, stdin: '',
    })).rejects.toMatchObject({
      message: 'boom',
      details: { tabId: 7, logs: [{ level: 'warn', args: ['careful'] }], exception: expect.anything() },
    })
    expect(dbg.attach).not.toHaveBeenCalled()
  })

  it('rejects an empty eval before any injection or attach', async () => {
    const executeScript = vi.fn()
    const dbg = debuggerApi()
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    await expect(runBrowserRequest('owner', {
      command: 'eval', positionals: [], options: { tab: '7' }, stdin: '  ',
    })).rejects.toThrow('eval requires')
    expect(executeScript).not.toHaveBeenCalled()
    expect(dbg.attach).not.toHaveBeenCalled()
  })

  it('keeps snapshot-ref eval on the CDP path with Runtime.callFunctionOn', async () => {
    const executeScript = vi.fn()
    const dbg = debuggerApi()
    const storage = storageApi()
    await storage.session.set({ 'cw_browser_selected:owner': 7 })
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.releaseObject') { done(); return }
      if (method === 'DOM.resolveNode') { done({ object: { objectId: 'obj-1' } }); return }
      if (method === 'Runtime.callFunctionOn') {
        const declaration = String(params.functionDeclaration)
        if (declaration.includes('isConnected')) { done({ result: { value: true } }); return }
        done({ result: { value: { ok: true, logs: [], result: 'element-title' } } })
        return
      }
      done({ result: { value: 42 } })
    })
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      debugger: dbg,
      tabs: tabsApi(),
      storage,
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await runBrowserRequest('owner', {
      command: 'eval', positionals: ['function(el) { return el.textContent }', 'e12'], options: { tab: '7' }, stdin: '',
    })
    expect(result).toMatchObject({ tabId: 7, result: 'element-title' })
    expect(dbg.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3', expect.any(Function))
    expect(dbg.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ tabId: 7 }), 'DOM.resolveNode', expect.objectContaining({ backendNodeId: 55 }), expect.any(Function))
    expect(dbg.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ tabId: 7 }), 'Runtime.callFunctionOn', expect.objectContaining({ objectId: 'obj-1' }), expect.any(Function))
    expect(executeScript).not.toHaveBeenCalled()
  })

  it('keeps CSS-target eval on the CDP path too', async () => {
    const executeScript = vi.fn()
    const dbg = debuggerApi()
    const storage = storageApi()
    await storage.session.set({ 'cw_browser_selected:owner': 7 })
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.releaseObject') { done(); return }
      if (method === 'Runtime.evaluate') {
        // withElement polls Runtime.evaluate until it returns an objectId.
        done({ result: { objectId: 'obj-9' } })
        return
      }
      if (method === 'Runtime.callFunctionOn') {
        const declaration = String(params.functionDeclaration)
        if (declaration.includes('isConnected')) { done({ result: { value: true } }); return }
        done({ result: { value: { ok: true, logs: [], result: 'css-title' } } })
        return
      }
      done({ result: { value: 42 } })
    })
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      debugger: dbg,
      tabs: tabsApi(),
      storage,
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await runBrowserRequest('owner', {
      command: 'eval', positionals: ['function(el) { return el.textContent }', 'h1.title'], options: {}, stdin: '',
    })
    expect(result).toMatchObject({ tabId: 7, result: 'css-title' })
    expect(dbg.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ tabId: 7 }), 'Runtime.callFunctionOn', expect.objectContaining({ objectId: 'obj-9' }), expect.any(Function))
    expect(executeScript).not.toHaveBeenCalled()
  })
})
