import { parse } from '@babel/parser'

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
    // Module loading is not provided by this runtime. Detect syntax through AST,
    // not substrings, so strings and comments remain valid.
    const ast = parse(wrapCode(code), { sourceType: 'script', createImportExpressions: true })
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      const value = node as Record<string, unknown>
      if (value.type === 'ImportExpression')
        throw Object.assign(new Error('Module loading is unavailable'), {
          loc: value.loc && (value.loc as { start: unknown }).start,
        })
      for (const [key, child] of Object.entries(value)) {
        if (key === 'loc') continue
        if (Array.isArray(child)) child.forEach(visit)
        else if (child && typeof child === 'object') visit(child)
      }
    }
    visit(ast)
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
