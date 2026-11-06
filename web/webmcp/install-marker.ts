/**
 * Install provenance marker (issue #228 / #231) — web-side mirror of the
 * extension module. The two installers are deliberately kept equivalent
 * (issue #117), so the marker format and its three-way read contract are
 * duplicated rather than imported across the bundle boundary.
 *
 * A WebMCP package directory on the `webmcp` mount can hold either a package
 * the user (or an agent) authored, or one this extension installed from a
 * registry. Nothing in the package's own files distinguishes the two: the
 * installer writes the package verbatim, so an authored package laid out as
 * `<id>/manifest.json` (`id` == directory name) is byte-identical in shape to
 * an install. The page used to infer provenance from that shape, which made
 * it offer a registry row's uninstall action for an authored package.
 *
 * The installer now records provenance in the package directory itself. The
 * marker lives and dies with the package — it is not a second state store,
 * and a delete removes it along with everything else.
 */
import type { FsProvider } from '@creatorweave/fs-provider'

/** Dot-prefixed so package tooling and file listings ignore it. */
export const INSTALL_MARKER_FILE = '.webmcp-install.json'

export interface InstallMarker {
  schemaVersion: 1
  /** Registry manifest URL the package came from. */
  registryId: string
  packageId: string
  version: string
  /** ISO timestamp of the successful install. */
  installedAt: string
}

/** Serialize a marker for writing. */
export function encodeInstallMarker(marker: InstallMarker): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(marker, null, 2))
}

/**
 * Parse a marker read back from disk. Returns `null` for anything that is not
 * a current-schema marker: a corrupt or foreign file must not turn an authored
 * package into a registry install.
 */
export function parseInstallMarker(bytes: Uint8Array): InstallMarker | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const marker = parsed as Partial<InstallMarker>
  if (marker.schemaVersion !== 1) return null
  if (typeof marker.registryId !== 'string' || !marker.registryId) return null
  if (typeof marker.packageId !== 'string' || !marker.packageId) return null
  if (typeof marker.version !== 'string') return null
  if (typeof marker.installedAt !== 'string') return null
  return marker as InstallMarker
}

function isAbsent(error: unknown): boolean {
  const code = (error as { code?: string }).code
  const name = (error as { name?: string }).name
  return code === 'ENOENT' || name === 'NotFoundError'
}

/**
 * Three-way answer for one directory. 'absent' is the only state that means
 * "this package was not installed by us" — a present-but-unreadable marker is
 * 'invalid', because it might belong to an install and the caller must not
 * treat it as authored (which would offer a delete).
 */
export type InstallMarkerState =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'ok'; marker: InstallMarker }

/**
 * Read the marker state of one package directory.
 *
 * Storage errors other than a confirmed absence are rethrown: answering
 * "authored" on a transient read failure would hand the registry row's
 * uninstall action to a package it does not own.
 */
export async function readInstallMarkerState(
  provider: FsProvider,
  directory: string,
): Promise<InstallMarkerState> {
  let bytes: Uint8Array
  try {
    bytes = await provider.readFile(`${directory}/${INSTALL_MARKER_FILE}`)
  } catch (error) {
    if (isAbsent(error)) return { kind: 'absent' }
    throw error
  }
  const marker = parseInstallMarker(bytes)
  return marker ? { kind: 'ok', marker } : { kind: 'invalid' }
}

/** The marker of one package directory, or `null` when absent or invalid. */
export async function readInstallMarker(
  provider: FsProvider,
  directory: string,
): Promise<InstallMarker | null> {
  const state = await readInstallMarkerState(provider, directory)
  return state.kind === 'ok' ? state.marker : null
}
