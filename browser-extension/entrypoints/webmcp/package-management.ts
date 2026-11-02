import { FsError, normalizeProviderPath } from '@creatorweave/fs-provider'
import { parseWebMCPConfig, serializeWebMCPConfig } from '@creatorweave/shared/webmcp-config'
import { readWebMCPCatalog } from './package-repository'
import { setBuiltinConfig } from './builtin-storage'
import { withPackageLock } from './package-lock'

/** UI and execution read the same catalog; source code is fetched only on request. */
export function createPackageManagement(
  writeUser: (message: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; code?: string }>,
  changed: () => Promise<void>,
) {
  return async (message: Record<string, unknown>) => {
    try {
      if (message.type === 'webmcp_packages_list') {
        const entries = await readWebMCPCatalog()
        return { ok: true, entries: entries.map(({ package: pkg, ...entry }) => ({ ...entry, manifest: pkg?.manifest ?? null })) }
      }
      if (!['webmcp_packages_set_config', 'webmcp_packages_delete'].includes(String(message.type))) throw new FsError('EINVAL', 'Unknown package operation')
      if (typeof message.directory !== 'string' || normalizeProviderPath(message.directory) !== message.directory || message.directory.includes('/'))
        throw new FsError('EINVAL', 'Expected a package directory')
      if (!['webmcp', 'builtin-webmcp'].includes(String(message.mount))) throw new FsError('EINVAL', 'Unknown mount')
      const entry = (await readWebMCPCatalog()).find(entry => entry.directory === message.directory && entry.mount === message.mount)
      if (!entry) throw new FsError('ENOENT', 'Package not found')
      // SECURITY (round-3 finding: "Management mutations bypass package
      // lock"): a management-page delete or config write must hold the SAME
      // per-package cross-context lease installs, uninstalls and opt-in
      // enables use — otherwise it interleaves with a running install/
      // uninstall on the same directory and leaves the package missing,
      // torn, or in the wrong activation state.
      if (message.type === 'webmcp_packages_delete') {
        if (entry.mount !== 'webmcp' || entry.access !== 'read-write') throw new FsError('EROFS', 'Built-in packages cannot be deleted')
        return await withPackageLock(entry.directory, async signal =>
          writeUser({ method: 'remove', path: entry.directory, recursive: true, signal }),
        )
      }
      const config = parseWebMCPConfig(message.config)
      if (config.activation === 'enabled' && (!entry.package || entry.diagnostics.some(error => !error.startsWith('config.json:'))))
        throw new FsError('EINVAL', 'Cannot enable an invalid or conflicting package')
      if (entry.access === 'read-only') {
        // Builtin overrides live in chrome.storage.local under the directory
        // name — same lease key, so builtin and user operations on one
        // package serialize against each other too. The builtin write is a
        // single atomic storage call — nothing to interleave, but an aborted
        // transaction still fails instead of reporting success (finding:
        // "Lost lease does not stop mutations").
        return await withPackageLock(entry.directory, async signal => {
          if (signal.aborted) throw new FsError('EACCES', 'The package lease was lost mid-transaction')
          await setBuiltinConfig(entry.directory, config)
          // The configuration commit succeeded; do not report a failed write if route refresh fails.
          await changed().catch(error => console.warn('[WebMCP catalog]', error))
          return { ok: true }
        })
      }
      return await withPackageLock(entry.directory, async signal => {
        if (signal.aborted) throw new FsError('EACCES', 'The package lease was lost mid-transaction')
        const result = await writeUser({ method: 'writeFile', path: `${entry.directory}/config.json`, content: btoa(serializeWebMCPConfig(config)), signal })
        if (!result.ok) return result
        return { ok: true }
      })
    } catch (error) {
      return { ok: false, code: (error as { code?: string }).code ?? 'EINVAL', error: error instanceof Error ? error.message : String(error) }
    }
  }
}
