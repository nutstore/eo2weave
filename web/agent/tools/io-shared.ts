/**
 * Shared helpers for read.tool.ts and write.tool.ts.
 * Extracted from io.tool.ts during split — no logic changes.
 */

import { withVfsAgentIdHint } from './vfs-resolver'

//-----------------------------------------------------------------------------
// Known binary file extensions
//-----------------------------------------------------------------------------

/**
 * File extensions that are definitively binary and should never be decoded as text.
 * Files with these extensions will be rejected immediately without trying TextDecoder.
 */
const BINARY_EXTENSIONS = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.heic', '.heif',
  '.tiff', '.tif', '.raw', '.psd', '.ai', '.eps', '.ico', '.cur',
  // Audio
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.wma', '.m4a', '.opus', '.mid', '.midi',
  // Video
  '.mp4', '.avi', '.mov', '.mkv', '.webm', '.wmv', '.flv', '.m4v', '.3gp', '.ogv',
  // Compressed / archive
  '.zip', '.gz', '.tar', '.rar', '.7z', '.bz2', '.xz', '.zst', '.lz', '.lzma',
  '.cab', '.iso', '.dmg', '.deb', '.rpm', '.apk', '.jar', '.war', '.ear',
  // Documents (binary formats)
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.rtf',
  // Fonts
  '.ttf', '.otf', '.eot', '.woff', '.woff2',
  // Executable / system
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite', '.mdb',
  '.wasm', '.o', '.obj', '.pyc', '.pyd', '.class', '.dex', '.nupkg',
  // Other binary
  '.pkl', '.pickle', '.npy', '.npz', '.h5', '.hdf5', '.parquet', '.feather',
  '.snappy', '.zlib', '.proto', '.pb',
])

/**
 * Check if a file path has a known binary extension.
 */
export function isKnownBinaryExtension(path: string): boolean {
  // Dotfiles (e.g. .gitignore, .env, .babelrc) are almost always plain text
  const basename = path.substring(path.lastIndexOf('/') + 1)
  if (basename.startsWith('.')) return false

  const dotIndex = path.lastIndexOf('.')
  if (dotIndex === -1 || dotIndex === path.length - 1) return false
  const ext = path.substring(dotIndex).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

/**
 * Try to decode binary content as UTF-8 text.
 * Returns the decoded string, or null if the content looks like genuine binary
 * (contains null bytes in the first ~8KB).
 */
export function tryDecodeAsText(data: ArrayBuffer | Uint8Array): string | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.length === 0) return ''

  // Quick check: scan the first 8KB for null bytes.
  // Real text files almost never contain 0x00.
  const checkLen = Math.min(bytes.length, 8192)
  for (let i = 0; i < checkLen; i++) {
    if (bytes[i] === 0) return null
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * Extract a stable resolved path string for loop guard tracking.
 * For workspace targets: uses the resolved absolute path.
 * For agent targets: constructs a synthetic path for tracking.
 */
export function getResolvedPathForLoopGuard(target: Awaited<ReturnType<typeof import('./vfs-resolver').resolveVfsTarget>>): string {
  if (target.kind === 'workspace') {
    return target.path
  }
  if (target.kind === 'skills') {
    return `vfs://skills/${target.path}`
  }
  if (target.kind === 'assets') {
    return `vfs://${target.kind}/${target.path}`
  }
  if (target.kind === 'external') return `vfs://external/${target.mountName}/${target.path}`
  return `vfs://agents/${target.agentId}/${target.path}`
}

export function formatToolErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return withVfsAgentIdHint(raw)
}
