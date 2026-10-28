import { ensureAttached } from './cdp'
import { evaluationFunction, evaluatePage } from './evaluate'
import { BrowserError } from './errors'
import type { BrowserTask } from './task'

type EvalOutcome = {
  ok?: boolean
  message?: string
  logs?: unknown[]
  result?: unknown
  exception?: unknown
}

/**
 * Compiles and runs the evaluationFunction wrapper in the page's MAIN world.
 *
 * `new Function` here is subject to the page's CSP (strict-CSP pages reject
 * the compile, which surfaces as a failed evaluation), while the wrapper
 * itself never touches eval: chrome.scripting serializes `func` mechanically,
 * so no extension-side eval is involved. Await inside the injected function —
 * executeScript serializes results with structured clone, which cannot carry
 * a pending Promise.
 */
async function runEvalWrapper(fnSource: string): Promise<unknown> {
  const compile = new Function(`return (${fnSource})`) as () => (this: unknown) => Promise<unknown>
  return await compile().call(undefined)
}

/**
 * Does this failure mean the page's CSP refused to compile the MAIN-world
 * wrapper? Chrome surfaces it either as an executeScript rejection or as the
 * wrapper's own EvalError result. The patterns match the Function-constructor
 * compile signature specifically ("Refused to evaluate… 'unsafe-eval'… Content
 * Security Policy"), so a user function that merely throws a CSP-flavored
 * message from unrelated code is far less likely to be mistaken for a blocked
 * compile than broad keyword matches would be.
 */
export function isCspRejection(message: string): boolean {
  return /Refused to evaluate|is not an allowed source of script|Content Security Policy directive|unsafe-eval/i.test(message)
}

/**
 * Evaluate a page function without attaching the debugger, so eval-style
 * package workflows never raise Chrome's "debugging started" banner. The
 * BrowserTask deadline still bounds the call — the page execution itself
 * cannot be interrupted without CDP, only abandoned.
 *
 * Strict-CSP pages (no 'unsafe-eval') reject the MAIN-world function compile;
 * those fall back to the CDP evaluation path, which injects through the
 * debugger and is not CSP-bound. That attaches the debugger (and raises the
 * banner) — the price of evaluating at all on such pages. The scripting
 * attempt leaves no tab state behind (executeScript is stateless from the
 * extension's perspective), and the CDP fallback cleans up via the normal
 * idle auto-detach, so the result is identical either way.
 */
export async function evaluateViaScripting(task: BrowserTask, source: string): Promise<Awaited<ReturnType<typeof evaluatePage>>> {
  const tabId = task.tabId!
  // Throws synchronously on an empty source, before any injection.
  const wrapper = evaluationFunction(source)
  let outcome: EvalOutcome | undefined
  try {
    const results = await task.wait(chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: runEvalWrapper,
      args: [wrapper],
    }))
    outcome = results?.[0]?.result as EvalOutcome | undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isCspRejection(message)) {
      // The scripting attempt is stateless (nothing to clean up in the tab),
      // but the CDP path needs an attached debugger — the no-ref branch
      // normally never attaches, so ensure our session exists first.
      await ensureAttached(tabId)
      return await evaluatePage(task, source)
    }
    throw new BrowserError(message, { tabId })
  }
  if (!outcome?.ok) {
    // A CSP rejection also surfaces as a failed outcome carrying the page's
    // own EvalError message rather than an executeScript rejection.
    if (outcome && isCspRejection(outcome.message ?? '')) {
      await ensureAttached(tabId)
      return await evaluatePage(task, source)
    }
    throw new BrowserError(outcome?.message ?? 'Page evaluation failed', {
      tabId, logs: outcome?.logs ?? [], exception: outcome?.exception ?? null,
    })
  }
  return { tabId, logs: outcome.logs ?? [], result: outcome.result }
}

