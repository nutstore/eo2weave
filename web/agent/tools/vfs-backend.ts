import type { FsStat } from '@creatorweave/fs-provider'

/**
 * Known backend label strings for type-safe comparisons.
 */
export type BackendLabel = 'workspace' | 'agent' | 'assets' | 'skills' | 'provider'

/**
 * VFS Backend — Adapter interface for unified file I/O across storage backends.
 *
 * Tools depend on this interface instead of specific storage implementations.
 * New storage targets (assets, cloud drives, etc.) only need to implement
 * this interface — no tool changes required.
 *
 * @see weave-docs/design/assets-system.md §7
 */

/** A file or directory entry returned by listDir */
export interface VfsDirEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size?: number
  mtime?: number
}

/** Options for readFile */
export interface VfsReadOptions {
  encoding?: 'text' | 'binary'
  /** For workspace backend: read policy for dual-storage selection */
  readPolicy?: 'auto' | 'prefer_opfs' | 'prefer_native'
}

/** Options for listDir */
export interface VfsListOptions {
  recursive?: boolean
  maxDepth?: number
  includeSizes?: boolean
  includeIgnored?: boolean
  excludeDirs?: string[]
  maxEntries?: number
}

/** Options for searchDir */
export interface VfsSearchOptions {
  regex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
  maxResults?: number
  contextLines?: number
  deadlineMs?: number
  maxFileSize?: number
  includeIgnored?: boolean
  excludeDirs?: string[]
}

/** Result of a readFile operation */
export interface VfsReadResult {
  content: string | Uint8Array | ArrayBuffer | Blob
  size: number
  mimeType: string
  /** Where the content came from (backend-specific) */
  source?: string
  /** Last modified time (epoch ms), if available */
  mtime?: number
}

/**
 * Unified file I/O interface.
 *
 * Implementations encapsulate storage-specific logic:
 * - WorkspaceBackend → OPFS + native filesystem
 * - AgentBackend → AgentManager
 * - AssetsBackend → OPFS assets/ directory
 * - CloudBackend → cloud storage APIs (future)
 */
export interface VfsBackend {
  /**
   * Human-readable identifier for this backend (e.g. 'workspace', 'agent', 'assets').
   * Used by tools for backend-specific logic (pending tracking, staleness checks, etc.)
   */
  readonly label: BackendLabel

  /** Metadata without reading file contents. */
  stat?(path: string): Promise<FsStat>
  /** Create an empty directory; writes may also create parents. */
  mkdir?(path: string, options?: { recursive?: boolean }): Promise<void>

  /**
   * Read a file's content.
   * @throws if file not found
   */
  readFile(path: string, options?: VfsReadOptions): Promise<VfsReadResult>

  /**
   * Write content to a file.
   * Creates parent directories as needed.
   */
  writeFile(path: string, content: string | ArrayBuffer | Blob): Promise<void>

  /**
   * Delete a file.
   * @throws if file not found
   */
  deleteFile(path: string): Promise<void>

  /**
   * Delete a directory and all its contents recursively.
   * If the path points to a file, delegates to deleteFile.
   * @param path directory path to delete
   */
  deleteDir?(path: string): Promise<{ deletedFiles: string[]; deletedDirs: string[] }>

  /**
   * List directory contents.
   * @param path subdirectory path (empty string = root)
   */
  listDir(path: string, options?: VfsListOptions): Promise<VfsDirEntry[]>

  /**
   * Get the underlying FileSystemDirectoryHandle, if available.
   * Returns null for backends that don't support native FS handles.
   * Used by ls and search tools for their existing traversal logic.
   */
  getDirectoryHandle?(): Promise<FileSystemDirectoryHandle | null>

  /**
   * Optional: check if a file exists.
   * Backends that don't implement this will throw on readFile if not found.
   */
  exists?(path: string): Promise<boolean>
}
