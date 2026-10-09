import { parse } from '@babel/parser'
import type { ExecutionResult } from './types'

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

/**
 * Throws at the first dynamic import() or import.meta in a Babel AST. The
 * runtime provides a module loader; checking the AST (not substrings) keeps
 * strings and comments that mention import() valid. The thrown error carries
 * the node's start location as `loc`.
 */
function assertNoModuleLoading(node: unknown): void {
  if (!node || typeof node !== 'object') return
  const value = node as Record<string, unknown> & { loc?: { start: unknown }; meta?: { name?: string } }
  if (value.type === 'ImportExpression' || (value.type === 'MetaProperty' && value.meta?.name === 'import'))
    throw Object.assign(new Error('Module imports and import.meta are unavailable'), { loc: value.loc?.start })
  for (const [key, child] of Object.entries(value)) {
    if (key === 'loc') continue
    if (Array.isArray(child)) child.forEach(assertNoModuleLoading)
    else assertNoModuleLoading(child)
  }
}
