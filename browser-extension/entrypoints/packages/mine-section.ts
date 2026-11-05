/**
 * "My packages" section of the merged packages page (issue #193) — packages
 * on the writable `webmcp` mount that no registry install record claims, i.e.
 * authored by the user or by an agent (the `cw-webmcp-creator` skill).
 *
 * Registry installs are excluded on purpose: they are managed in the registry
 * section only, so one package never has two disable switches.
 */

import type { ManagedWebMCPPackage } from '../webmcp/package-client'
import { buildManagedCard, classifyPackage, createSection } from './shared'

export interface MineSection {
  /** Render from a package load plus the registry install records. */
  render(entries: ManagedWebMCPPackage[], installedDirectories: ReadonlySet<string>): void
  /** Render ONLY this section's error — the other sections stay usable. */
  fail(error: unknown): void
}

export function createMineSection(
  host: HTMLElement,
  refresh: () => void,
  summary?: HTMLElement,
): MineSection {
  const shell = createSection(host, {
    id: 'mine',
    headingKey: 'webmcpPackagesSectionMine',
    hintKey: 'webmcpPackagesSectionMineHint',
    summary,
  })
  return {
    render(entries, installedDirectories) {
      shell.error.clear()
      // Registry-installed packages must NOT reappear here: their own row in
      // the registry section already owns enable/remove.
      // `installedDirectories` holds the install DIRECTORY names, which is the
      // install identity `classifyPackage` matches on.
      const mine = entries.filter(entry => classifyPackage(entry, installedDirectories) === 'mine')
      shell.list.replaceChildren()
      shell.setCount(mine.length)
      if (!mine.length) {
        shell.empty('webmcpPackagesEmptyMine')
        return
      }
      for (const entry of mine) {
        shell.list.append(buildManagedCard(entry, {
          source: 'mine',
          error: shell.error,
          refresh,
          // The rw mount is deletable, except for a package discovered as
          // read-only (the mount decides, not the section).
          deletable: entry.access === 'read-write',
        }))
      }
    },
    fail(error) {
      shell.error.show(error)
    },
  }
}
