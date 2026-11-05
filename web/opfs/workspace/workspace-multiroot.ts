/**
 * Workspace Multi-Root Path Resolution
 *
 * Standalone implementations of WorkspaceRuntime's multi-root path
 * resolution / native-host disk access methods. Each function takes the
 * runtime instance (via the WorkspaceRuntimeInternals bridge interface)
 * as its first parameter; the class methods on WorkspaceRuntime are
 * one-line delegates.
 *
 * Cross-method calls go through the runtime instance (rt.method()) so
 * instance-level overrides keep working exactly as before extraction.
 */

import type { FileContent, FileMetadata } from '../types/opfs-types'
import { getRuntimeDirectoryHandle, getRuntimeHandlesForProject, buildHandleKey } from '@/native-fs'
import type { DiskExecutor } from '../native-disk/executor'
import { isGitIgnored, parseGitIgnore, type GitIgnoreRule } from '@/opfs/native-disk/gitignore-policy'

/**
 * Result of resolving a workspace-relative path to a specific root.
 *
 * Multi-root workspace paths follow the pattern: `{rootName}/{relativePath}`
 * If no root prefix matches a known root, the first root is used.
 */
export interface ResolvedRoot {
  /** Root name (matches project_roots.name) */
  rootName: string
  /** Persisted executor address: compound FS Access key or Native Host scope ID. */
  rootId: string | null
  /** Authorization backend for this root. */
  backend: 'fsaccess' | 'native-host'
  /** Path relative to the root (after stripping the root prefix) */
  relativePath: string
  /** Whether this root is read-only */
  readOnly: boolean
}

/** Entry stored in the runtime's cached root map. */
export interface RootMapEntry {
  readOnly: boolean
  isDefault: boolean
  backend: 'fsaccess' | 'native-host'
  rootId: string | null
}

/**
 * Internal bridge onto WorkspaceRuntime's private multi-root state and
 * delegate methods. The class delegates cast `this` to this interface so
 * the standalone implementations can access the fields/methods they need.
 */
export interface WorkspaceRuntimeInternals {
  readonly workspaceId: string
  /** Cached projectId for this workspace (undefined = not yet resolved) */
  _cachedProjectId: string | null | undefined
  /** Cached root map; null = no project_roots entries exist yet */
  _rootMap: Map<string, RootMapEntry> | null
  /** projectId the cached root map belongs to */
  _rootMapProjectId: string | null
  readonly diskExec: DiskExecutor
  initialized: boolean
  initialize(): Promise<void>
  resolveProjectId(): Promise<string | null>
  ensureRootMap(projectId: string): Promise<Map<string, RootMapEntry> | null>
  resolvePath(path: string, projectId?: string | null): Promise<ResolvedRoot>
  isReadOnlyRoot(rootName: string): Promise<boolean>
  invalidateRootCache(): void
  getNativeDirectoryHandleForPath(path: string, projectId?: string | null): Promise<FileSystemDirectoryHandle | null>
  getAllNativeDirectoryHandles(projectId?: string | null): Promise<Map<string, FileSystemDirectoryHandle>>
  hasAnyNativeDirectoryHandle(): Promise<boolean>
  resolveRootIdForHandle(directoryHandle: FileSystemDirectoryHandle): Promise<string>
  readNativeFileContent(directoryHandle: FileSystemDirectoryHandle, path: string): Promise<string | ArrayBuffer>
  readNativeFileContentForPath(path: string, fallbackHandle?: FileSystemDirectoryHandle | null): Promise<string | ArrayBuffer | null>
}

/**
 * Resolve the projectId for this workspace from the DB.
 * Cached after first lookup to avoid repeated queries.
 *
 * IMPORTANT: This should be used instead of findActiveProject() in all
 * methods that need a projectId, because the global activeProject pointer
 * may point to a different project if the user switches browser tabs
 * while an agent conversation is still running.
 */
export async function resolveProjectIdImpl(rt: WorkspaceRuntimeInternals): Promise<string | null> {
  if (rt._cachedProjectId !== undefined) return rt._cachedProjectId
  try {
    const { getWorkspaceRepository } = await import(
      '@/sqlite/repositories/workspace.repository'
    )
    const workspace = await getWorkspaceRepository().findWorkspaceById(rt.workspaceId)
    rt._cachedProjectId = workspace?.projectId ?? null
  } catch {
    rt._cachedProjectId = null
  }
  return rt._cachedProjectId
}

/**
 * Ensure the root map is loaded from SQLite for the given project.
 * Cached in memory; re-loaded only when projectId changes.
 */
export async function ensureRootMapImpl(
  rt: WorkspaceRuntimeInternals,
  projectId: string
): Promise<Map<string, RootMapEntry> | null> {
  if (rt._rootMap && rt._rootMapProjectId === projectId) {
    return rt._rootMap
  }

  try {
    const { getProjectRootRepository } = await import(
      '@/sqlite/repositories/project-root.repository'
    )
    const repo = getProjectRootRepository()
    const roots = await repo.findByProject(projectId)

    if (roots.length === 0) {
      rt._rootMap = null
      rt._rootMapProjectId = projectId
      return null
    }

    rt._rootMap = new Map()
    rt._rootMapProjectId = projectId

    for (const root of roots) {
      rt._rootMap.set(root.name, {
        readOnly: root.readOnly,
        isDefault: root.isDefault,
        backend: root.backend,
        rootId: root.backend === 'native-host'
          ? root.scopeId
          : buildHandleKey(projectId, root.name),
      })
    }

    // Sort: is_default root first for deterministic routing order
    const defaultRoot = roots.find((r) => r.isDefault)
    if (defaultRoot && rt._rootMap.has(defaultRoot.name)) {
      const entry = rt._rootMap.get(defaultRoot.name)!
      rt._rootMap.delete(defaultRoot.name)
      const sorted = new Map<string, RootMapEntry>()
      sorted.set(defaultRoot.name, entry)
      for (const [k, v] of rt._rootMap) {
        sorted.set(k, v)
      }
      rt._rootMap = sorted
    }

    return rt._rootMap
  } catch {
    return null
  }
}

/**
 * Resolve a workspace-relative path to its root and root-relative sub-path.
 *
 * Path patterns:
 * - `"my-app/src/App.tsx"` → `{ rootName: "my-app", relativePath: "src/App.tsx" }`
 * - `"src/App.tsx"`        → `{ rootName: <defaultRoot>, relativePath: "src/App.tsx" }`
 *
 * If the first path segment matches a known root name, it's treated as a root prefix.
 * Otherwise, the path is assigned to the default root.
 */
export async function resolvePathImpl(
  rt: WorkspaceRuntimeInternals,
  path: string,
  projectId?: string | null
): Promise<ResolvedRoot> {
  // Normalize path
  let normalized = path.replace(/\\/g, '/')
  if (normalized.startsWith('/mnt/')) {
    normalized = normalized.slice('/mnt/'.length)
  } else if (normalized.startsWith('/')) {
    normalized = normalized.slice(1)
  }

  // Try to get projectId if not provided
  if (!projectId) {
    projectId = (await rt.resolveProjectId()) ?? undefined
  }

  // No project → fallback
  if (!projectId) {
    return { rootName: '_default', rootId: null, backend: 'fsaccess', relativePath: normalized, readOnly: false }
  }

  const rootMap = await rt.ensureRootMap(projectId)

  // No root map → fallback
  if (!rootMap || rootMap.size === 0) {
    return { rootName: projectId, rootId: null, backend: 'fsaccess', relativePath: normalized, readOnly: false }
  }

  // Check if first segment matches a known root
  const segments = normalized.split('/')
  const firstSegment = segments[0]

  if (firstSegment && rootMap.has(firstSegment)) {
    const rootInfo = rootMap.get(firstSegment)!
    return {
      rootName: firstSegment,
      rootId: rootInfo.rootId,
      backend: rootInfo.backend,
      relativePath: segments.slice(1).join('/'),
      readOnly: rootInfo.readOnly,
    }
  }

  // No root prefix match
  if (rootMap.size > 1) {
    // Multi-root: path MUST include a rootName prefix to avoid ambiguity.
    const rootNames = Array.from(rootMap.keys())
    throw new Error(
      `Path "${normalized}" is missing a rootName prefix. ` +
      `This workspace has multiple roots: ${rootNames.map(r => `"${r}"`).join(', ')}. ` +
      `Use the format "{rootName}/${normalized}" — ` +
      `e.g. "${rootNames[0]}/${normalized}" or "${rootNames[rootNames.length - 1]}/${normalized}".`
    )
  }
  // Single root: no ambiguity, route to the only root silently
  const firstEntry = rootMap.entries().next().value!
  return {
    rootName: firstEntry[0],
    rootId: firstEntry[1].rootId,
    backend: firstEntry[1].backend,
    relativePath: normalized,
    readOnly: firstEntry[1].readOnly,
  }
}

/**
 * Check if a root is read-only (for write guards).
 */
export async function isReadOnlyRootImpl(
  rt: WorkspaceRuntimeInternals,
  rootName: string
): Promise<boolean> {
  if (!rt._rootMap) return false
  return rt._rootMap.get(rootName)?.readOnly ?? false
}

/**
 * Invalidate cached root map (call when roots change).
 */
export function invalidateRootCacheImpl(rt: WorkspaceRuntimeInternals): void {
  rt._rootMap = null
  rt._rootMapProjectId = null
}

/**
 * Get native directory handle for a specific path, resolving multi-root routing.
 *
 * Resolution logic:
 * 1. If path starts with a known rootName prefix → use that root's handle
 * 2. Otherwise → use the first root's handle
 */
export async function getNativeDirectoryHandleForPathImpl(
  rt: WorkspaceRuntimeInternals,
  path: string,
  projectId?: string | null
): Promise<FileSystemDirectoryHandle | null> {
  try {
    let resolvedProjectId = projectId
    if (!resolvedProjectId) {
      resolvedProjectId = await rt.resolveProjectId()
    }
    if (!resolvedProjectId) return null

    const resolved = await rt.resolvePath(path, resolvedProjectId)
    return getRuntimeDirectoryHandle(resolvedProjectId, resolved.rootName) ?? null
  } catch {
    return null
  }
}

/**
 * Get all native directory handles for the project (multi-root).
 * Returns a Map of rootName → handle for all roots with active handles.
 */
export async function getAllNativeDirectoryHandlesImpl(
  rt: WorkspaceRuntimeInternals,
  projectId?: string | null
): Promise<Map<string, FileSystemDirectoryHandle>> {
  try {
    let resolvedProjectId = projectId
    if (!resolvedProjectId) {
      resolvedProjectId = await rt.resolveProjectId()
    }
    if (!resolvedProjectId) return new Map()

    return getRuntimeHandlesForProject(resolvedProjectId)
  } catch {
    return new Map()
  }
}

/**
 * Returns true if at least one native directory handle is mounted for this
 * project (across all roots). Used to detect "pure OPFS mode" — when no
 * native directory is mounted, agent writes/deletes go directly to OPFS
 * without entering the pending/approval workflow.
 */
export async function hasAnyNativeDirectoryHandleImpl(
  rt: WorkspaceRuntimeInternals
): Promise<boolean> {
  const handles = await rt.getAllNativeDirectoryHandles()
  if (handles.size > 0) return true
  const projectId = await rt.resolveProjectId()
  const rootMap = projectId ? await rt.ensureRootMap(projectId) : null
  return [...(rootMap?.values() ?? [])].some((root) => root.backend === 'native-host' && !!root.rootId)
}

/**
 * List disk directory entries via executor (supports native-host roots).
 * Used by ls tool when the root is native-host-backed (no FileSystemDirectoryHandle).
 *
 * @param path Workspace-relative path (may include rootName prefix)
 * @returns Array of entries, or null if the root is FS Access (caller should use handle instead)
 */
export async function listDiskDirImpl(
  rt: WorkspaceRuntimeInternals,
  path: string,
  projectId?: string | null
): Promise<Array<{ name: string; kind: 'file' | 'directory'; size?: number; mtime?: number }> | null> {
  if (!rt.initialized) await rt.initialize()
  try {
    const resolved = await rt.resolvePath(path, projectId)
    // Only handle native-host roots — FS Access roots use handle-based scanning
    if (resolved.backend !== 'native-host' || !resolved.rootId) {
      return null
    }
    const nativePath = resolved.relativePath || ''
    const entries = await rt.diskExec.listDir(resolved.rootId, nativePath)
    return entries.map((e) => ({
      name: e.name,
      kind: e.kind,
      size: e.stat?.size,
      mtime: e.stat?.mtime,
    }))
  } catch {
    return null
  }
}

/**
 * Recursively scan a native-host disk root up to maxDepth.
 * Returns entries with paths relative to the root.
 */
export async function scanDiskTreeImpl(
  rt: WorkspaceRuntimeInternals,
  path: string,
  maxDepth: number,
  projectId?: string | null,
  options?: { includeSizes?: boolean; excludeDirs?: string[]; maxEntries?: number; deadlineMs?: number; respectGitignore?: boolean; includeIgnored?: boolean }
): Promise<Array<{ path: string; type: 'file' | 'directory'; size: number; depth: number }> | null> {
  if (!rt.initialized) await rt.initialize()
  try {
    const resolved = await rt.resolvePath(path, projectId)
    if (resolved.backend !== 'native-host' || !resolved.rootId) {
      return null
    }

    const rootId = resolved.rootId
    const basePath = resolved.relativePath || ''
    const excludeSet = new Set(options?.includeIgnored ? [] : options?.excludeDirs ?? [])
    const maxEntries = options?.maxEntries
    const deadlineAt = Date.now() + (options?.deadlineMs ?? 25000)
    const includeSizes = options?.includeSizes ?? false

    const entries: Array<{ path: string; type: 'file' | 'directory'; size: number; depth: number }> = []

    const initialRules: GitIgnoreRule[] = []
    if (options?.respectGitignore && basePath) {
      let parent = ''
      for (const segment of basePath.split('/').filter(Boolean)) {
        try {
          const result = await rt.diskExec.read(rootId, parent ? `${parent}/.gitignore` : '.gitignore')
          if (typeof result.content === 'string') initialRules.push(...parseGitIgnore(result.content, parent))
        } catch { /* Optional ignore file. */ }
        parent = parent ? `${parent}/${segment}` : segment
      }
    }
    const queue: Array<{ dirPath: string; displayPath: string; depth: number; rules: GitIgnoreRule[] }> = [
      { dirPath: basePath, displayPath: '', depth: 0, rules: initialRules },
    ]

    while (queue.length > 0) {
      if (Date.now() > deadlineAt) break
      const current = queue.shift()!

      let dirEntries
      try {
        dirEntries = await rt.diskExec.listDir(rootId, current.dirPath)
      } catch {
        continue
      }

      let rules = current.rules
      if (options?.respectGitignore && dirEntries.some((entry) => entry.name === '.gitignore' && entry.kind === 'file')) {
        try {
          const ignorePath = current.dirPath ? `${current.dirPath}/.gitignore` : '.gitignore'
          const result = await rt.diskExec.read(rootId, ignorePath)
          if (typeof result.content === 'string') rules = [...rules, ...parseGitIgnore(result.content, current.dirPath)]
        } catch { /* Optional ignore file. */ }
      }

      for (const entry of dirEntries) {
        if (Date.now() > deadlineAt) break

        const childDepth = current.depth + 1
        if (childDepth > maxDepth) continue

        const relPath = current.displayPath ? `${current.displayPath}/${entry.name}` : entry.name
        const rootPath = current.dirPath ? `${current.dirPath}/${entry.name}` : entry.name
        if (options?.respectGitignore && isGitIgnored(rootPath, rules, entry.kind)) continue

        if (entry.kind === 'directory') {
          // Skip excluded dirs (from caller's excludeDirs parameter)
          const lowerName = entry.name.toLowerCase()
          if (excludeSet.has(lowerName) || excludeSet.has(entry.name)) continue
          // Don't recurse into known heavy dirs to avoid massive scans.
          // The ls tool's default maxDepth (2) usually keeps these shallow,
          // but we skip recursion into them regardless of depth.
          if (!options?.includeIgnored && (lowerName === 'node_modules' || lowerName === '.git' || lowerName === 'target' || lowerName === '.next' || lowerName === 'dist')) {
            entries.push({ path: relPath, type: 'directory', size: 0, depth: childDepth })
            continue // list the dir itself, but don't recurse into it
          }

          entries.push({ path: relPath, type: 'directory', size: 0, depth: childDepth })
          queue.push({
            dirPath: current.dirPath ? `${current.dirPath}/${entry.name}` : entry.name,
            displayPath: relPath,
            depth: childDepth,
            rules,
          })
        } else {
          entries.push({
            path: relPath,
            type: 'file',
            size: includeSizes ? (entry.stat?.size ?? 0) : 0,
            depth: childDepth,
          })
        }

        if (maxEntries !== undefined && entries.length >= maxEntries) break
      }
      if (maxEntries !== undefined && entries.length >= maxEntries) break
    }

    return entries
  } catch {
    return null
  }
}

export async function readFromDiskRootImpl(
  rt: WorkspaceRuntimeInternals,
  rootId: string,
  path: string
): Promise<{ content: FileContent; metadata: FileMetadata }> {
  const result = await rt.diskExec.read(rootId, path)
  return {
    content: result.content,
    metadata: { path, mtime: result.stat.mtime, size: result.stat.size, contentType: result.stat.contentType },
  }
}

export async function getDiskFileMetadataImpl(
  rt: WorkspaceRuntimeInternals,
  rootId: string,
  path: string
): Promise<{ mtime: number; size: number; contentType: 'text' | 'binary' }> {
  const stat = await rt.diskExec.stat(rootId, path)
  if (!stat) throw new Error(`File not found: ${path}`)
  return { mtime: stat.mtime, size: stat.size, contentType: stat.contentType }
}

/**
 * Resolve a FileSystemDirectoryHandle back to its rootId (compoundKey).
 * Used to bridge legacy handle-based call sites to the DiskExecutor API.
 * Throws if the handle is not registered in the runtime handle map.
 */
export async function resolveRootIdForHandleImpl(
  rt: WorkspaceRuntimeInternals,
  directoryHandle: FileSystemDirectoryHandle
): Promise<string> {
  const projectId = await rt.resolveProjectId()
  if (!projectId) {
    throw new Error('[WorkspaceRuntime] Cannot resolve rootId: no projectId')
  }
  const handles = getRuntimeHandlesForProject(projectId)
  for (const [rootName, handle] of handles) {
    if (handle === directoryHandle) {
      return buildHandleKey(projectId, rootName)
    }
  }
  throw new Error(
    `[WorkspaceRuntime] Handle not found in runtime map (directoryHandle.name=${directoryHandle.name}, projectId=${projectId})`
  )
}

/**
 * Read native file content for a workspace path, resolving the correct
 * root handle and stripping the root prefix in multi-root setups.
 * Falls back to the provided directoryHandle with the raw path if multi-root
 * resolution fails.
 */
export async function readNativeFileContentForPathImpl(
  rt: WorkspaceRuntimeInternals,
  path: string,
  fallbackHandle?: FileSystemDirectoryHandle | null
): Promise<string | ArrayBuffer | null> {
  try {
    const allHandles = await rt.getAllNativeDirectoryHandles()
    if (allHandles.size > 0) {
      const resolved = await rt.resolvePath(path)
      const rootHandle = allHandles.get(resolved.rootName)
      if (rootHandle && resolved.relativePath) {
        return await rt.readNativeFileContent(rootHandle, resolved.relativePath)
      }
      if (rootHandle && !resolved.relativePath) {
        // Path matched a root name exactly (e.g. "creatorweave") — no file to read
        return null
      }
    }
  } catch {
    // Multi-root resolution failed — fall through to single-root path
  }

  // Single-root fallback: use provided handle with raw path
  if (fallbackHandle) {
    return await rt.readNativeFileContent(fallbackHandle, path)
  }
  return null
}

export async function readNativeFileContentImpl(
  rt: WorkspaceRuntimeInternals,
  directoryHandle: FileSystemDirectoryHandle,
  path: string
): Promise<string | ArrayBuffer> {
  const rootId = await rt.resolveRootIdForHandle(directoryHandle)
  const result = await rt.diskExec.read(rootId, path)
  return result.content
}

export async function writeNativeFileImpl(
  rt: WorkspaceRuntimeInternals,
  directoryHandle: FileSystemDirectoryHandle,
  path: string,
  content: string | ArrayBuffer
): Promise<void> {
  const rootId = await rt.resolveRootIdForHandle(directoryHandle)
  await rt.diskExec.write(rootId, path, content)
}
