/// <reference types="chrome" />
import { ensureAttached, sendCommand } from './cdp'

/**
 * Evaluate an expression in the page's MAIN world through the CDP debugger
 * path, which injects via the debugger and is NOT bound by the page's CSP.
 *
 * This is the fallback for strict-CSP pages (#106): `new Function`-based
 * compilation in the MAIN world is refused there, while CDP `Runtime.evaluate`
 * compiles internally without going through the page's Function constructor.
 * Callers may only reach this after a tagged compile-stage failure (see
 * page-action-runner.content.ts / scripting-eval.ts) — the compile refusal is
 * thrown BEFORE any user code runs, so the expression is provably
 * side-effect-free and a re-run cannot duplicate effects.
 *
 * Like the browser.eval fallback, this attaches the debugger (Chrome shows the
 * "debugging started" banner); the normal idle auto-detach clears it when the
 * tab goes quiet. Structured-clone-safe results only (returnByValue) — the
 * page-action bridge cannot carry remote object handles anyway.
 */
export async function evaluateBoundExpressionViaCdp(
  tabId: number,
  expression: string,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  await ensureAttached(tabId)
  try {
    const response = await sendCommand<{
      result?: { value?: unknown }
      exceptionDetails?: {
        text?: string
        exception?: { description?: string; value?: unknown }
      }
    }>(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (response.exceptionDetails) {
      const d = response.exceptionDetails
      return {
        ok: false,
        error: d.exception?.description ?? d.text ?? 'Page execution failed',
      }
    }
    return { ok: true, result: response.result?.value }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
