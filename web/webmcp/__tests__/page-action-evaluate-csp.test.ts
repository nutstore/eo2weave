// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isCspCompileRejection } from '../../../browser-extension/lib/bash-commands/browser/csp-rejection'
import { evaluateBoundExpressionViaCdp } from '../../../browser-extension/lib/bash-commands/browser/cdp-evaluate'
import { clearDebuggerState } from '../../../browser-extension/lib/bash-commands/browser/cdp'

/**
 * Issue #106: the page-action runner's `evaluate` action compiles arbitrary JS
 * with `new Function` in the page's MAIN world, which strict-CSP pages refuse.
 * The runner tags compile-stage failures; the background handler falls back to
 * the CSP-exempt CDP path. These tests cover the shared detection helper and
 * the CDP fallback evaluator (the same primitives the #105 scripting route
 * uses), including the no-double-run guarantee for user-code errors.
 */

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
  it('attaches the debugger and returns the by-value result', async () => {
    const dbg = debuggerApi()
    let capturedExpression: unknown
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') {
        capturedExpression = params.expression
        done({ result: { value: 'page-title' } })
      } else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await evaluateBoundExpressionViaCdp(7, 'document.title')
    expect(result).toEqual({ ok: true, result: 'page-title' })
    expect(dbg.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3', expect.any(Function))
    expect(dbg.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 7 }),
      'Runtime.evaluate',
      expect.objectContaining({ returnByValue: true, awaitPromise: true }),
      expect.any(Function),
    )
    // The caller's expression must actually reach Runtime.evaluate — the
    // body-wrapper IIFE must CONTAIN it verbatim, not just any expression.
    expect(typeof capturedExpression).toBe('string')
    expect(capturedExpression as string).toContain('document.title')
  })

  it('wraps function-body syntax (return / top-level await) so it parses as a script', async () => {
    const dbg = debuggerApi()
    let captured: Record<string, unknown> | undefined
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') {
        captured = params
        done({ result: { value: 'the-title' } })
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
    // wrapper must make it legal again.
    const result = await evaluateBoundExpressionViaCdp(7, 'return document.title')
    expect(result).toEqual({ ok: true, result: 'the-title' })
    const expr = String(captured?.expression)
    expect(expr.startsWith('(async () => {')).toBe(true)
    expect(expr).toContain('return document.title')
    expect(expr.trimEnd().endsWith('})()')).toBe(true)
  })

  it('maps unserializable results (NaN / Infinity / -0 / BigInt) back to JS values', async () => {
    const dbg = debuggerApi()
    const cases: Array<{ unserializableValue: string; expected: unknown }> = [
      { unserializableValue: 'NaN', expected: Number.NaN },
      { unserializableValue: 'Infinity', expected: Number.POSITIVE_INFINITY },
      { unserializableValue: '-Infinity', expected: Number.NEGATIVE_INFINITY },
      { unserializableValue: '-0', expected: -0 },
      { unserializableValue: '42n', expected: BigInt(42) },
    ]
    for (const c of cases) {
      dbg.sendCommand.mockImplementation((_target: unknown, method: string, _params: Record<string, unknown>, done: (r?: unknown) => void) => {
        if (method === 'Runtime.evaluate') done({ result: { unserializableValue: c.unserializableValue } })
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
      if (typeof c.expected === 'number' && Number.isNaN(c.expected as number)) {
        expect((result as { ok: boolean; result?: unknown }).ok).toBe(true)
        expect((result as { result?: unknown }).result).toBeNaN()
      } else {
        expect(result).toEqual({ ok: true, result: c.expected })
      }
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
      } else done({ result: { value: null } })
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

  it('awaits promises in the page before returning', async () => {
    const dbg = debuggerApi()
    let captured: Record<string, unknown> | undefined
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') {
        captured = params
        done({ result: { value: 'late' } })
      } else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    await evaluateBoundExpressionViaCdp(7, '(async () => "late")()')
    expect(captured?.awaitPromise).toBe(true)
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
      } else done({ result: { value: null } })
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

  it('surfaces debugger transport failures instead of throwing', async () => {
    const dbg = debuggerApi()
    dbg.sendCommand.mockImplementation((_target: unknown, _method: string, _params: Record<string, unknown>, _done: (r?: unknown) => void) => {
      // chrome.debugger never calls back on a disconnected tab until lastError
      // is set — simulate the error path by never invoking done while the
      // cdp wrapper surfaces a rejection via the error callback contract.
      void _done
      throw new Error('No tab with id: 7')
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await evaluateBoundExpressionViaCdp(7, '1+1')
    expect(result).toEqual({ ok: false, error: 'No tab with id: 7' })
  })

  it('refuses to run the expression when the document identity changed (reload / same-URL navigation)', async () => {
    const dbg = debuggerApi()
    const evaluated: string[] = []
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') {
        evaluated.push(String(params.expression))
        // The identity probe resolves; the CURRENT document reports a FRESH
        // docId — i.e. the tab reloaded (same URL) after the compile failure.
        if (String(params.expression).includes('__cwPageAction')) {
          done({ result: { value: 'fresh-doc-id' } })
        } else {
          done({ result: { value: 'should-never-run' } })
        }
      } else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await evaluateBoundExpressionViaCdp(7, 'window.__staleMarker = true', 'original-doc-id')
    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toContain('CSP_FALLBACK_STALE_DOCUMENT')
    // The user expression must never have been sent to the page.
    expect(evaluated.some((e) => e.includes('__staleMarker'))).toBe(false)
  })

  it('runs the expression when the document identity still matches', async () => {
    const dbg = debuggerApi()
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') {
        if (String(params.expression).includes('__cwPageAction')) {
          done({ result: { value: 'same-doc-id' } })
        } else {
          done({ result: { value: 'ran-in-original-document' } })
        }
      } else done({ result: { value: null } })
    })
    vi.stubGlobal('chrome', {
      debugger: dbg,
      tabs: tabsApi(),
      storage: storageApi(),
      runtime: { onDetach: dbg.onDetach },
    })
    const result = await evaluateBoundExpressionViaCdp(7, 'document.title', 'same-doc-id')
    expect(result).toEqual({ ok: true, result: 'ran-in-original-document' })
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
      } else done({ result: { value: null } })
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
      } else done({ result: { value: null } })
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
})
