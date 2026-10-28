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
    dbg.sendCommand.mockImplementation((_target: unknown, method: string, _params: Record<string, unknown>, done: (r?: unknown) => void) => {
      if (method === 'Runtime.evaluate') done({ result: { value: 'page-title' } })
      else done({ result: { value: null } })
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
})
