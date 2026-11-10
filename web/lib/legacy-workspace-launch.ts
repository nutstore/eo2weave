/** Preserve extension and installed-PWA entry URLs that historically used `/`. */
export function legacyWorkspaceLaunch(search: string, hash: string, standalone = false): string | null {
  const query = new URLSearchParams(search)
  const index = hash.indexOf('?')
  const hashQuery = new URLSearchParams(index < 0 ? '' : hash.slice(index + 1))
  if (standalone || query.get('source') === 'side_panel' || hashQuery.get('source') === 'side_panel' || query.get('new') === 'true') {
    return `/projects${search}${hash}`
  }
  return null
}
