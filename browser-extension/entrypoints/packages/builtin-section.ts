/**
 * Built-in section of the merged packages page (issue #193) — the packages
 * shipped inside the extension (`builtin-webmcp` mount, read-only).
 *
 * Ported from the standalone `recipes.html` entrypoint: enable / disable only;
 * config.json on this mount is read-only, so no delete is offered.
 */

import type { ManagedWebMCPPackage } from '../webmcp/package-client'
import { buildManagedCard, classifyPackage, createSection } from './shared'

export interface BuiltinSection {
  /** Render this section from a successful package load. */
  render(entries: ManagedWebMCPPackage[]): void
  /** Render ONLY this section's error — the other sections stay usable. */
  fail(error: unknown): void
}

export function createBuiltinSection(
  host: HTMLElement,
  refresh: () => void,
  summary?: HTMLElement,
): BuiltinSection {
  const shell = createSection(host, {
    id: 'builtin',
    headingKey: 'webmcpPackagesSectionBuiltin',
    hintKey: 'webmcpPackagesSectionBuiltinHint',
    summary,
  })
  return {
    render(entries) {
      shell.error.clear()
      const builtins = entries.filter(entry => classifyPackage(entry) === 'builtin')
      shell.list.replaceChildren()
      shell.setCount(builtins.length)
      if (!builtins.length) {
        shell.empty('webmcpPackagesEmptyBuiltin')
        return
      }
      for (const entry of builtins) {
        shell.list.append(buildManagedCard(entry, { source: 'builtin', error: shell.error, refresh }))
      }
    },
    fail(error) {
      shell.error.show(error)
    },
  }
}
