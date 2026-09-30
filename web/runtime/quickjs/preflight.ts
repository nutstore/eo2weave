import { parse } from '@babel/parser'
import { assertNoModuleLoading } from '@creatorweave/shared/js-ast'
import type { ExecutionResult } from '@/runtime/quickjs/types'

export interface Diagnostic {
  line: number
  column: number
  message: string
  frame: string
}

export function wrapCode(code: string): string {
  return `(async function () {\n"use strict";\n${code}\n})()`
}

/** Parse exactly the program evaluated by QJS; locations refer to user source. */
export function preflight(code: string): Diagnostic[] {
  if (code.length > 1024 * 1024)
    return [{ line: 1, column: 1, message: 'Source exceeds 1 Mi character limit', frame: '' }]
  try {
    assertNoModuleLoading(parse(wrapCode(code), { sourceType: 'script', createImportExpressions: true }))
    return []
  } catch (error) {
    const caught = error as Error & { loc?: { line: number; column: number } }
    const lines = code.split('\n')
    const line = Math.max(1, Math.min(lines.length, (caught.loc?.line ?? 3) - 2))
    const column = (caught.loc?.column ?? 0) + 1
    return [
      {
        line,
        column,
        message: caught.message.replace(/ \(\d+:\d+\)$/, ''),
        frame: `${line} | ${lines[line - 1]}\n${' '.repeat(String(line).length + 3 + column - 1)}^`,
      },
    ]
  }
}

/** Returns a JS_PREFLIGHT_FAILED result when the source does not parse, otherwise null. */
export function preflightFailure(code: string): ExecutionResult | null {
  const diagnostics = preflight(code)
  if (!diagnostics.length) return null
  return {
    ok: false,
    error: {
      code: 'JS_PREFLIGHT_FAILED',
      message: diagnostics.map((d) => `${d.message} at ${d.line}:${d.column}\n${d.frame}`).join('\n'),
    },
  }
}
