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
 * Evaluate a page function without attaching the debugger, so eval-style
 * package workflows never raise Chrome's "debugging started" banner. The
 * BrowserTask deadline still bounds the call: on timeout/cancel the caller
 * stops waiting, but unlike the CDP path (Runtime.terminateExecution) the
 * injected execution itself cannot be interrupted without a debugger — it
 * is abandoned. Read-style evals (the builtin packages' only no-ref usage)
 * settle on their own; a long-running page function would keep running in
 * the tab until it finishes.
 *
 * Strict-CSP pages (no 'unsafe-eval') reject the MAIN-world function compile;
 * those fall back to the CDP evaluation path, which injects through the
 * debugger and is not CSP-bound. That attaches the debugger (and raises the
 * banner) — the price of evaluating at all on such pages.
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
    if (/Content script|cannot be parsed|unsafe-eval|violates.{0,40}Content Security Policy/i.test(`${message} ${wrapper}`)) {
      await ensureAttached(tabId)
      return await evaluatePage(task, source)
    }
    throw new BrowserError(message, { tabId })
  }
  if (!outcome?.ok) {
    // A CSP rejection also surfaces as a failed outcome (the page's own error),
    // not an executeScript rejection — fall back on those signatures too.
    const message = outcome?.message ?? ''
    if (/EvalError|Content Security Policy|unsafe-eval|call: Function|forbidden/i.test(message)) {
      await ensureAttached(tabId)
      return await evaluatePage(task, source)
    }
    throw new BrowserError(message || 'Page evaluation failed', {
      tabId, logs: outcome?.logs ?? [], exception: outcome?.exception ?? null,
    })
  }
  return { tabId, logs: outcome.logs ?? [], result: outcome.result }
}
