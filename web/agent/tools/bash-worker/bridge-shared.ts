/**
 * Shared constants, types, and pure functions used by both:
 * - `VfsBridgeFs` (main thread, delegates to real VfsBackend instances)
 * - `WorkerVfsBridgeFs` (worker thread, delegates via RPC to main thread)
 *
 * Extracting these avoids code duplication while keeping each FS class
 * independent and testable.
 */

// ---------------------------------------------------------------------------
// Mount points (must stay in sync across main + worker)
// ---------------------------------------------------------------------------

/** Absolute path prefix inside just-bash's virtual FS where we mount the workspace. */
export const WORKSPACE_MOUNT = '/workspace'

/** Mount point for assets (user-uploaded / agent-generated files). */
export const ASSETS_MOUNT = '/assets'

/** Mount point for agent namespace files (vfs://agents/<agentId>/...). */
export const AGENTS_MOUNT = '/agents'

/** System paths served from in-memory map, never forwarded to VFS backend. */
export const SYSTEM_PREFIXES = ['/bin', '/usr', '/home', '/tmp', '/dev', '/proc', '/etc']

export const DEFAULT_FILE_MODE = 0o644
export const DEFAULT_DIR_MODE = 0o755

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FsStat {
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
  mode: number
  size: number
  mtime: Date
}

export interface DirentEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}

export interface SysFile {
  type: 'file'
  content: Uint8Array
  mode: number
  mtime: Date
}

export interface SysDir {
  type: 'directory'
  mode: number
  mtime: Date
}

export type SysEntry = SysFile | SysDir

// ---------------------------------------------------------------------------
// Path utilities (pure functions)
// ---------------------------------------------------------------------------

/** Normalize an absolute path: resolve '.', '..', collapse multiple slashes. */
export function normalizeAbsolutePath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '..') resolved.pop()
    else if (part !== '.') resolved.push(part)
  }
  return '/' + resolved.join('/')
}

/** Get the parent directory of an absolute path. */
export function dirnameOf(path: string): string {
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= 1) return '/'
  return '/' + parts.slice(0, -1).join('/')
}

/** Check if a path is under a system prefix (/bin, /usr, etc.). */
export function isSystemPath(path: string): boolean {
  const normalized = path.startsWith('/') ? path : normalizeAbsolutePath(path)
  if (normalized === '/') return true
  return SYSTEM_PREFIXES.some(p => normalized === p || normalized.startsWith(p + '/'))
}

/** Check if a path is under /assets. */
export function isAssetsPath(path: string): boolean {
  const normalized = path.startsWith('/') ? path : normalizeAbsolutePath(path)
  return normalized === ASSETS_MOUNT || normalized.startsWith(ASSETS_MOUNT + '/')
}

/** Check if a path is under /agents. */
export function isAgentsPath(path: string): boolean {
  const normalized = path.startsWith('/') ? path : normalizeAbsolutePath(path)
  return normalized === AGENTS_MOUNT || normalized.startsWith(AGENTS_MOUNT + '/')
}

/**
 * Convert /workspace/<rootName>/path → "<rootName>/path"
 *         /workspace/<rootName>      → "<rootName>"
 *         /workspace                  → "" (root listing)
 */
export function toWorkspaceRelative(absPath: string): string {
  let rel = absPath
  if (rel.startsWith(WORKSPACE_MOUNT + '/')) {
    rel = rel.slice(WORKSPACE_MOUNT.length + 1)
  } else if (rel === WORKSPACE_MOUNT) {
    rel = ''
  }
  return rel.replace(/^\/+/, '')
}

/** Convert /assets/foo/bar → "foo/bar", /assets → "" */
export function toAssetsRelative(absPath: string): string {
  let rel = absPath
  if (rel.startsWith(ASSETS_MOUNT + '/')) {
    rel = rel.slice(ASSETS_MOUNT.length + 1)
  } else if (rel === ASSETS_MOUNT) {
    rel = ''
  }
  return rel.replace(/^\/+/, '')
}

/** Convert /agents/foo/bar → "foo/bar", /agents → "" */
export function toAgentsRelative(absPath: string): string {
  let rel = absPath
  if (rel.startsWith(AGENTS_MOUNT + '/')) {
    rel = rel.slice(AGENTS_MOUNT.length + 1)
  } else if (rel === AGENTS_MOUNT) {
    rel = ''
  }
  return rel.replace(/^\/+/, '')
}

// ---------------------------------------------------------------------------
// Encoding utilities
// ---------------------------------------------------------------------------

/** Normalize encoding option to 'binary' | 'text'. */
export function normalizeWriteEncoding(options?: { encoding?: string } | string): 'binary' | 'text' {
  const encoding = typeof options === 'string' ? options : options?.encoding
  return encoding === 'binary' ? 'binary' : 'text'
}

/**
 * Convert a latin1-shaped string to a Uint8Array (inverse of just-bash's
 * `unsafeBytesFromLatin1`). Each JS char's low byte = one file byte.
 *
 * ONLY safe for latin1-shaped strings produced by just-bash's binary pipeline.
 * Using it on a real UTF-16 string would silently corrupt multi-byte chars.
 */
export function latin1StringToBytes(content: string): Uint8Array {
  const bytes = new Uint8Array(content.length)
  for (let i = 0; i < content.length; i++) {
    bytes[i] = content.charCodeAt(i) & 0xff
  }
  return bytes
}

/** Convert a Uint8Array to a latin1-shaped string (for RPC serialization). */
export function bytesToLatin1String(bytes: Uint8Array): string {
  let str = ''
  // Chunk to avoid call stack limits on large arrays
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    str += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[])
  }
  return str
}

/** Encode a UTF-8 string to Uint8Array. */
export function utf8Encode(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

/** Decode a Uint8Array to UTF-8 string. */
export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}
