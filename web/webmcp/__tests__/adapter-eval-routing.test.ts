// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runBrowserRequest } from '../../../browser-extension/lib/bash-commands/browser/runtime'
import { isCspRejection } from '../../../browser-extension/lib/bash-commands/browser/scripting-eval'
import { clearDebuggerState } from '../../../browser-extension/lib/bash-commands/browser/cdp'

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

/** Runs the injected function exactly like Chrome: serialize func, pass args. */
const runInjected = async (details: { func?: unknown; args?: unknown[] }) => {
  if (typeof details.func !== 'function') throw new Error('func must be a function')
  const serialized = `(${details.func.toString()})(${details.args?.map(a => JSON.stringify(a)).join(', ') ?? ''})`
  // new Function("return (func)(args)") invokes the injected function and
  // yields its (possibly async) result.
  const invoke = new Function(`return ${serialized}`) as () => Promise<unknown>
  return await invoke()
}

beforeEach(() => {
  vi.clearAllMocks()
  // The cdp module keeps module-level attach state; reset it between tests
  // so attach assertions observe each test's own commands.
  clearDebuggerState(7)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('browser eval routing', () => {
  it('routes no-ref eval through chrome.scripting without touching chrome.debugger', async () => {
    const executeScript = vi.fn(async (details: { target: { tabId: number }; world?: string; func?: unknown; args?: unknown[] }) => {
      expect(details.target).toEqual({ tabId: 7 })
      expect(details.world).toBe('MAIN')
      expect(typeof details.func).toBe('function')
      expect(details.args).toHaveLength(1)
      const outcome = await runInjected(details)
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
    // The scripting path must not disturb an existing CDP session either.
    expect(dbg.detach).not.toHaveBeenCalled()
  })

  it('reads eval source from stdin and honors async page functions', async () => {
    const executeScript = vi.fn(async (details: { args?: unknown[] }) => {
      const outcome = await runInjected(details)
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
      const outcome = await runInjected(details) as { ok?: boolean }
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

  it('falls back to the CDP evaluation path when the page CSP rejects the compile', async () => {
    const executeScript = vi.fn(async () => {
      throw new Error('Refused to evaluate a string as JavaScript because \'unsafe-eval\' is not an allowed source of script in the following Content Security Policy directive')
    })
    const dbg = debuggerApi()
    const storage = storageApi()
    await storage.session.set({ 'cw_browser_selected:owner': 7 })
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') {
        // evaluatePage runs `(${wrapper}).call(undefined)` — the wrapper
        // handles the user function; the compile itself is debugger-injected
        // (CSP-free). The stub page function reads a stub document.title.
        const expression = String(params.expression).replace(/document\.title/g, '"fallback-title"')
        const invoke = new Function(`return ${expression}`) as () => Promise<{ ok: boolean; logs: unknown[]; result: unknown }>
        return invoke().then(outcome => done({ result: { value: outcome } }))
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
      command: 'eval', positionals: ['() => document.title'], options: { tab: '7' }, stdin: '',
    })
    expect(result).toEqual({ tabId: 7, logs: [], result: 'fallback-title' })
    expect(dbg.attach).toHaveBeenCalled()
    expect(dbg.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ tabId: 7 }), 'Runtime.evaluate', expect.anything(), expect.any(Function))
  })

  it('surfaces a CSP-flavored result that is not a compile rejection unchanged', async () => {
    // The page function itself throws a message containing CSP wording — that
    // is a genuine page error, not the wrapper's Function compile being
    // blocked, so no fallback and no attach may happen.
    const executeScript = vi.fn(async () => [{ result: { ok: false, message: 'User code violated policy: Content Security Policy', logs: [], exception: { name: 'Error' } } }])
    const dbg = debuggerApi()
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    await expect(runBrowserRequest('owner', {
      command: 'eval', positionals: ['() => { throw new Error("Content Security Policy") }'], options: { tab: '7' }, stdin: '',
    })).rejects.toMatchObject({ message: 'User code violated policy: Content Security Policy' })
    expect(dbg.attach).not.toHaveBeenCalled()
    expect(dbg.sendCommand).not.toHaveBeenCalled()
  })

  it('does not re-run a user function whose error message matches CSP patterns', async () => {
    // A genuine user-code error that merely mentions CSP wording must be
    // surfaced as-is: the CDP fallback would execute the function a second
    // time, and its external effects (requests, clicks) cannot be undone.
    let runs = 0
    const executeScript = vi.fn(async (details: { args?: unknown[] }) => {
      runs++
      // Execute the wrapper the same way the page would: compile the
      // serialized function source, then call it.
      const wrapper = (new Function(`return (${String(details.args![0])})`))() as () => Promise<{ ok: boolean; message: string }>
      return [{ result: await wrapper.call(undefined) }]
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
      command: 'eval', positionals: ['() => { throw new Error("Refused to evaluate: unsafe-eval is not allowed by Content Security Policy directive") }'], options: { tab: '7' }, stdin: '',
    })).rejects.toMatchObject({ message: 'Refused to evaluate: unsafe-eval is not allowed by Content Security Policy directive' })
    // Exactly one execution — no CDP fallback re-run.
    expect(runs).toBe(1)
    expect(dbg.attach).not.toHaveBeenCalled()
    expect(dbg.sendCommand).not.toHaveBeenCalled()
  })

  it('falls back to CDP when the CSP rejection surfaces as a tagged compile failure', async () => {
    // Some Chrome versions deliver the CSP refusal as the injected function's
    // EvalError result instead of an executeScript rejection. The wrapper
    // tags compile-stage failures so they can be told apart from user-code
    // errors without pattern matching.
    const executeScript = vi.fn(async () => [{ result: { ok: false, compileError: true, message: 'EvalError: Refused to evaluate a string as JavaScript because \'unsafe-eval\' is not an allowed source of script in the following Content Security Policy directive', logs: [] } }])
    const dbg = debuggerApi()
    const storage = storageApi()
    await storage.session.set({ 'cw_browser_selected:owner': 7 })
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression).replace(/document\.title/g, '"outcome-fallback"')
        const invoke = new Function(`return ${expression}`) as () => Promise<{ ok: boolean; logs: unknown[]; result: unknown }>
        return invoke().then(outcome => done({ result: { value: outcome } }))
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
      command: 'eval', positionals: ['() => document.title'], options: { tab: '7' }, stdin: '',
    })
    expect(result).toEqual({ tabId: 7, logs: [], result: 'outcome-fallback' })
    expect(dbg.attach).toHaveBeenCalled()
  })

  it('does not fall back when executeScript rejects with a non-CSP injection error', async () => {
    // executeScript rejections that are not the CSP compile refusal mean the
    // injection failed for an unrelated reason. Without the rejection itself
    // matching the strict CSP prefix, there is no evidence about whether the
    // page function ran, so the request must fail instead of re-running it.
    const executeScript = vi.fn(async () => { throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.') })
    const dbg = debuggerApi()
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    await expect(runBrowserRequest('owner', {
      command: 'eval', positionals: ['() => document.title'], options: { tab: '7' }, stdin: '',
    })).rejects.toMatchObject({ message: 'Cannot access contents of the page. Extension manifest must request permission to access the respective host.' })
    expect(executeScript).toHaveBeenCalledTimes(1)
    expect(dbg.attach).not.toHaveBeenCalled()
    expect(dbg.sendCommand).not.toHaveBeenCalled()
  })

  it('falls back only on the exact browser CSP refusal prefix, not CSP wording mid-message', async () => {
    // The rejection must match Chrome's documented Function-constructor CSP
    // message from the start; a message that merely CONTAINS CSP wording (an
    // unrelated injection error quoting it, for example) must surface as a
    // failure rather than trigger the CDP fallback.
    const executeScript = vi.fn(async () => { throw new Error('Injection failed: Refused to evaluate a string as JavaScript because \'unsafe-eval\' is not an allowed source of script') })
    const dbg = debuggerApi()
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    await expect(runBrowserRequest('owner', {
      command: 'eval', positionals: ['() => document.title'], options: { tab: '7' }, stdin: '',
    })).rejects.toMatchObject({ message: expect.stringContaining('Refused to evaluate a string as JavaScript') })
    expect(dbg.attach).not.toHaveBeenCalled()
    expect(dbg.sendCommand).not.toHaveBeenCalled()
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

describe('isCspRejection signature', () => {
  it('matches the exact browser Function-constructor CSP refusal prefix', () => {
    expect(isCspRejection("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self'\"")).toBe(true)
    expect(isCspRejection("EvalError: Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script")).toBe(true)
    expect(isCspRejection("  Refused to evaluate a string as JavaScript because 'unsafe-eval' ...")).toBe(true)
  })

  it('rejects messages that merely contain CSP wording or unrelated injection errors', () => {
    // User-function error whose message coincidentally carries CSP wording.
    expect(isCspRejection('Refused to evaluate: unsafe-eval is not allowed by Content Security Policy directive')).toBe(false)
    // CSP refusal quoted mid-message by an unrelated error.
    expect(isCspRejection("Injection failed: Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script")).toBe(false)
    // Non-CSP injection errors.
    expect(isCspRejection('Cannot access a chrome:// URL')).toBe(false)
    expect(isCspRejection('The tab was closed')).toBe(false)
    expect(isCspRejection('Cannot access contents of the page. Extension manifest must request permission to access the respective host.')).toBe(false)
  })
})
