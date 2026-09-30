/**
 * Throws at the first dynamic import() or import.meta in a Babel AST. Neither
 * runtime provides a module loader; checking the AST (not substrings) keeps
 * strings and comments that mention import() valid. The thrown error carries
 * the node's start location as `loc`.
 */
export function assertNoModuleLoading(node: unknown): void {
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
