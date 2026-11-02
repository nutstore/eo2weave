/// <reference types="chrome" />
// Shared CSP-rejection detection for MAIN-world dynamic compilation.
//
// PR #105 introduced this for the browser.eval scripting path; issue #106
// extends the same approach to the page-action runner's `evaluate` action.
// Both compile arbitrary strings with `new Function` inside the page's MAIN
// world, so strict-CSP pages (no 'unsafe-eval') reject the COMPILATION —
// before any user code has run — which makes a fallback re-run through the
// CSP-exempt CDP path safe (the expression cannot have produced side effects
// yet). The strict prefix matching exists because Chrome surfaces unrelated
// injection errors (blocked chrome:// targets, disconnected tabs) with
// messages that cannot be told apart from a CSP refusal by shape.

/**
 * The exact Function-constructor CSP wording Chrome uses, and its EvalError-
 * prefixed form (some Chrome versions deliver the refusal as the result of
 * the injected function instead of an executeScript rejection).
 */
const CSP_COMPILE_PREFIXES = [
    "Refused to evaluate a string as JavaScript because 'unsafe-eval'",
]

export function isCspCompileRejection(message: string): boolean {
    const normalized = message.trim()
    return CSP_COMPILE_PREFIXES.some(
        prefix => normalized.startsWith(prefix) || normalized.startsWith(`EvalError: ${prefix}`),
    )
}
