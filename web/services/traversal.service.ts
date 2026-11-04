import { isGitIgnored, type GitIgnoreRule } from '@/opfs/native-disk/gitignore-policy'
import { readHandleIgnoreRules } from '@/vfs/gitignore-discovery'

/**
 * Default excluded directory names (keep in sync with search.worker.ts)
 */
const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
  '.turbo',
  '.pnpm-store',
])

/**
 * File metadata
 */
export interface FileMetadata {
  name: string
  size: number
  type: 'file' | 'directory'
  lastModified: number
  path: string
}

/**
 * Traverse directory options
 */
export interface TraverseOptions {
  /** Use worker for traversal (default: true) */
  useWorker?: boolean
  /** Maximum files to traverse (0 = unlimited) */
  maxFiles?: number
  /** Progress callback */
  onProgress?: (current: string, count: number) => void
}

/**
 * Traverse directory options (extended version for backward compat)
 */
interface InternalTraverseOptions extends TraverseOptions {
  /** Current path for recursion */
  _path?: string
  _rules?: GitIgnoreRule[]
}

/**
 * Traverse directory recursively using async generator.
 * Uses a worker by default to avoid blocking the main thread.
 *
 * @param dirHandle - Directory handle to traverse
 * @param options - Options including path and traversal settings
 * @yields FileMetadata for each file found
 *
 * @example
 * // Basic usage (uses worker)
 * for await (const item of traverseDirectory(handle)) {
 *   console.log(item.path)
 * }
 *
 * @example
 * // With options
 * for await (const item of traverseDirectory(handle, {
 *   maxFiles: 1000,
 *   onProgress: (path, count) => console.log(`${count}: ${path}`)
 * })) {
 *   console.log(item.path)
 * }
 */
export async function* traverseDirectory(
  dirHandle: FileSystemDirectoryHandle,
  options?: string | InternalTraverseOptions
): AsyncGenerator<FileMetadata> {
  // Normalize arguments: support legacy (dirHandle, path) and new (dirHandle, options)
  const basePath = typeof options === 'string' ? options : (options?._path ?? '')
  const opts: InternalTraverseOptions = typeof options === 'string' ? {} : (options ?? {})

  const useWorker = opts.useWorker ?? true

  // Use worker-based traversal for non-blocking operation
  if (useWorker) {
    try {
      const { traverseDirectoryInWorker } = await import('@/workers/traversal-worker-manager')
      let count = 0
      for await (const item of traverseDirectoryInWorker(dirHandle, basePath)) {
        if (opts.maxFiles && opts.maxFiles > 0 && count >= opts.maxFiles) {
          break
        }
        opts.onProgress?.(item.path, count + 1)
        count++
        yield item
      }
      return
    } catch (error) {
      // Fallback to main thread traversal if worker fails
      console.warn('[traverseDirectory] Worker failed, falling back to main thread:', error)
    }
  }

  // Original main thread traversal (fallback)
  try {
    let count = 0
    const entries: Array<[string, FileSystemHandle]> = []
    for await (const entry of dirHandle.entries()) entries.push(entry)
    const rules = await readHandleIgnoreRules(entries.map(([, handle]) => handle), basePath, opts._rules ?? [], false)
    for (const entry of entries) {
      if (opts.maxFiles && opts.maxFiles > 0 && count >= opts.maxFiles) {
        break
      }

      const [, handle] = entry
      const entryPath = basePath ? `${basePath}/${handle.name}` : handle.name
      if (isGitIgnored(entryPath, rules)) continue

      if (handle.kind === 'file') {
        try {
          const file = await handle.getFile()
          opts.onProgress?.(entryPath, count + 1)
          count++
          yield {
            name: file.name,
            size: file.size,
            type: 'file',
            lastModified: file.lastModified,
            path: entryPath,
          }
        } catch (error) {
          // Skip files that cannot be accessed
          console.warn(`Skipping ${entryPath}:`, error)
          continue
        }
      } else if (handle.kind === 'directory') {
        // Skip excluded directories (node_modules, .git, etc.)
        if (DEFAULT_EXCLUDED_DIRS.has(handle.name)) continue

        // Yield directory metadata first
        yield {
          name: handle.name,
          size: 0, // Directories don't have a size
          type: 'directory',
          lastModified: 0,
          path: entryPath,
        }
        // Recursively traverse subdirectories
        yield* traverseDirectory(handle as FileSystemDirectoryHandle, { ...opts, _path: entryPath, _rules: rules, useWorker: false })
      }
    }
  } catch (error) {
    console.warn(`Error accessing directory:`, error)
    throw error
  }
}
