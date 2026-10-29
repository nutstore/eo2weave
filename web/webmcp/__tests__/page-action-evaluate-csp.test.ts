// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isCspCompileRejection } from '../../../browser-extension/lib/bash-commands/browser/csp-rejection'
import { evaluateBoundExpressionViaCdp } from '../../../browser-extension/lib/bash-commands/browser/cdp-evaluate'
import { clearDebuggerState, TabLockWaitTimeoutError, withTabLock } from '../../../browser-extension/lib/bash-commands/browser/cdp'

/**
 * Issue #106: the page-action runner's `evaluate` action compiles arbitrary JS
 * with `new Function` in the page's MAIN world, which strict-CSP pages refuse.
 * The runner tags compile-stage failures; the background handler falls back to
 * the CSP-exempt CDP path. These tests cover the shared detection helper and
 * the CDP fallback evaluator (the same primitives the #105 scripting route
 * uses), including the no-double-run guarantee for user-code errors.
 */

type Callback<T> = (result?: T) => void

const IDENTITY_PROBE = 'Page.getFrameTree'

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

beforeEach(() => {
  vi.clearAllMocks()
  // The cdp module keeps module-level attach state; reset it between tests
  // so attach assertions observe each test's own commands.
  clearDebuggerState(7)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('isCspCompileRejection signature (shared by #105 + #106)', () => {
  it('matches the exact browser Function-constructor CSP refusal prefix', () => {
    expect(isCspCompileRejection("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self'\"")).toBe(true)
    expect(isCspCompileRejection("EvalError: Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script")).toBe(true)
    expect(isCspCompileRejection("  Refused to evaluate a string as JavaScript because 'unsafe-eval' ...")).toBe(true)
  })

  it('rejects messages that merely contain CSP wording or unrelated injection errors', () => {
    // User-expression error whose message coincidentally carries CSP wording.
    expect(isCspCompileRejection('Refused to evaluate: unsafe-eval is not allowed by Content Security Policy directive')).toBe(false)
    // CSP refusal quoted mid-message by an unrelated error.
    expect(isCspCompileRejection("Injection failed: Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script")).toBe(false)
    // Non-CSP injection errors.
    expect(isCspCompileRejection('Cannot access a chrome:// URL')).toBe(false)
    expect(isCspCompileRejection('The tab was closed')).toBe(false)
  })
})

describe('evaluateBoundExpressionViaCdp (#106 fallback)', () => {
  it('attaches the debugger and EXECUTES the generated wrapper to derive the result', async () => {
    const dbg = debuggerApi()
    const captured: string[] = []
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') {
        captured.push(String(params.expression))
        // Execute the EXACT captured source as Runtime.evaluate would (as an
        // async-IIFE script): the result is whatever the wrapper ACTUALLY
        // evaluates to. A wrapper that embeds the expression as inert text
        // resolves undefined — it cannot fake 'set-by-body'. The node env has
        // no `window`, so route the expression's global object through
        // `globalThis`, exactly like a page expression sees it.
        const source = String(params.expression).replace(/\bwindow\b/g, 'globalThis')
        const fn = new Function(`return ${source}`) as () => Promise<unknown>
        void fn().then((v) => done({ result: { value: v } }))
      } else if (method === IDENTITY_PROBE) {
        done({ frameTree: { frame: { loaderId: 'same-loader-id' } } })
      } else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    // The expression WRITES its observable effect; the result is derived by
    // the wrapper actually running that write. An inert-text wrapper never
    // assigns, so the wrapper's completion value cannot be 'set-by-body'.
    const result = await evaluateBoundExpressionViaCdp(7, "window.__x = 'set-by-body'; return window.__x")
    expect(result).toEqual({ ok: true, result: 'set-by-body' })
    expect(dbg.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3', expect.any(Function))
    expect(dbg.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 7 }),
      'Runtime.evaluate',
      expect.objectContaining({ returnByValue: true, awaitPromise: true }),
      expect.any(Function),
    )
    // The caller's expression must reach Runtime.evaluate inside the wrapper.
    expect(captured).toHaveLength(1)
    expect(captured[0]).toContain("window.__x = 'set-by-body'")
  })

  it('wraps function-body syntax (return / top-level await) so it parses and EXECUTES as a script', async () => {
    const dbg = debuggerApi()
    let captured: Record<string, unknown> | undefined
    // PLAIN async FUNCTION wrapper (not an arrow): matches the MAIN-world
    // `new Function(body)` semantics for `arguments` and strict-mode `this`.
    const WRAPPER_RE = new RegExp('^\\(async function \\(\\) \\{\\n([\\s\\S]*)\\n\\}\\)\\(\\)$')
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') {
        captured = params
        // Execute the generated wrapper FOR REAL: derive the completion value
        // from the caller's body via Function — a wrapper that embeds the
        // input as inert text would resolve undefined and fail this test.
        const m = String(params.expression).match(WRAPPER_RE)
        if (!m) {
          done({ result: { value: undefined }, exceptionDetails: { text: 'Evaluation failed: wrapper shape' } })
          return
        }
        const fn = new Function(`return (async () => { ${m[1]} })()`) as () => Promise<unknown>
        void fn().then((v) => done({ result: { value: v } }), (e) => done({
          result: { value: undefined },
          exceptionDetails: { text: 'Uncaught', exception: { description: e instanceof Error ? e.message : String(e) } },
        }))
      } else if (method === 'Page.getFrameTree') {
        done({ frameTree: { frame: { loaderId: 'same-loader-id' } } })
      } else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    // `return` at top level is a SyntaxError in raw script source (Runtime.
    // evaluate parses SCRIPT source) but valid inside `new Function` — the
    // wrapper must make it legal AND the return value must come from really
    // executing the body, not from a fabricated mock result.
    const result = await evaluateBoundExpressionViaCdp(7, "return 'executed:' + (1 + 1)")
    expect(result).toEqual({ ok: true, result: 'executed:2' })
    const expr = String(captured?.expression)
    expect(expr.startsWith('(async function () {')).toBe(true)
    expect(expr).toContain("return 'executed:' + (1 + 1)")
    expect(expr.trimEnd().endsWith('})()')).toBe(true)
  })

  it('maps unserializable results (NaN / Infinity / -0 / BigInt) into the tagged JSON-safe form', async () => {
    const dbg = debuggerApi()
    const cases: Array<{ unserializableValue: string; expected: unknown }> = [
      { unserializableValue: 'NaN', expected: { __unserializableValue: 'NaN' } },
      { unserializableValue: 'Infinity', expected: { __unserializableValue: 'Infinity' } },
      { unserializableValue: '-Infinity', expected: { __unserializableValue: '-Infinity' } },
      { unserializableValue: '-0', expected: { __unserializableValue: '-0' } },
      { unserializableValue: '42n', expected: { __unserializableValue: '42n' } },
    ]
    for (const c of cases) {
      dbg.sendCommand.mockImplementation((_target: unknown, method: string, _params: Record<string, unknown>, done: (r?: unknown) => void) => {
        if (method === 'Runtime.evaluate') done({ result: { unserializableValue: c.unserializableValue } })
        else if (method === IDENTITY_PROBE) done({ frameTree: { frame: { loaderId: 'same-loader-id' } } })
        else done({ result: { value: null } })
      })
      vi.stubGlobal('chrome', {
        debugger: dbg,
        tabs: tabsApi(),
        storage: storageApi(),
        runtime: { onDetach: dbg.onDetach },
      })
      // eslint-disable-next-line no-await-in-loop
      const result = await evaluateBoundExpressionViaCdp(7, '0/0')
      // Native NaN/±Infinity/-0 would be corrupted and BigInt dropped/thrown
      // by the extension-message bridge's JSON serialization — the evaluator
      // must hand the caller the tagged JSON-safe form instead.
      expect(result).toEqual({ ok: true, result: c.expected })
      // The tagged form must survive a real JSON round-trip intact.
      expect(JSON.parse(JSON.stringify((result as { result: unknown }).result))).toEqual(c.expected)
    }
  })

  it('surfaces thrown primitives (no exception.description) as the thrown value', async () => {
    const dbg = debuggerApi()
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, _params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') {
        done({
          result: { value: undefined },
          exceptionDetails: {
            text: 'Uncaught',
            exception: { value: 'custom failure', subtype: 'string' },
          },
        })
      } else if (method === IDENTITY_PROBE) done({ frameTree: { frame: { loaderId: 'same-loader-id' } } })
      else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await evaluateBoundExpressionViaCdp(7, "throw 'custom failure'")
    expect(result).toEqual({ ok: false, error: 'custom failure' })
  })

  it('reports a thrown undefined as "undefined" (exception-details presence, not the converted value)', async () => {
    const dbg = debuggerApi()
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, _params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') {
        done({
          result: { value: undefined },
          exceptionDetails: {
            text: 'Uncaught',
            exception: { type: 'undefined', subtype: 'undefined' },
          },
        })
      } else if (method === IDENTITY_PROBE) done({ frameTree: { frame: { loaderId: 'same-loader-id' } } })
      else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await evaluateBoundExpressionViaCdp(7, 'throw undefined')
    // The MAIN-world path renders a thrown undefined as "undefined"; the
    // fallback must do the same instead of falling back to CDP's generic
    // "Uncaught" text (the old `thrown !== undefined` check skipped it).
    expect(result).toEqual({ ok: false, error: 'undefined' })
  })

  it('awaits promises in the page before returning', async () => {
    const dbg = debuggerApi()
    let captured: Record<string, unknown> | undefined
    let respondedAt = 0
    let calledAt = 0
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') {
        captured = params
        calledAt = Date.now()
        // Genuinely DELAY the response, and derive the value from the
        // CAPTURED EXPRESSION: a mock that returns a hardcoded 'late' after
        // a timer would pass even if the evaluator dropped or mis-wrapped
        // the expression. Executing the exact wrapper source makes the
        // resolved value prove the expression really ran.
        const source = String(params.expression)
        const fn = new Function(`return ${source}`) as () => Promise<unknown>
        void new Promise((r) => setTimeout(r, 100)).then(() => {
          respondedAt = Date.now()
          return fn().then(
            (v) => done({ result: { value: v } }),
            (e) => done({
              result: { value: undefined },
              exceptionDetails: { text: 'Uncaught', exception: { description: e instanceof Error ? e.message : String(e) } },
            }),
          )
        })
      } else if (method === IDENTITY_PROBE) done({ frameTree: { frame: { loaderId: 'same-loader-id' } } })
      else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    // The expression itself resolves 'late' only after a 100ms timer — the
    // evaluator must await the in-page promise (awaitPromise) AND the
    // wrapper must really run it: the result cannot come from anywhere else.
    const result = await evaluateBoundExpressionViaCdp(7, "return await new Promise((r) => setTimeout(() => r('late'), 100))")
    expect(captured?.awaitPromise).toBe(true)
    // The resolved CDP value must actually come back — an evaluator that sent
    // awaitPromise but dropped the response would fail this assertion.
    expect(result).toEqual({ ok: true, result: 'late' })
    // And the evaluator must have WAITED for the delayed response: its result
    // cannot be available before the promise settled.
    expect(respondedAt).toBeGreaterThanOrEqual(calledAt + 90)
  })

  it('surfaces page exceptions as structured failures', async () => {
    const dbg = debuggerApi()
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, _params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') {
        done({
          result: { value: undefined },
          exceptionDetails: {
            text: 'Uncaught',
            exception: { description: 'TypeError: Cannot read properties of undefined (reading "x")' },
          },
        })
      } else if (method === IDENTITY_PROBE) done({ frameTree: { frame: { loaderId: 'same-loader-id' } } })
      else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await evaluateBoundExpressionViaCdp(7, 'undefined.x')
    expect(result).toEqual({ ok: false, error: 'TypeError: Cannot read properties of undefined (reading "x")' })
  })

  it('surfaces debugger transport failures reported via chrome.runtime.lastError', async () => {
    const dbg = debuggerApi()
    // Real chrome.debugger NEVER throws synchronously — a disconnected tab
    // reports the failure through the callback's chrome.runtime.lastError.
    // The mock must exercise that exact contract: set lastError, then invoke
    // the callback (with no result).
    dbg.sendCommand.mockImplementation((_target: unknown, _method: string, _params: Record<string, unknown>, done: (r?: unknown) => void) => {
      Object.defineProperty(chrome.runtime, 'lastError', {
        configurable: true,
        get: () => ({ message: 'No tab with id: 7' }),
      })
      try {
        done()
      } finally {
        Object.defineProperty(chrome.runtime, 'lastError', { configurable: true, get: () => undefined })
      }
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await evaluateBoundExpressionViaCdp(7, '1+1')
    // The evaluator must convert the transport error into the structured
    // failure shape — never throw, never resolve as ok.
    expect(result).toEqual({ ok: false, error: 'No tab with id: 7' })
  })

  it('refuses to run the expression when the frame loader id changed (reload / same-URL navigation)', async () => {
    const dbg = debuggerApi()
    const evaluated: string[] = []
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === IDENTITY_PROBE) {
        // The tab reloaded after the compile failure: the browser reports a
        // NEW loader id. Page scripts cannot influence this value.
        done({ frameTree: { frame: { loaderId: 'fresh-loader-id' } } })
      } else if (method === 'Runtime.evaluate') {
        evaluated.push(String(params.expression))
        done({ result: { value: 'should-never-run' } })
      } else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await evaluateBoundExpressionViaCdp(7, 'window.__staleMarker = true', 'original-loader-id')
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toContain('CSP_FALLBACK_STALE_DOCUMENT')
    // The user expression must never have been sent to the page.
    expect(evaluated.some((e) => e.includes('__staleMarker'))).toBe(false)
  })

  it('runs the expression when the frame loader id still matches (same document after pushState / hash change)', async () => {
    const dbg = debuggerApi()
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === IDENTITY_PROBE) {
        // pushState / location.hash changes keep the SAME document — and the
        // same loader id — so the guard must allow the fallback here even
        // though the tab's URL changed.
        done({ frameTree: { frame: { loaderId: 'same-loader-id' } } })
      } else if (method === 'Runtime.evaluate') {
        // Execute the EXACT captured source (the async-IIFE wrapper): a
        // wrapper that embeds the input as inert text resolves undefined,
        // not 'ran-in-original-document'.
        const source = String(params.expression)
        const fn = new Function(`return ${source}`) as () => Promise<unknown>
        void fn().then((v) => done({ result: { value: v } }))
      } else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await evaluateBoundExpressionViaCdp(7, "return 'ran-in-' + 'original-document'", 'same-loader-id')
    expect(result).toEqual({ ok: true, result: 'ran-in-original-document' })
  })

  it('fails closed when the frame tree reports no usable loader id', async () => {
    const dbg = debuggerApi()
    const evaluated: string[] = []
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === IDENTITY_PROBE) {
        done({ frameTree: { frame: {} } })
      } else if (method === 'Runtime.evaluate') {
        evaluated.push(String(params.expression))
        done({ result: { value: 'should-never-run' } })
      } else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await evaluateBoundExpressionViaCdp(7, 'window.__staleMarker = true', 'original-loader-id')
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toContain('CSP_FALLBACK_STALE_DOCUMENT')
    expect(evaluated.some((e) => e.includes('__staleMarker'))).toBe(false)
  })

  it('formats a thrown BigInt (no exception.description) instead of crashing on JSON.stringify', async () => {
    const dbg = debuggerApi()
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, _params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') {
        done({
          result: { value: undefined },
          exceptionDetails: {
            text: 'Uncaught',
            exception: { unserializableValue: '42n', subtype: 'bigint' },
          },
        })
      } else if (method === IDENTITY_PROBE) done({ frameTree: { frame: { loaderId: 'same-loader-id' } } })
      else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await evaluateBoundExpressionViaCdp(7, 'throw 42n')
    expect(result).toEqual({ ok: false, error: '42' })
  })

  it('formats a thrown cyclic object without a description crash', async () => {
    const dbg = debuggerApi()
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, _params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') {
        const cyclic: Record<string, unknown> = { code: 'E_CYCLIC' }
        cyclic.self = cyclic
        done({
          result: { value: undefined },
          exceptionDetails: {
            text: 'Uncaught',
            exception: { value: cyclic, subtype: 'object' },
          },
        })
      } else if (method === IDENTITY_PROBE) done({ frameTree: { frame: { loaderId: 'same-loader-id' } } })
      else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await evaluateBoundExpressionViaCdp(7, 'throw cyclic')
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toContain('E_CYCLIC')
  })

  it('preserves `arguments` and strict-mode `this` like the MAIN-world new Function path', async () => {
    const dbg = debuggerApi()
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') {
        // Execute the EXACT captured wrapper source the way Runtime.evaluate
        // would — as SCRIPT source (indirect eval), not via new Function. An
        // arrow wrapper has no own `arguments`, so at script level the body
        // throws 'arguments is not defined'; the plain async function
        // wrapper binds its own arguments object (length 0) exactly like the
        // MAIN-world new Function path called with zero args.
        const source = String(params.expression)
        void Promise.resolve().then(async () => {
          try {
            // eslint-disable-next-line no-eval
            const v = await (0, eval)(source)
            done({ result: { value: v } })
          } catch (e) {
            done({
              result: { value: undefined },
              exceptionDetails: { text: 'Uncaught', exception: { description: e instanceof Error ? e.message : String(e) } },
            })
          }
        })
      } else if (method === IDENTITY_PROBE) done({ frameTree: { frame: { loaderId: 'same-loader-id' } } })
      else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    // The MAIN-world path compiles the same body with `new Function` and
    // calls it with zero args: `arguments` is the function's own (empty)
    // arguments object. The fallback wrapper must bind the same — an arrow
    // wrapper would leave `arguments` unbound at script level and throw.
    const result = await evaluateBoundExpressionViaCdp(7, 'return arguments.length === 0 ? "bound-empty" : "bound-nonempty"', 'same-loader-id')
    expect(result).toEqual({ ok: true, result: 'bound-empty' })
  })

  it('rejects a zero / expired queue-wait budget BEFORE the lock race (no start after caller timeout)', async () => {
    // The tab is FREE (no queue) — exactly the case where Promise.race let an
    // already-resolved predecessor beat a zero-delay timer and start `fn`.
    const started: string[] = []
    await expect(withTabLock(41, async () => {
      started.push('ran')
      return 'ran'
    }, { maxQueueWaitMs: 0 })).rejects.toBeInstanceOf(TabLockWaitTimeoutError)
    await expect(withTabLock(41, async () => {
      started.push('ran')
      return 'ran'
    }, { maxQueueWaitMs: -5 })).rejects.toBeInstanceOf(TabLockWaitTimeoutError)
    // Yield a macrotask: a raced predecessor could only start `fn` async.
    await new Promise((r) => setTimeout(r, 10))
    expect(started).toEqual([])
    // A positive budget still works and cleans the queue entry up.
    await expect(withTabLock(41, async () => 'ok', { maxQueueWaitMs: 1000 })).resolves.toBe('ok')
  })

  it('refuses to dispatch anything when the caller deadline already expired', async () => {
    const dbg = debuggerApi()
    const commands: string[] = []
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, _params: Record<string, unknown>, done: (r?: unknown) => void) => {
      commands.push(method)
      done({ result: { value: null } })
    })
    dbg.attach.mockImplementation((_t: { tabId: number }, _v: string, done: Callback<void>) => done())
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    // Expired deadline: withTabLock rejects on the non-positive queue budget
    // (TabLockWaitTimeoutError) and nothing at all reaches the tab.
    await expect(
      evaluateBoundExpressionViaCdp(7, 'window.__never = true', 'loader', Date.now() - 1),
    ).rejects.toBeInstanceOf(TabLockWaitTimeoutError)
    // No Page.getFrameTree, no Runtime.evaluate — nothing reached the tab.
    expect(commands).toEqual([])
    expect(dbg.attach).not.toHaveBeenCalled()
  })

  it('does NOT dispatch Runtime.evaluate when the loader query resolves after the deadline', async () => {
    const dbg = debuggerApi()
    const evaluated: string[] = []
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === IDENTITY_PROBE) {
        // The loader query stalls past the (very short) caller deadline and
        // only then resolves — the continuation must abort, not evaluate.
        setTimeout(() => done({ frameTree: { frame: { loaderId: 'same-loader-id' } } }), 80)
      } else if (method === 'Runtime.evaluate') {
        evaluated.push(String(params.expression))
        done({ result: { value: 'should-never-run' } })
      } else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await evaluateBoundExpressionViaCdp(7, 'window.__late = true', 'same-loader-id', Date.now() + 30)
    expect(result.ok).toBe(false)
    // The run ends through the deadline path (termination confirmed before
    // the lock is released). The critical assertion is `evaluated` below:
    // the stale continuation never dispatched Runtime.evaluate.
    expect((result as { error: string }).error).toContain('timed out')
    expect(evaluated).toEqual([])
  })

  it('uses the shared caller deadline instead of a fresh evaluation window', async () => {
    const dbg = debuggerApi()
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, _params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') {
        // Never responds — only the deadline machinery can end this run.
        // (Intentionally no done() call: the callback never fires.)
      } else if (method === IDENTITY_PROBE) done({ frameTree: { frame: { loaderId: 'same-loader-id' } } })
      else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    const startedAt = Date.now()
    // The caller deadline lands ~120ms out; the default EVALUATE_DEADLINE_MS
    // would be 300s — if the evaluator restarted a fresh window, this test
    // would hang until vitest's own timeout instead of finishing in ~150ms.
    const result = await evaluateBoundExpressionViaCdp(7, 'while (true) {}', undefined, Date.now() + 120)
    const elapsed = Date.now() - startedAt
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toContain('timed out')
    expect(elapsed).toBeLessThan(5000)
  })
})
