/**
 * ls tool - Unified directory reading tool.
 *
 * Combines glob and list_files functionality:
 * - With pattern: Search for files matching glob pattern
 * - Without pattern: List directory contents in tree format
 *
 * For workspace scope, lists from OPFS files/ directory (mounted at /mnt/ in Python)
 * so agent sees the same files as Pyodide, including pending changes and synced resources.
 */

import type { ToolContext, ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'
import micromatch from 'micromatch'
import { toolOkJson, toolErrorJson } from './tool-envelope'
import { resolveVfsTarget } from './vfs-resolver'
import { resolveNativeDirectoryHandle, resolveWorkspaceDirectoryHandle } from './tool-utils'
import {
  getStaticGlobPrefix,
  normalizeSubPath,
  parseBoundedInt,
  parseStringList,
  readDirectoryEntriesSorted,
  resolveDirectoryHandle,
  shouldSkipDirectory,
} from './file-discovery.helpers'
import { rewritePythonMountPathForNonPythonTool, validateRootPrefix } from './path-guards'
import { isSubagentPermissionDenied, SUBAGENT_PERMISSION_DENIED } from './agent-file-protection'

const DIRECTORY_TOOL_PARAMETERS: ToolDefinition['function']['parameters'] = {
  type: 'object',
  properties: {
    // Common parameters
    path: {
      type: 'string',
      description: 'Subdirectory to read (default: project root)',
    },
    // Glob mode parameters
    pattern: {
      type: 'string',
      description: 'Glob pattern to match files (e.g. "**/*.ts", "src/**/*.tsx"). If provided, searches for matching files.',
    },
    // List mode parameters
    max_depth: {
      type: 'number',
      description: 'Maximum depth to traverse (default: 2 for list, 20 for glob)',
    },
    maxDepth: {
      type: 'number',
      description: 'Alias of max_depth',
    },
    max_entries: {
      type: 'number',
      description: 'Maximum entries to return. If omitted, no entry-count limit is applied.',
    },
    maxEntries: {
      type: 'number',
      description: 'Alias of max_entries',
    },
    max_results: {
      type: 'number',
      description: 'Maximum results for glob search. If omitted, no result-count limit is applied.',
    },
    maxResults: {
      type: 'number',
      description: 'Alias of max_results',
    },
    include_sizes: {
      type: 'boolean',
      description: 'Include file sizes in list mode (default: false)',
    },
    includeSizes: {
      type: 'boolean',
      description: 'Alias of include_sizes',
    },
    include_ignored: {
      type: 'boolean',
      description: 'Include large ignored directories like node_modules/.git (default: false)',
    },
    includeIgnored: {
      type: 'boolean',
      description: 'Alias of include_ignored',
    },
    exclude_dirs: {
      type: 'array',
      description: 'Extra directory names to skip while traversing',
      items: { type: 'string' },
    },
    excludeDirs: {
      type: 'array',
      description: 'Alias of exclude_dirs',
      items: { type: 'string' },
    },
    deadline_ms: {
      type: 'number',
      description: 'Soft time budget in milliseconds (default: 25000)',
    },
    deadlineMs: {
      type: 'number',
      description: 'Alias of deadline_ms',
    },
  },
}

function createDirectoryToolDefinition(name: string, description: string): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: DIRECTORY_TOOL_PARAMETERS,
    },
  }
}

export const lsDefinition: ToolDefinition = createDirectoryToolDefinition(
  'ls',
  'List directory contents. With pattern: search files matching glob. Without pattern: list tree structure. Supports workspace relative paths and vfs://workspace/..., vfs://agents/{id}/..., vfs://assets/..., or vfs://webmcp/... in path.'
)


/**
 * Get the OPFS files/ directory handle for the given workspace.
 * Used so ls sees the same files as Pyodide at /mnt/.
 *
 * workspaceId is always provided by the agent loop. If missing, returns null.
 */
async function getOPFSFilesHandle(workspaceId?: string | null): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (!workspaceId) return null
    const { getWorkspaceManager } = await import('@/opfs')
    const manager = await getWorkspaceManager()
    const workspace = await manager.getWorkspace(workspaceId)
    if (!workspace) return null
    return await workspace.getFilesDir()
  } catch {
    return null
  }
}

export const lsExecutor: ToolExecutor = async (args, context) => {
  // Validate root prefix before any path rewriting
  const rawPath = typeof args.path === 'string' ? args.path : ''
  if (rawPath) {
    const rootError = await validateRootPrefix('ls', rawPath, context)
    if (rootError) return rootError
  }

  const rewrittenPath = rewritePythonMountPathForNonPythonTool(args.path)
  const effectiveArgs = rewrittenPath?.rewritten
    ? { ...args, path: rewrittenPath.rewrittenPath }
    : args
  const pattern = typeof effectiveArgs.pattern === 'string' ? effectiveArgs.pattern.trim() : ''

  // Smart mode detection: glob mode if pattern provided, list mode otherwise
  if (pattern) {
    return executeGlobMode(effectiveArgs, context, pattern)
  }
  return executeListMode(effectiveArgs, context)
}

async function resolveDirectoryHandleWithConversationFallback(
  handle: FileSystemDirectoryHandle | null | undefined,
  workspaceId?: string | null
): Promise<FileSystemDirectoryHandle | null> {
  if (handle) return handle

  const workspaceHandle = await resolveWorkspaceDirectoryHandle(workspaceId)
  if (workspaceHandle) return workspaceHandle

  try {
    const { useFolderAccessStore } = await import('@/store/folder-access.store')
    const folderHandle = useFolderAccessStore.getState().getCurrentHandle()
    if (folderHandle) return folderHandle
  } catch {
    // ignore folder-access store loading failures and continue fallback chain
  }

  return await resolveNativeDirectoryHandle(null, null)
}

type DiscoveryScope =
  | {
      kind: 'workspace'
      subPath: string
      /** When path was routed to a specific multi-root (e.g. path="lxy"), this holds that root name
       *  so OPFS merge can resolve into files/{rootName}/ instead of the workspace-level files/ root. */
      rootName?: string
      resolveHandle: (
        path: string,
        options?: { allowMissing?: boolean }
      ) => Promise<{ handle: FileSystemDirectoryHandle; exists: boolean }>
    }
  | {
      kind: 'agent'
      subPath: string
      resolveHandle: (
        path: string,
        options?: { allowMissing?: boolean }
      ) => Promise<{ handle: FileSystemDirectoryHandle; exists: boolean }>
    }
  | {
      kind: 'agents-root'
      listAgents: () => Promise<Array<{ id: string; name: string }>>
      resolveAgentHandle: (
        agentId: string,
        path: string,
        options?: { allowMissing?: boolean }
      ) => Promise<{ handle: FileSystemDirectoryHandle; exists: boolean }>
    }
  | {
      kind: 'assets' | 'skills' | 'webmcp'
      subPath: string
      resolveHandle: (
        path: string,
        options?: { allowMissing?: boolean }
      ) => Promise<{ handle: FileSystemDirectoryHandle; exists: boolean }>
    }

async function resolveDiscoveryScope(
  rawPath: unknown,
  toolContext: ToolContext,
  mode: 'list' | 'glob'
): Promise<DiscoveryScope> {
  if (typeof rawPath === 'string' && rawPath.trim().startsWith('vfs://')) {
    const resolved = await resolveVfsTarget(rawPath.trim(), toolContext, 'list', { allowEmptyPath: true })
    if (resolved.kind === 'workspace') {
      const rootHandle = await resolveDirectoryHandleWithConversationFallback(toolContext.directoryHandle, toolContext.workspaceId)
      if (!rootHandle) {
        throw new Error('No directory selected.')
      }
      return {
        kind: 'workspace',
        subPath: resolved.path,
        resolveHandle: (path, options) => resolveDirectoryHandle(rootHandle, path, options),
      }
    }

    if (resolved.kind === 'assets' || resolved.kind === 'skills' || resolved.kind === 'webmcp') {
      const rootHandle = await resolved.backend.getDirectoryHandle?.()
      if (!rootHandle) {
        throw new Error(`${resolved.backend.label} directory not available.`)
      }
      return {
        kind: resolved.kind,
        subPath: resolved.path,
        resolveHandle: (path, options) => resolveDirectoryHandle(rootHandle, path, options),
      }
    }

    // Agent scope: use backend.getDirectoryHandle() to get root, then resolve sub-paths
    if (!resolved.agentId) {
      return {
        kind: 'agents-root',
        listAgents: async () => {
          const agents = await resolved.agentManager.listAgents()
          return agents.map((agent) => ({ id: agent.id, name: agent.name }))
        },
        resolveAgentHandle: (agentId, path, options) =>
          resolved.agentManager.getDirectoryHandle(agentId, path, options),
      }
    }

    // Single agent: get root handle from backend, then resolve sub-paths
    const agentRootHandle = await resolved.backend.getDirectoryHandle?.()
    if (!agentRootHandle) {
      throw new Error('Agent directory not available.')
    }
    return {
      kind: 'agent',
      subPath: resolved.path,
      resolveHandle: (path, options) => resolveDirectoryHandle(agentRootHandle, path, options),
    }
  }

  let subPath = ''
  try {
    subPath = normalizeSubPath(rawPath)
  } catch {
    throw new Error(`${mode === 'list' ? 'List' : 'Glob search'} failed: path cannot include ".."`)
  }

  // Multi-root: check if first segment matches a root name
  // If so, resolve within that root's OPFS subtree
  try {
    const { getRuntimeHandlesForProject } = await import('@/native-fs')
    const projectId = toolContext.projectId
    if (projectId) {
      const allHandles = getRuntimeHandlesForProject(projectId)
      if (allHandles.size > 0 && subPath) {
        const segments = subPath.split('/')
        const maybeRoot = segments[0]
        if (allHandles.has(maybeRoot)) {
          // Path starts with a root name → route to that root
          const rootHandle = allHandles.get(maybeRoot)!
          const rootSubPath = segments.slice(1).join('/')
          return {
            kind: 'workspace' as const,
            subPath: rootSubPath,
            rootName: maybeRoot,
            resolveHandle: (path: string, options?: { allowMissing?: boolean }) =>
              resolveDirectoryHandle(rootHandle, path, options),
          }
        }
      }
    }
  } catch { /* ignore, fall through to single-handle logic */ }

  const rootHandle = await resolveDirectoryHandleWithConversationFallback(
    toolContext.directoryHandle,
    toolContext.workspaceId
  )
  if (!rootHandle) {
    throw new Error('No directory selected.')
  }

  return {
    kind: 'workspace',
    subPath,
    resolveHandle: (path, options) => resolveDirectoryHandle(rootHandle, path, options),
  }
}

/**
 * List mode - directory tree listing (from original list_files)
 */
async function executeListMode(args: Record<string, unknown>, context: unknown): Promise<string> {
  const toolContext = context as ToolContext
  const abortSignal = toolContext.abortSignal

  // Multi-root: when no path and multiple roots exist, list root names
  if (!args.path) {
    try {
      const projectId = toolContext.projectId
      if (projectId) {
        // Read root metadata from DB — covers BOTH FS Access and native-host roots.
        // Previously this only checked FS Access handles (getRuntimeHandlesForProject),
        // which missed native-host-only projects.
        const { getProjectRootRepository } = await import('@/sqlite/repositories/project-root.repository')
        const dbRoots = await getProjectRootRepository().findByProject(projectId)
        if (dbRoots.length > 0) {
          return toolOkJson('ls', dbRoots.map((r: { name: string; readOnly: boolean }) => ({ name: r.name, kind: 'directory', readOnly: r.readOnly })))
        }
      }
    } catch { /* fall through to normal list */ }
  }

  // Native Host roots expose no FileSystemDirectoryHandle and are therefore
  // invisible to getRuntimeHandlesForProject. Mirror search.tool.ts: when the
  // first path segment is a native-host root name, route to the disk scanner
  // instead of silently falling through to the OPFS workspace mirror (which is
  // a stale snapshot and misses disk-only files). The disk scan is then merged
  // with the OPFS mirror subtree so pending changes (unsynced write/edit) stay
  // visible — same "disk base + OPFS overlay" semantics as the handle path.
  if (typeof args.path === 'string' && args.path.trim() && toolContext.workspaceId) {
    const nativeRoots = await listNativeHostRootNames(toolContext)
    if (nativeRoots.includes(args.path.split('/')[0])) {
      const merged = await listNativeHostWithOpfsMerge(args.path, toolContext, args)
      if (merged) return merged
    }
  }

  let scope: DiscoveryScope
  try {
    scope = await resolveDiscoveryScope(args.path, toolContext, 'list')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isSubagentPermissionDenied(error)) {
      return toolErrorJson('ls', SUBAGENT_PERMISSION_DENIED, message)
    }
    // Before giving up, check if this is a native-host root that has no
    // FileSystemDirectoryHandle — the error "No directory selected" is
    // expected in that case. Try scanning via executor instead.
    if ((message === 'No directory selected.' || message.startsWith('List failed')) && typeof args.path === 'string' && toolContext.workspaceId) {
      const diskResult = await tryNativeHostDiskScan(args.path, toolContext, args)
      if (diskResult) return diskResult
    }
    if (message === 'No directory selected.') {
      return toolErrorJson('ls', 'no_directory', message)
    }
    return toolErrorJson('ls', 'list_failed', message.startsWith('List failed:') ? message : `List failed: ${message}`)
  }

  const rawMaxDepth = args.max_depth ?? args.maxDepth
  const maxDepth = parseBoundedInt(rawMaxDepth, 2, 1, 10)
  const maxEntriesRaw = args.max_entries ?? args.maxEntries
  const maxEntries =
    typeof maxEntriesRaw === 'number' && Number.isFinite(maxEntriesRaw)
      ? parseBoundedInt(maxEntriesRaw, 200, 1, 50000)
      : undefined
  const deadlineMs = parseBoundedInt(args.deadline_ms ?? args.deadlineMs, 25000, 1000, 28000)
  const includeSizes = args.include_sizes === true || args.includeSizes === true
  const includeIgnored = args.include_ignored === true || args.includeIgnored === true
  const extraExcludes = parseStringList(args.exclude_dirs ?? args.excludeDirs)

  try {
    if (scope.kind === 'agents-root') {
      const agents = await scope.listAgents()
      if (agents.length === 0) {
        return toolOkJson('ls', [])
      }
      return toolOkJson('ls', agents.map((agent) => ({ name: agent.id, kind: 'directory' })))
    }

    // Resolve native FS handle (disk files)
    // Use allowMissing so we can distinguish "directory does not exist" from other errors
    const nativeResult = await scope.resolveHandle(scope.subPath, { allowMissing: true })

    // When the directory is missing from native FS, fall back to OPFS before
    // declaring it not-found. A directory may exist only in OPFS (agent writes,
    // Python-created, pending changes) while the native disk has no such entry.
    // The OPFS merge step below only adds extra *files* inside an existing native
    // directory; it cannot recover a directory that is itself OPFS-only.
    if (!nativeResult.exists && scope.subPath) {
      // For workspace scope, try OPFS as a fallback source.
      if (scope.kind === 'workspace') {
        const opfsFilesHandle = await getOPFSFilesHandle(toolContext.workspaceId)
        let opfsHasDir = false
        if (opfsFilesHandle) {
          const opfsSubPath = scope.rootName
            ? (scope.subPath ? `${scope.rootName}/${scope.subPath}` : scope.rootName)
            : scope.subPath
          const opfsResolved = await resolveDirectoryHandle(opfsFilesHandle, opfsSubPath, { allowMissing: true })
          opfsHasDir = opfsResolved.exists
        }
        if (!opfsHasDir) {
          // Before declaring not-found, check if this is a native-host root
          // that has no FileSystemDirectoryHandle — try disk scan via executor.
          const diskResult = await tryNativeHostDiskScan(
            scope.rootName ? `${scope.rootName}/${scope.subPath}` : scope.subPath,
            toolContext, args
          )
          if (diskResult) return diskResult

          const rootName = 'rootName' in scope ? scope.rootName : undefined
          const displayPath = rootName ? `${rootName}/${scope.subPath}` : scope.subPath
          return toolErrorJson('ls', 'directory_not_found', `Directory "${displayPath}" does not exist.`, {
            hint: 'Check the path for typos, or use ls() without arguments to list available roots and directories.',
            details: { requested_path: scope.subPath, rootName },
          })
        }
        // OPFS has the directory — proceed with an empty native handle so only
        // the OPFS merge scan runs below.
      } else {
        // Before declaring not-found, check native-host disk scan
        const diskResult2 = await tryNativeHostDiskScan(
          ('rootName' in scope && scope.rootName) ? `${scope.rootName}/${scope.subPath}` : scope.subPath,
          toolContext, args
        )
        if (diskResult2) return diskResult2

        const rootName = 'rootName' in scope ? scope.rootName : undefined
        const displayPath = rootName ? `${rootName}/${scope.subPath}` : scope.subPath
        return toolErrorJson('ls', 'directory_not_found', `Directory "${displayPath}" does not exist.`, {
          hint: 'Check the path for typos, or use ls() without arguments to list available roots and directories.',
          details: { requested_path: scope.subPath, rootName },
        })
      }
    }
    // When native is missing but OPFS has the dir, use a sentinel: scan only OPFS.
    const nativeHandle: FileSystemDirectoryHandle | null = nativeResult.exists ? nativeResult.handle : null

    const startedAt = Date.now()
    const deadlineAt = startedAt + deadlineMs
    const entries: Array<{ path: string; type: 'file' | 'directory'; size: number; depth: number }> = []
    const seenPaths = new Set<string>()
    let isTruncated = false
    let timedOut = false

    // Helper to scan a directory tree and collect entries
    const scanTree = async (rootHandle: FileSystemDirectoryHandle) => {
      const queue: Array<{ handle: FileSystemDirectoryHandle; path: string; depth: number }> = [
        { handle: rootHandle, path: '', depth: 0 },
      ]

      while (queue.length > 0) {
        if (abortSignal?.aborted) return
        const current = queue.shift()!
        if (Date.now() > deadlineAt) { timedOut = true; break }

        const handles = await readDirectoryEntriesSorted(current.handle)
        for (const handle of handles) {
          if (abortSignal?.aborted) return
          if (Date.now() > deadlineAt) { timedOut = true; break }

          const childDepth = current.depth + 1
          if (childDepth > maxDepth) continue

          const relPath = current.path ? `${current.path}/${handle.name}` : handle.name

          // Skip if already seen (native takes precedence)
          if (seenPaths.has(relPath)) continue
          seenPaths.add(relPath)

          if (handle.kind === 'directory') {
            if (shouldSkipDirectory(handle.name, includeIgnored, extraExcludes)) continue
            entries.push({ path: relPath, type: 'directory', size: 0, depth: childDepth })
            queue.push({ handle: handle as FileSystemDirectoryHandle, path: relPath, depth: childDepth })
          } else {
            let size = 0
            if (includeSizes) {
              try {
                const file = await (handle as FileSystemFileHandle).getFile()
                size = file.size
              } catch { size = 0 }
            }
            entries.push({ path: relPath, type: 'file', size, depth: childDepth })
          }

          if (maxEntries !== undefined && entries.length >= maxEntries) {
            isTruncated = true
            break
          }
        }
        if (isTruncated || timedOut) break
      }
    }

    // 1. Scan native FS (disk files — base). Skipped when the directory only
    //    exists in OPFS (nativeHandle is null in that case).
    if (nativeHandle) {
      await scanTree(nativeHandle)
    }

    // 2. Merge OPFS-only files (pending changes, .skills/, etc.)
    if (!isTruncated && !timedOut && scope.kind === 'workspace') {
      const opfsHandle = await getOPFSFilesHandle(toolContext.workspaceId)
      if (opfsHandle) {
        // In multi-root: rootName is set when path was routed to a specific root.
        // We must resolve into files/{rootName}/ subdirectory first, then apply subPath.
        const opfsSubPath = scope.rootName
          ? (scope.subPath ? `${scope.rootName}/${scope.subPath}` : scope.rootName)
          : scope.subPath
        const resolved = await resolveDirectoryHandle(opfsHandle, opfsSubPath, { allowMissing: true })
        if (resolved.exists) {
          await scanTree(resolved.handle)
        }
      }
    }

    if (timedOut) {
      return toolErrorJson('ls', 'deadline_exceeded', `List scan exceeded deadline ${deadlineMs}ms. Narrow path or increase deadline_ms.`, { retryable: true, details: { scannedEntries: entries.length } })
    }

    if (entries.length === 0) {
      return toolOkJson('ls', [], { _hint: scope.subPath ? `Directory "${scope.subPath}" is empty` : 'Project directory is empty' })
    }

    // Build tree output
    return toolOkJson('ls', entries.map(e => ({
      name: e.path.split('/').pop() || e.path,
      path: e.path,
      kind: e.type,
      ...(e.size > 0 ? { size: e.size } : {}),
    })), {
      ...(isTruncated ? { truncated: true, maxEntries } : {}),
    })
  } catch (error) {
    return toolErrorJson('ls', 'list_failed', `List failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Glob mode - file pattern search (from original glob)
 */
async function executeGlobMode(
  args: Record<string, unknown>,
  context: unknown,
  pattern: string
): Promise<string> {
  const toolContext = context as ToolContext
  const abortSignal = toolContext.abortSignal

  // Native Host roots expose no FileSystemDirectoryHandle and are therefore
  // invisible to getRuntimeHandlesForProject. Mirror search.tool.ts: when the
  // first path segment is a native-host root name, route the glob to the disk
  // scanner instead of silently falling through to the OPFS workspace mirror.
  // OPFS-only matches (pending changes, unsynced writes) are merged on top;
  // disk entries take precedence for duplicates.
  if (typeof args.path === 'string' && args.path.trim() && toolContext.workspaceId) {
    const nativeRoots = await listNativeHostRootNames(toolContext)
    if (nativeRoots.includes(args.path.split('/')[0])) {
      const collected = await collectNativeHostGlobMatches(toolContext, args, pattern, [args.path])
      if (collected.available) {
        const opfsMatches = await collectOpfsGlobMatches(toolContext, args, pattern, args.path)
        const seen = new Set(collected.matches)
        const matches = [...collected.matches]
        for (const m of opfsMatches) {
          if (seen.has(m)) continue
          seen.add(m)
          matches.push(m)
        }
        return formatNativeHostGlobResult(args, { matches, truncated: collected.truncated }, pattern, args.path)
      }
    }
  }

  let scope: DiscoveryScope
  try {
    scope = await resolveDiscoveryScope(args.path, toolContext, 'glob')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isSubagentPermissionDenied(error)) {
      return toolErrorJson('ls', SUBAGENT_PERMISSION_DENIED, message)
    }
    if (message === 'No directory selected.') {
      // Native-host-only project (no FS Access/OPFS handle): glob the native
      // roots via the disk scanner instead of failing, mirroring list mode's
      // fallback and search's native-host support.
      if (toolContext.workspaceId) {
        const nativeRoots = await listNativeHostRootNames(toolContext)
        if (nativeRoots.length > 0) {
          const collected = await collectNativeHostGlobMatches(toolContext, args, pattern, nativeRoots)
          if (collected.available) {
            return formatNativeHostGlobResult(args, collected, pattern, '')
          }
        }
      }
      return toolErrorJson('ls', 'no_directory', message)
    }
    return toolErrorJson('ls', 'glob_failed', message.startsWith('Glob search failed:') ? message : `Glob search failed: ${message}`)
  }

  const maxResultsRaw = args.max_results ?? args.maxResults ?? args.max_entries ?? args.maxEntries
  const maxResults =
    typeof maxResultsRaw === 'number' && Number.isFinite(maxResultsRaw)
      ? parseBoundedInt(maxResultsRaw, 1, 1, 100000)
      : undefined
  const maxDepth = parseBoundedInt(args.max_depth ?? args.maxDepth, 20, 1, 64)
  const deadlineMs = parseBoundedInt(args.deadline_ms ?? args.deadlineMs, 25000, 1000, 28000)
  const includeIgnored = args.include_ignored === true || args.includeIgnored === true
  const extraExcludes = parseStringList(args.exclude_dirs ?? args.excludeDirs)

  try {
    if (scope.kind === 'agents-root') {
      const agents = await scope.listAgents()
      if (agents.length === 0) {
        return toolOkJson('ls', [], { _hint: `No files matching pattern "${pattern}" in vfs://agents` })
      }

      const staticPrefix = getStaticGlobPrefix(pattern)
      const startedAt = Date.now()
      const deadlineAt = startedAt + deadlineMs
      const matches: string[] = []
      let isTruncated = false
      let timedOut = false

      for (const agent of agents) {
        if (abortSignal?.aborted) {
          return toolErrorJson('ls', 'aborted', 'Glob search failed: operation aborted')
        }
        if (Date.now() > deadlineAt) {
          timedOut = true
          break
        }

        const { handle: searchHandle, exists } = await scope.resolveAgentHandle(
          agent.id,
          staticPrefix,
          { allowMissing: !!staticPrefix }
        )
        if (!exists) {
          continue
        }

        const stack: Array<{ handle: FileSystemDirectoryHandle; fullPath: string; localPath: string; depth: number }> =
          [{ handle: searchHandle, fullPath: staticPrefix, localPath: '', depth: 0 }]

        while (stack.length > 0) {
          if (abortSignal?.aborted) {
            return toolErrorJson('ls', 'aborted', 'Glob search failed: operation aborted')
          }
          const current = stack.pop()!
          if (Date.now() > deadlineAt) {
            timedOut = true
            break
          }

          const handles = await readDirectoryEntriesSorted(current.handle)
          for (const handle of handles) {
            if (abortSignal?.aborted) {
              return toolErrorJson('ls', 'aborted', 'Glob search failed: operation aborted')
            }
            if (Date.now() > deadlineAt) {
              timedOut = true
              break
            }

            const nextDepth = current.depth + 1
            if (nextDepth > maxDepth) continue

            const fullPath = current.fullPath ? `${current.fullPath}/${handle.name}` : handle.name
            const localPath = current.localPath ? `${current.localPath}/${handle.name}` : handle.name
            const namespacedPath = `${agent.id}/${fullPath}`

            if (handle.kind === 'directory') {
              if (shouldSkipDirectory(handle.name, includeIgnored, extraExcludes)) continue
              stack.push({
                handle: handle as FileSystemDirectoryHandle,
                fullPath,
                localPath,
                depth: nextDepth,
              })
              continue
            }

            const dotOpts: micromatch.Options = { dot: true }
            const matched =
              micromatch.isMatch(namespacedPath, pattern, dotOpts) ||
              micromatch.isMatch(fullPath, pattern, dotOpts) ||
              micromatch.isMatch(localPath, pattern, dotOpts)
            if (matched) {
              matches.push(namespacedPath)
              if (maxResults !== undefined && matches.length >= maxResults) {
                isTruncated = true
                break
              }
            }
          }
          if (isTruncated || timedOut) break
        }

        if (isTruncated || timedOut) break
      }

      if (timedOut) {
        return toolErrorJson('ls', 'deadline_exceeded', `Glob scan exceeded deadline ${deadlineMs}ms. Narrow pattern/path or increase deadline_ms.`, { retryable: true, details: { matchedSoFar: matches.length } })
      }

      if (matches.length === 0) {
        return toolOkJson('ls', [], { _hint: `No files matching pattern "${pattern}" in vfs://agents` })
      }

      return toolOkJson('ls', matches.map(m => ({ name: m, path: m, kind: 'file' as const })), {
        ...(isTruncated ? { truncated: true, maxResults } : {}),
      })
    }

    const staticPrefix = scope.subPath ? '' : getStaticGlobPrefix(pattern)
    const effectiveRoot = scope.subPath || staticPrefix

    // For workspace scope, collect handles from both native FS and OPFS
    // so glob can find files regardless of which filesystem they live in.
    const searchHandles: Array<{ handle: FileSystemDirectoryHandle; source: 'native' | 'opfs' }> = []

    if (scope.kind === 'workspace') {
      // 1. Native FS (disk files — always attempt)
      const nativeResult = await scope.resolveHandle(effectiveRoot, { allowMissing: true })
      if (nativeResult.exists) {
        searchHandles.push({ handle: nativeResult.handle, source: 'native' })
      }

      // 2. OPFS (pending changes, .skills/, etc.)
      const opfsFilesHandle = await getOPFSFilesHandle(toolContext.workspaceId)
      if (opfsFilesHandle) {
        // In multi-root: rootName is set when path was routed to a specific root.
        // We must resolve into files/{rootName}/ subdirectory first.
        const opfsEffectiveRoot = scope.rootName
          ? (effectiveRoot ? `${scope.rootName}/${effectiveRoot}` : scope.rootName)
          : effectiveRoot
        const opfsResult = await resolveDirectoryHandle(opfsFilesHandle, opfsEffectiveRoot, { allowMissing: true })
        if (opfsResult.exists) {
          searchHandles.push({ handle: opfsResult.handle, source: 'opfs' })
        }
      }
    } else {
      const r = await scope.resolveHandle(effectiveRoot, { allowMissing: true })
      if (r.exists) {
        searchHandles.push({ handle: r.handle, source: 'native' })
      }
    }

    if (searchHandles.length === 0) {
      return toolOkJson('ls', [], { _hint: `No files matching pattern "${pattern}"` })
    }

    // Always enable dot matching for glob: micromatch's `**` skips dot-prefixed
    // segments by default, but `shouldSkipDirectory` already filters unwanted
    // dot-dirs (.git, node_modules, etc.), so whitelisted ones like .skills
    // should always be reachable via `**`.
    const micromatchOpts: micromatch.Options = { dot: true }

    const startedAt = Date.now()
    const deadlineAt = startedAt + deadlineMs
    const matches: string[] = []
    const seenPaths = new Set<string>()
    let isTruncated = false
    let timedOut = false

    for (const { handle: searchHandle } of searchHandles) {
      if (isTruncated || timedOut) break

      const stack: Array<{ handle: FileSystemDirectoryHandle; fullPath: string; localPath: string; depth: number }> =
        [{ handle: searchHandle, fullPath: effectiveRoot, localPath: '', depth: 0 }]

      while (stack.length > 0) {
        if (abortSignal?.aborted) {
          return toolErrorJson('ls', 'aborted', 'Glob search failed: operation aborted')
        }
        const current = stack.pop()!
        if (Date.now() > deadlineAt) {
          timedOut = true
          break
        }

        const handles = await readDirectoryEntriesSorted(current.handle)
        for (const handle of handles) {
          if (abortSignal?.aborted) {
            return toolErrorJson('ls', 'aborted', 'Glob search failed: operation aborted')
          }
          if (Date.now() > deadlineAt) {
            timedOut = true
            break
          }

          const nextDepth = current.depth + 1
          if (nextDepth > maxDepth) continue

          const fullPath = current.fullPath ? `${current.fullPath}/${handle.name}` : handle.name
          const localPath = current.localPath ? `${current.localPath}/${handle.name}` : handle.name

          if (handle.kind === 'directory') {
            if (shouldSkipDirectory(handle.name, includeIgnored, extraExcludes)) continue
            stack.push({
              handle: handle as FileSystemDirectoryHandle,
              fullPath,
              localPath,
              depth: nextDepth,
            })
            continue
          }

          // Deduplicate by path (native FS takes precedence)
          if (seenPaths.has(fullPath)) continue
          seenPaths.add(fullPath)

          if (micromatch.isMatch(fullPath, pattern, micromatchOpts) || micromatch.isMatch(localPath, pattern, micromatchOpts)) {
            matches.push(fullPath)
            if (maxResults !== undefined && matches.length >= maxResults) {
              isTruncated = true
              break
            }
          }
        }
        if (isTruncated || timedOut) break
      }
    }

    // Hybrid projects (mirrors search.tool.ts): native-host roots never appear
    // in searchHandles (no FileSystemDirectoryHandle), so an unscoped glob must
    // additionally scan them via the disk scanner and merge the matches.
    if (!isTruncated && !timedOut && scope.kind === 'workspace' && !scope.subPath) {
      const nativeRoots = await listNativeHostRootNames(toolContext)
      if (nativeRoots.length > 0) {
        const collected = await collectNativeHostGlobMatches(toolContext, args, pattern, nativeRoots)
        for (const match of collected.matches) {
          if (seenPaths.has(match)) continue
          seenPaths.add(match)
          matches.push(match)
          if (maxResults !== undefined && matches.length >= maxResults) {
            isTruncated = true
            break
          }
        }
        if (collected.truncated) isTruncated = true
      }
    }

    if (timedOut) {
      return toolErrorJson('ls', 'deadline_exceeded', `Glob scan exceeded deadline ${deadlineMs}ms. Narrow pattern/path or increase deadline_ms.`, { retryable: true, details: { matchedSoFar: matches.length } })
    }

    if (matches.length === 0) {
      return toolOkJson('ls', [], { _hint: `No files matching pattern "${pattern}"${scope.subPath ? ` in ${scope.subPath}` : ''}` })
    }

    return toolOkJson('ls', matches.map(m => ({ name: m.split('/').pop() || m, path: m, kind: 'file' as const })), {
      ...(isTruncated ? { truncated: true, maxResults } : {}),
    })
  } catch (error) {
    return toolErrorJson('ls', 'glob_failed', `Glob search failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const lsPromptDoc: ToolPromptDoc = {
  category: 'file-ops',
  section: '### File Discovery',
  lines: [
    '- `ls()` - List root directories (in multi-root: shows all root names)',
    '- `ls(pattern)` - Find files by pattern (e.g., "**/*.csv", "src/**/*.tsx")',
    '- `ls(path)` - Show directory structure',
  ],
}

/**
 * Fallback for native-host roots that have no FileSystemDirectoryHandle.
 * Tries WorkspaceRuntime.scanDiskTree() which uses the DiskExecutor API.
 * Returns null if the path is not a native-host root (caller continues normally).
 */
async function tryNativeHostDiskScan(
  rawPath: string,
  toolContext: ToolContext,
  args: Record<string, unknown>
): Promise<string | null> {
  try {
    if (!toolContext.workspaceId) return null
    const { getWorkspaceManager } = await import('@/opfs')
    const manager = await getWorkspaceManager()
    const workspace = await manager.getWorkspace(toolContext.workspaceId)
    if (!workspace) return null

    const rawMaxDepth = args.max_depth ?? args.maxDepth
    const maxDepth = typeof rawMaxDepth === 'number' ? Math.min(Math.max(1, rawMaxDepth), 10) : 2
    const maxEntriesRaw = args.max_entries ?? args.maxEntries
    const maxEntries = typeof maxEntriesRaw === 'number' && Number.isFinite(maxEntriesRaw)
      ? Math.min(Math.max(1, maxEntriesRaw), 50000)
      : undefined
    const includeSizes = args.include_sizes === true || args.includeSizes === true
    const extraExcludes = parseStringList(args.exclude_dirs ?? args.excludeDirs)
    const deadlineMs = typeof args.deadline_ms === 'number' ? args.deadline_ms : 25000

    const entries = await workspace.scanDiskTree(
      rawPath,
      maxDepth,
      toolContext.projectId,
      { includeSizes, excludeDirs: extraExcludes, maxEntries, deadlineMs }
    )

    if (entries === null) return null // not a native-host root

    // Format results identically to handle-based scan
    const formatted = entries
      .filter((e) => e.type === 'file' || e.depth <= maxDepth)
      .map((e) => ({
        name: e.path.split('/').pop() || e.path,
        path: e.path,
        kind: e.type === 'file' ? 'file' : 'directory',
        ...(e.size ? { size: e.size } : {}),
      }))

    const result = toolOkJson('ls', formatted)
    return result
  } catch {
    return null
  }
}

/**
 * List native-host root names for the project from the DB root registry.
 * Native-host roots expose no FileSystemDirectoryHandle, so they are invisible
 * to getRuntimeHandlesForProject (mirrors listNativeHostRootNames in
 * search.tool.ts). Returns [] when the registry is unavailable.
 */
async function listNativeHostRootNames(toolContext: ToolContext): Promise<string[]> {
  if (!toolContext.projectId) return []
  try {
    const { getProjectRootRepository } = await import('@/sqlite/repositories/project-root.repository')
    const roots = await getProjectRootRepository().findByProject(toolContext.projectId)
    return roots
      .filter((root: { name: string; backend?: string }) => root.backend === 'native-host')
      .map((root: { name: string }) => root.name)
  } catch {
    return []
  }
}

/** WorkspaceRuntime shape needed for disk scans (duck-typed for tests). */
type NativeHostWorkspace = {
  scanDiskTree: (
    path: string,
    maxDepth: number,
    projectId?: string | null,
    options?: { includeSizes?: boolean; excludeDirs?: string[]; maxEntries?: number; deadlineMs?: number }
  ) => Promise<Array<{ path: string; type: 'file' | 'directory'; size: number; depth: number }> | null>
}

/** Resolve the workspace runtime for native-host disk scans, or null. */
async function getNativeHostWorkspace(toolContext: ToolContext): Promise<NativeHostWorkspace | null> {
  if (!toolContext.workspaceId) return null
  try {
    const { getWorkspaceManager } = await import('@/opfs')
    const manager = await getWorkspaceManager()
    const workspace = await manager.getWorkspace(toolContext.workspaceId)
    if (!workspace || typeof workspace.scanDiskTree !== 'function') return null
    return workspace as unknown as NativeHostWorkspace
  } catch {
    return null
  }
}

/**
 * Glob native-host roots via the disk scanner (WorkspaceRuntime.scanDiskTree).
 * Match paths are prefixed with the scan root (`rootName/...`) so results are
 * fully qualified, mirroring searchNativeHostRoots in search.tool.ts.
 * Never throws — returns { available: false } when the disk scanner is unusable.
 */
async function collectNativeHostGlobMatches(
  toolContext: ToolContext,
  args: Record<string, unknown>,
  pattern: string,
  scanPaths: string[]
): Promise<{ available: boolean; matches: string[]; truncated: boolean }> {
  const workspace = await getNativeHostWorkspace(toolContext)
  if (!workspace) return { available: false, matches: [], truncated: false }

  const maxDepth = parseBoundedInt(args.max_depth ?? args.maxDepth, 20, 1, 64)
  const maxResultsRaw = args.max_results ?? args.maxResults ?? args.max_entries ?? args.maxEntries
  const maxResults =
    typeof maxResultsRaw === 'number' && Number.isFinite(maxResultsRaw)
      ? parseBoundedInt(maxResultsRaw, 1, 1, 100000)
      : undefined
  const excludeDirs = parseStringList(args.exclude_dirs ?? args.excludeDirs)
  const deadlineMs = parseBoundedInt(args.deadline_ms ?? args.deadlineMs, 25000, 1000, 28000)
  const micromatchOpts: micromatch.Options = { dot: true }

  const matches: string[] = []
  let truncated = false

  for (const scanPath of scanPaths) {
    let entries: Awaited<ReturnType<NativeHostWorkspace['scanDiskTree']>> = null
    try {
      entries = await workspace.scanDiskTree(scanPath, maxDepth, toolContext.projectId, {
        excludeDirs,
        maxEntries: 20_000,
        deadlineMs,
      })
    } catch {
      entries = null
    }
    if (entries === null) continue // not a native-host path — skip this root
    if (entries.length >= 20_000) truncated = true

    for (const entry of entries) {
      if (entry.type !== 'file') continue
      const fullPath = `${scanPath}/${entry.path}`
      if (
        micromatch.isMatch(fullPath, pattern, micromatchOpts) ||
        micromatch.isMatch(entry.path, pattern, micromatchOpts)
      ) {
        matches.push(fullPath)
        if (maxResults !== undefined && matches.length >= maxResults) {
          truncated = true
          break
        }
      }
    }
    if (truncated && maxResults !== undefined && matches.length >= maxResults) break
  }

  return { available: true, matches, truncated }
}

/** Format native-host glob results identically to handle-based glob output. */
function formatNativeHostGlobResult(
  args: Record<string, unknown>,
  collected: { matches: string[]; truncated: boolean },
  pattern: string,
  scopePath: string
): string {
  const maxResultsRaw = args.max_results ?? args.maxResults ?? args.max_entries ?? args.maxEntries
  const maxResults =
    typeof maxResultsRaw === 'number' && Number.isFinite(maxResultsRaw)
      ? parseBoundedInt(maxResultsRaw, 1, 1, 100000)
      : undefined

  if (collected.matches.length === 0) {
    return toolOkJson('ls', [], {
      _hint: `No files matching pattern "${pattern}"${scopePath ? ` in ${scopePath}` : ''}`,
    })
  }

  return toolOkJson(
    'ls',
    collected.matches.map((m) => ({ name: m.split('/').pop() || m, path: m, kind: 'file' as const })),
    {
      ...(collected.truncated ? { truncated: true, maxResults } : {}),
    }
  )
}

/**
 * List a native-host root path with "disk base + OPFS overlay" semantics,
 * mirroring the handle-based list mode (scan native FS, then merge OPFS-only
 * files). Disk entries take precedence; OPFS-only entries (pending changes,
 * unsynced write/edit, Python-created files) are appended so ls sees the same
 * files as Pyodide at /mnt/. Returns null when the path is not a native-host
 * root or the disk scanner is unavailable — caller falls through.
 */
async function listNativeHostWithOpfsMerge(
  rawPath: string,
  toolContext: ToolContext,
  args: Record<string, unknown>
): Promise<string | null> {
  const workspace = await getNativeHostWorkspace(toolContext)
  if (!workspace) return null

  const rawMaxDepth = args.max_depth ?? args.maxDepth
  const maxDepth = typeof rawMaxDepth === 'number' ? Math.min(Math.max(1, rawMaxDepth), 10) : 2
  const maxEntriesRaw = args.max_entries ?? args.maxEntries
  const maxEntries = typeof maxEntriesRaw === 'number' && Number.isFinite(maxEntriesRaw)
    ? Math.min(Math.max(1, maxEntriesRaw), 50000)
    : undefined
  const includeSizes = args.include_sizes === true || args.includeSizes === true
  const includeIgnored = args.include_ignored === true || args.includeIgnored === true
  const extraExcludes = parseStringList(args.exclude_dirs ?? args.excludeDirs)
  const deadlineMs = parseBoundedInt(args.deadline_ms ?? args.deadlineMs, 25000, 1000, 28000)
  const deadlineAt = Date.now() + deadlineMs

  // 1. Disk scan (base) — real files on the native host.
  let diskEntries: Awaited<ReturnType<NativeHostWorkspace['scanDiskTree']>> = null
  try {
    diskEntries = await workspace.scanDiskTree(rawPath, maxDepth, toolContext.projectId, {
      includeSizes,
      excludeDirs: extraExcludes,
      maxEntries,
      deadlineMs,
    })
  } catch {
    diskEntries = null
  }
  if (diskEntries === null) return null // not a native-host path

  const seenPaths = new Set<string>()
  const entries: Array<{ path: string; type: 'file' | 'directory'; size: number; depth: number }> = []
  for (const e of diskEntries) {
    seenPaths.add(e.path)
    entries.push(e)
  }
  let isTruncated = maxEntries !== undefined && diskEntries.length >= maxEntries

  // 2. Merge OPFS-only entries (pending changes, unsynced writes) — skipped
  //    when the disk scan already filled the entry budget.
  if (!isTruncated && Date.now() <= deadlineAt) {
    const opfsFilesHandle = await getOPFSFilesHandle(toolContext.workspaceId)
    if (opfsFilesHandle) {
      const trimmed = rawPath.replace(/\/+$/, '')
      const opfsResolved = await resolveDirectoryHandle(opfsFilesHandle, trimmed, { allowMissing: true })
      if (opfsResolved.exists) {
        const queue: Array<{ handle: FileSystemDirectoryHandle; path: string; depth: number }> = [
          { handle: opfsResolved.handle, path: '', depth: 0 },
        ]
        while (queue.length > 0) {
          if (Date.now() > deadlineAt) break
          const current = queue.shift()!
          const handles = await readDirectoryEntriesSorted(current.handle)
          for (const handle of handles) {
            if (Date.now() > deadlineAt) break
            const childDepth = current.depth + 1
            if (childDepth > maxDepth) continue
            const relPath = current.path ? `${current.path}/${handle.name}` : handle.name
            // Disk takes precedence — OPFS copies of disk files are stale until synced
            if (seenPaths.has(relPath)) continue
            if (handle.kind === 'directory') {
              if (shouldSkipDirectory(handle.name, includeIgnored, extraExcludes)) continue
              seenPaths.add(relPath)
              entries.push({ path: relPath, type: 'directory', size: 0, depth: childDepth })
              queue.push({ handle: handle as FileSystemDirectoryHandle, path: relPath, depth: childDepth })
            } else {
              seenPaths.add(relPath)
              let size = 0
              if (includeSizes) {
                try {
                  const file = await (handle as FileSystemFileHandle).getFile()
                  size = file.size
                } catch { size = 0 }
              }
              entries.push({ path: relPath, type: 'file', size, depth: childDepth })
            }
            if (maxEntries !== undefined && entries.length >= maxEntries) {
              isTruncated = true
              break
            }
          }
          if (isTruncated) break
        }
      }
    }
  }

  // Format results identically to tryNativeHostDiskScan
  const formatted = entries
    .filter((e) => e.type === 'file' || e.depth <= maxDepth)
    .slice(0, maxEntries)
    .map((e) => ({
      name: e.path.split('/').pop() || e.path,
      path: e.path,
      kind: e.type === 'file' ? 'file' : 'directory',
      ...(e.size ? { size: e.size } : {}),
    }))

  return toolOkJson('ls', formatted, {
    ...(isTruncated ? { truncated: true, maxEntries } : {}),
  })
}

/**
 * Glob the OPFS mirror subtree for a native-host root path (pending changes,
 * unsynced writes) and return root-prefixed matches (`rootName/...`).
 * Returns an empty array when the subtree does not exist. Never throws.
 */
async function collectOpfsGlobMatches(
  toolContext: ToolContext,
  args: Record<string, unknown>,
  pattern: string,
  scanPath: string
): Promise<string[]> {
  const matches: string[] = []
  try {
    const opfsFilesHandle = await getOPFSFilesHandle(toolContext.workspaceId)
    if (!opfsFilesHandle) return matches
    const trimmed = scanPath.replace(/\/+$/, '')
    const resolved = await resolveDirectoryHandle(opfsFilesHandle, trimmed, { allowMissing: true })
    if (!resolved.exists) return matches

    const maxDepth = parseBoundedInt(args.max_depth ?? args.maxDepth, 20, 1, 64)
    const maxResultsRaw = args.max_results ?? args.maxResults ?? args.max_entries ?? args.maxEntries
    const maxResults =
      typeof maxResultsRaw === 'number' && Number.isFinite(maxResultsRaw)
        ? parseBoundedInt(maxResultsRaw, 1, 1, 100000)
        : undefined
    const includeIgnored = args.include_ignored === true || args.includeIgnored === true
    const extraExcludes = parseStringList(args.exclude_dirs ?? args.excludeDirs)
    const deadlineMs = parseBoundedInt(args.deadline_ms ?? args.deadlineMs, 25000, 1000, 28000)
    const deadlineAt = Date.now() + deadlineMs
    const micromatchOpts: micromatch.Options = { dot: true }

    const stack: Array<{ handle: FileSystemDirectoryHandle; relPath: string; depth: number }> = [
      { handle: resolved.handle, relPath: '', depth: 0 },
    ]
    while (stack.length > 0) {
      if (Date.now() > deadlineAt) break
      const current = stack.pop()!
      const handles = await readDirectoryEntriesSorted(current.handle)
      for (const handle of handles) {
        if (Date.now() > deadlineAt) return matches
        const nextDepth = current.depth + 1
        if (nextDepth > maxDepth) continue
        const relPath = current.relPath ? `${current.relPath}/${handle.name}` : handle.name
        if (handle.kind === 'directory') {
          if (shouldSkipDirectory(handle.name, includeIgnored, extraExcludes)) continue
          stack.push({ handle: handle as FileSystemDirectoryHandle, relPath, depth: nextDepth })
          continue
        }
        const fullPath = `${trimmed}/${relPath}`
        if (
          micromatch.isMatch(fullPath, pattern, micromatchOpts) ||
          micromatch.isMatch(relPath, pattern, micromatchOpts)
        ) {
          matches.push(fullPath)
          if (maxResults !== undefined && matches.length >= maxResults) return matches
        }
      }
    }
  } catch {
    return matches
  }
  return matches
}
