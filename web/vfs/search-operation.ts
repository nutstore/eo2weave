import type { VfsBackend } from '@/agent/tools/vfs-backend'
import { searchBackend } from './generic-discovery'
import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from '@/agent/tools/tool-types'
import micromatch from 'micromatch'
import { getSearchWorkerManager } from '@/workers/search-worker-manager'
import type { PendingFileOverlay, SearchInDirectoryResult, FileSearchResult, SearchHit } from '@/workers/search-worker-manager'
import { useOPFSStore } from '@/store/opfs.store'
import { getWorkspaceManager } from '@/opfs'
import { resolveNativeDirectoryHandleForPath, withToolTimeout, isToolTimeoutError } from '@/agent/tools/tool-utils'
import { toolErrorJson, toolOkJson } from '@/agent/tools/tool-envelope'
import { checkSearchLoop } from '@/agent/tools/loop-guard'
import { resolveVfsTarget } from '@/agent/tools/vfs-resolver'
import { rewritePythonMountPathForNonPythonTool, validateRootPrefix } from '@/agent/tools/path-guards'
import { isSubagentPermissionDenied, SUBAGENT_PERMISSION_DENIED } from '@/agent/tools/agent-file-protection'

function looksRegexLikeQuery(query: string): boolean {
  // Detect high-confidence regex signals that strongly suggest the caller intended
  // a regex search but left mode at the default ("literal"). We only flag signals
  // that almost never appear in plain search terms, to avoid false upgrades.
  return (
    query.includes('|') || // OR alternation
    query.includes('.*') || // wildcard (zero or more)
    query.includes('.+') || // wildcard (one or more)
    /\\[dwsDWS]/.test(query) || // character class shorthands: \d \w \s + negated forms
    query.includes('(?') // lookahead / non-capturing group
  )
}

/**
 * Aggregate raw hit-level results into file-level results.
 *
 * For each file:
 * - Group all hits together
 * - Detect whether the filename matches the query (exact or partial)
 * - Pick the best preview line
 * - Sort: title exact match > title partial match > body-only matches
 *   (ties broken by match count descending)
 */
function aggregateResultsToFiles(
  hits: SearchHit[],
  query: string,
  useRegex: boolean,
  caseSensitive: boolean
): FileSearchResult[] {
  if (hits.length === 0) return []

  // Build a regex to test filename match (same semantics as the search itself)
  let testRegex: RegExp
  try {
    if (useRegex) {
      testRegex = new RegExp(query, caseSensitive ? '' : 'i')
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      testRegex = new RegExp(escaped, caseSensitive ? '' : 'i')
    }
  } catch {
    // If regex construction fails, skip title matching
    testRegex = /^$/ // never matches
  }

  // Group by file path
  const fileMap = new Map<string, SearchHit[]>()
  for (const hit of hits) {
    const arr = fileMap.get(hit.path) ?? []
    arr.push(hit)
    fileMap.set(hit.path, arr)
  }

  const files: FileSearchResult[] = []

  for (const [filePath, fileHits] of fileMap) {
    // Extract filename from path (last segment)
    const fileName = filePath.split('/').pop() ?? filePath

    // Determine title match level
    let titleMatch: FileSearchResult['titleMatch'] = false
    if (testRegex.test(fileName)) {
      // Check exact vs partial: exact = entire filename matches query (ignoring extension)
      const nameWithoutExt = fileName.replace(/\.[^.]+$/, '')
      if (
        nameWithoutExt === query ||
        (!useRegex && nameWithoutExt.toLowerCase() === query.toLowerCase())
      ) {
        titleMatch = 'exact'
      } else {
        titleMatch = 'partial'
      }
      // Reset regex lastIndex for safety
      testRegex.lastIndex = 0
    }

    // Pick best preview: first hit's preview is usually the best match
    // (or the first non-empty one)
    const bestHit = fileHits.find(h => h.preview && h.preview.trim()) ?? fileHits[0]

    files.push({
      path: filePath,
      matchCount: fileHits.length,
      titleMatch,
      bestPreview: bestHit?.preview ?? '',
      bestLine: bestHit?.line ?? 0,
      hits: fileHits,
    })
  }

  // Sort: title exact > title partial > body-only, then by matchCount desc
  const titlePriority = (t: FileSearchResult['titleMatch']): number => {
    if (t === 'exact') return 2
    if (t === 'partial') return 1
    return 0
  }
  files.sort((a, b) => {
    const pa = titlePriority(a.titleMatch)
    const pb = titlePriority(b.titleMatch)
    if (pa !== pb) return pb - pa // higher priority first
    return b.matchCount - a.matchCount // more matches first
  })

  return files
}

function parseStructuredError(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof Error) || !error.message) return null
  try {
    const parsed = JSON.parse(error.message) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

const NATIVE_SEARCH_DEFAULT_EXCLUDED_DIRS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
  '.turbo',
  '.pnpm-store',
]

function buildTextMatcher(
  query: string,
  options: { regex: boolean; caseSensitive: boolean; wholeWord: boolean }
): RegExp {
  const flags = options.caseSensitive ? 'g' : 'gi'
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const source = options.regex ? query : escaped
  return new RegExp(options.wholeWord ? `\\b(?:${source})\\b` : source, flags)
}

function findTextMatches(
  path: string,
  text: string,
  matcher: RegExp,
  contextLines: number,
  maxMatches: number
): SearchHit[] {
  const lines = text.split('\n')
  const hits: SearchHit[] = []
  for (let index = 0; index < lines.length && hits.length < maxMatches; index++) {
    const line = lines[index]
    matcher.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = matcher.exec(line)) !== null && hits.length < maxMatches) {
      const start = Math.max(0, index - contextLines)
      const end = Math.min(lines.length, index + contextLines + 1)
      hits.push({
        path,
        line: index + 1,
        column: (match.index ?? 0) + 1,
        match: match[0],
        preview: contextLines > 0
          ? lines.slice(start, end).join('\n')
          : truncateSearchPreview(line, (match.index ?? 0) + 1),
      })
      if (match.index === matcher.lastIndex) matcher.lastIndex++
    }
  }
  return hits
}

function truncateSearchPreview(line: string, column: number): string {
  const maxLength = 200
  if (line.length <= maxLength) return line
  const budget = maxLength - 6
  const start = Math.max(0, column - 1 - Math.floor(budget / 2))
  const end = start + budget
  return `${start > 0 ? '...' : ''}${line.slice(start, end)}${end < line.length ? '...' : ''}`
}

function asSearchText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (content instanceof Uint8Array) return new TextDecoder().decode(content)
  if (content instanceof ArrayBuffer) return new TextDecoder().decode(content)
  return null
}

/**
 * List Native Host root names for the project (from the DB root registry).
 * Returns null when the registry/workspace is unavailable — callers treat that
 * as "no native-host roots" rather than an error.
 */
async function listNativeHostRootNames(
  context: { projectId?: string | null }
): Promise<string[] | null> {
  if (!context.projectId) return null
  try {
    const { getProjectRootRepository } = await import('@/sqlite/repositories/project-root.repository')
    const roots = await getProjectRootRepository().findByProject(context.projectId)
    return roots.filter(root => root.backend === 'native-host').map(root => root.name)
  } catch {
    return null
  }
}

/**
 * Merge a secondary SearchInDirectoryResult (e.g. native-host disk scan) into a
 * primary one in place. Used for hybrid projects where OPFS/FS Access handles
 * and Native Host roots must both be covered by a single search.
 */
function mergeSearchResults(into: SearchInDirectoryResult, from: SearchInDirectoryResult): void {
  into.results.push(...from.results)
  into.totalMatches += from.totalMatches
  into.scannedFiles += from.scannedFiles
  into.skippedFiles += from.skippedFiles
  if (from.truncated) into.truncated = true
  if (from.deadlineExceeded) into.deadlineExceeded = true
}

/**
 * Search roots backed by the Native Messaging host. These roots deliberately do
 * not expose FileSystemDirectoryHandle, so they cannot be passed to the search
 * worker; scan and read through WorkspaceRuntime instead.
 */
async function searchNativeHostRoots(
  context: { workspaceId?: string | null; projectId?: string | null },
  searchPath: string,
  options: {
    query: string
    regex: boolean
    caseSensitive: boolean
    wholeWord: boolean
    glob?: string
    maxResults: number
    contextLines: number
    deadlineMs: number
    maxFileSize: number
    excludeDirs: string[]
  }
): Promise<SearchInDirectoryResult | null> {
  if (!context.workspaceId || !context.projectId) return null

  const manager = await getWorkspaceManager()
  const workspace = await manager.getWorkspace(context.workspaceId)
  if (!workspace) return null

  const { getProjectRootRepository } = await import('@/sqlite/repositories/project-root.repository')
  const roots = (await getProjectRootRepository().findByProject(context.projectId))
    .filter(root => root.backend === 'native-host')
  if (roots.length === 0) return null

  const requestedRoot = searchPath.split('/')[0]
  const scopes = searchPath
    ? roots.filter(root => root.name === requestedRoot).map(() => ({ path: searchPath, prefix: searchPath }))
    : roots.map(root => ({ path: root.name, prefix: root.name }))
  if (scopes.length === 0) return null

  const result: SearchInDirectoryResult = {
    results: [],
    files: [],
    totalMatches: 0,
    scannedFiles: 0,
    skippedFiles: 0,
    truncated: false,
    deadlineExceeded: false,
  }
  const deadlineAt = Date.now() + Math.max(1000, options.deadlineMs)
  const matcher = buildTextMatcher(options.query, options)
  const excludeDirs = [...NATIVE_SEARCH_DEFAULT_EXCLUDED_DIRS, ...options.excludeDirs]

  for (const scope of scopes) {
    if (Date.now() > deadlineAt) {
      result.deadlineExceeded = true
      break
    }
    const entries = await workspace.scanDiskTree(scope.path, 50, context.projectId, {
      includeSizes: true,
      excludeDirs,
      maxEntries: 20_000,
      deadlineMs: Math.max(1000, deadlineAt - Date.now()),
    })
    if (entries === null) return null
    if (entries.length >= 20_000) result.truncated = true

    // scanDiskTree lists directory contents. If the requested path is a file,
    // fall back to reading that file directly.
    const files = entries.filter(entry => entry.type === 'file').map(entry => ({
      relativePath: entry.path,
      path: `${scope.prefix}/${entry.path}`,
      size: entry.size,
    }))
    if (searchPath && files.length === 0) {
      files.push({ relativePath: '', path: searchPath, size: 0 })
    }

    for (const file of files) {
      if (Date.now() > deadlineAt) {
        result.deadlineExceeded = true
        break
      }
      if (options.glob && !micromatch.isMatch(file.relativePath || file.path.split('/').pop()!, options.glob, { dot: true })) continue
      if (file.size > options.maxFileSize) {
        result.skippedFiles++
        continue
      }
      try {
        const read = await workspace.readFile(file.path, null, { projectId: context.projectId })
        const text = asSearchText(read.content)
        if (text === null || text.slice(0, 1024).includes('\0') || new TextEncoder().encode(text).length > options.maxFileSize) {
          result.skippedFiles++
          continue
        }
        result.scannedFiles++
        const remaining = Math.max(0, options.maxResults - result.results.length)
        const hits = findTextMatches(file.path, text, matcher, options.contextLines, remaining)
        result.results.push(...hits)
        result.totalMatches += hits.length
        if (result.results.length >= options.maxResults) {
          result.truncated = true
          break
        }
      } catch {
        // A directory or unreadable file is simply not searchable.
        result.skippedFiles++
      }
    }
    if (result.truncated || result.deadlineExceeded) break
  }

  return result
}

/**
 * Collect pending file overlays from OPFS for the current workspace.
 * This ensures search results are consistent with the read tool,
 * which reads from OPFS cache for files with pending modifications.
 */
async function collectPendingOverlays(
  workspaceId?: string | null,
  projectId?: string | null
): Promise<Record<string, PendingFileOverlay>> {
  try {
    const pendingChanges = useOPFSStore.getState().getPendingChanges()
    if (!pendingChanges || pendingChanges.length === 0) return {}

    // Get workspace to read cached content
    // workspaceId is always provided by the agent loop. If missing, return empty.
    if (!workspaceId) return {}

    const manager = await getWorkspaceManager()
    const workspace = await manager.getWorkspace(workspaceId)
    if (!workspace) return {}

    const overlays: Record<string, PendingFileOverlay> = {}

    for (const change of pendingChanges) {
      if (change.type === 'delete') {
        overlays[change.path] = { deleted: true }
        continue
      }

      // For modify/create, read the cached content from OPFS
      try {
        const result = await workspace.readFile(change.path, null, { projectId })
        // ReadResult.content can be string | Uint8Array | ArrayBuffer. Decode
        // bytes-shaped variants so binary-cached files still produce a usable
        // search overlay (otherwise the worker falls back to disk content).
        if (typeof result.content === 'string') {
          overlays[change.path] = { content: result.content }
        } else if (result.content instanceof Uint8Array) {
          overlays[change.path] = { content: new TextDecoder().decode(result.content) }
        } else if (result.content instanceof ArrayBuffer) {
          overlays[change.path] = { content: new TextDecoder().decode(result.content) }
        }
      } catch {
        // If we can't read the cached content, skip the overlay
        // and let the worker fall back to disk content
      }
    }

    return overlays
  } catch {
    // Non-critical: if overlay collection fails, search still works from disk
    return {}
  }
}

/**
 * Strip root prefix from overlay keys so they match worker's relative paths.
 *
 * The OPFS store records paths like "creatorweave/web/package.json" (with root prefix),
 * but the search worker traverses files relative to each root handle, producing paths
 * like "package.json". This function filters overlays to only those belonging to the
 * given root and strips the root prefix.
 */
function stripOverlayRootPrefix(
  overlays: Record<string, PendingFileOverlay>,
  rootName: string
): Record<string, PendingFileOverlay> {
  if (!rootName) return overlays
  const prefix = rootName + '/'
  const result: Record<string, PendingFileOverlay> = {}
  for (const [key, value] of Object.entries(overlays)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value
    }
  }
  return result
}

/**
 * Get all root handles for the current project (multi-root aware).
 * workspaceId is always provided by the agent loop.
 */
async function getAllRootHandles(
  context: { workspaceId?: string | null; directoryHandle?: FileSystemDirectoryHandle | null; projectId?: string | null }
): Promise<Map<string, FileSystemDirectoryHandle>> {
  try {
    const manager = await getWorkspaceManager()
    const workspaceId = context.workspaceId
    if (!workspaceId) {
      // workspaceId is always provided — if missing, that's a caller bug.
      // Return empty rather than guessing from global state.
      return new Map()
    }

    const workspace = await manager.getWorkspace(workspaceId)
    if (workspace) {
      const handles = await workspace.getAllNativeDirectoryHandles(context.projectId)
      if (handles.size > 0) return handles
    }

    // Workspace found but no native handles, or workspace not found.
    // Try projectId as a secondary resolution (not a global fallback).
    if (context.projectId) {
      const { getRuntimeHandlesForProject } = await import('@/native-fs')
      const handles = getRuntimeHandlesForProject(context.projectId)
      if (handles.size > 0) return handles
    }
  } catch {
    // Fall through
  }
  // Fallback: single root from context
  if (context.directoryHandle) {
    return new Map([['', context.directoryHandle]])
  }
  return new Map()
}

/**
 * Search all roots sequentially and merge results.
 * Prepends root prefix to each hit's path for correct routing.
 */
async function searchAllRoots(
  manager: ReturnType<typeof getSearchWorkerManager>,
  rootHandles: Map<string, FileSystemDirectoryHandle>,
  baseOptions: Omit<Parameters<typeof manager.searchInDirectory>[1], never>,
  maxResults: number
): Promise<SearchInDirectoryResult> {
  const merged: SearchInDirectoryResult = {
    results: [],
    files: [],
    totalMatches: 0,
    scannedFiles: 0,
    skippedFiles: 0,
    truncated: false,
    deadlineExceeded: false,
  }
  let remaining = maxResults

  for (const [rootName, handle] of rootHandles) {
    if (remaining <= 0) {
      merged.truncated = true
      break
    }

    try {
      const rootOverlays = stripOverlayRootPrefix(
        (baseOptions.pendingOverlays as Record<string, PendingFileOverlay>) ?? {},
        rootName
      )
      const opts = { ...baseOptions, maxResults: remaining, pendingOverlays: Object.keys(rootOverlays).length > 0 ? rootOverlays : undefined }
      const rootResult = await manager.searchInDirectory(handle, opts)

      // Prepend root prefix to paths
      if (rootName) {
        for (const hit of rootResult.results) {
          hit.path = `${rootName}/${hit.path}`
        }
      }

      merged.results.push(...rootResult.results)
      merged.totalMatches += rootResult.totalMatches
      merged.scannedFiles += rootResult.scannedFiles
      merged.skippedFiles += rootResult.skippedFiles
      if (rootResult.truncated) merged.truncated = true
      if (rootResult.deadlineExceeded) merged.deadlineExceeded = true

      remaining -= rootResult.results.length
    } catch {
      // Skip roots that fail (e.g., permission denied)
    }
  }

  return merged
}

export const searchDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'search',
    description:
      'Search keyword/pattern in file contents and return matched file/line locations. ' +
      'Use this before read() when you need to locate relevant code or text quickly. ' +
      'TIP: Prefer English keywords for search queries (most source code and identifiers use English). ' +
      'If English results are poor, retry with the user\'s language (e.g. Chinese comments).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Required search query (use mode="literal" for plain text or mode="regex" for patterns). Prefer English keywords since source code is typically in English. If no results, try the user\'s native language (e.g. Chinese for comments/docs).',
        },
        path: {
          type: 'string',
          description: 'Optional subdirectory path to search within. MUST include rootName prefix (e.g., "frontend/src"). In multi-root projects, use root prefix to scope search.',
        },
        glob: {
          type: 'string',
          description: 'Optional file filter glob (example: "**/*.{ts,tsx}").',
        },
        mode: {
          type: 'string',
          enum: ['literal', 'regex'],
          description: 'Search mode: "literal" for plain text (default), "regex" for regular expressions. Optional — if omitted, defaults to "literal", and the engine auto-upgrades to regex if the query looks like one.',
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Case-sensitive matching. Default false.',
        },
        whole_word: {
          type: 'boolean',
          description: 'Match whole word only. Default false.',
        },
        max_results: {
          type: 'number',
          description: 'Maximum matches to return. Default 50.',
        },
        context_lines: {
          type: 'number',
          description: 'Context lines before/after matched line in preview. Default 0.',
        },
        deadline_ms: {
          type: 'number',
          description: 'Search time budget in milliseconds. Default 25000.',
        },
        timeout: {
          type: 'number',
          description: 'Maximum total execution time in milliseconds (default: 30000). Caps the entire search operation including overlay collection and multi-root traversal.',
        },
        max_file_size: {
          type: 'number',
          description: 'Skip files larger than this byte size. Default 1MB.',
        },
        include_ignored: {
          type: 'boolean',
          description: 'Include ignored directories like node_modules/.git. Default false.',
        },
        exclude_dirs: {
          type: 'array',
          description: 'Extra directory names to exclude.',
          items: { type: 'string' },
        },
      },
      required: ['query'],
    },
  },
}

export const searchExecutor: ToolExecutor = async (args, context) => {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  const timeoutMs = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : 30_000
  if (!query) {
    return toolErrorJson('search', 'invalid_arguments', 'query is required')
  }
  // mode is optional — default to "literal" to reduce parameter burden on the LLM.
  const mode = typeof args.mode === 'string' ? args.mode : 'literal'
  if (args.mode !== undefined && mode !== 'literal' && mode !== 'regex') {
    return toolErrorJson('search', 'invalid_arguments', 'mode must be one of: literal, regex (default: literal)')
  }
  let useRegex = mode === 'regex'
  let autoUpgradedToRegex = false
  if (!useRegex && looksRegexLikeQuery(query)) {
    // Tolerant (Do-What-I-Mean) handling: instead of erroring out and wasting an
    // agent loop turn on a pedantic rejection, auto-upgrade to regex mode when the
    // query compiles as a valid regex. If compilation fails, fall back to literal
    // mode (the worker will escape special chars and search for the exact text).
    try {
      new RegExp(query)
      useRegex = true
      autoUpgradedToRegex = true
    } catch {
      useRegex = false // invalid regex — keep literal mode
    }
  }

  // 根据 contextUsage 智能调整 max_results
  let userMaxResults = typeof args.max_results === 'number' ? args.max_results : 50

  // 如果上下文已经用了 50% 以上，进一步减少默认结果数量
  if (context.contextUsage && args.max_results === undefined) {
    const usageRatio = context.contextUsage.usedTokens / context.contextUsage.maxTokens
    if (usageRatio > 0.6) {
      userMaxResults = 25
    } else if (usageRatio > 0.4) {
      userMaxResults = 35
    }
  }

  // Loop guard: check consecutive search counter before searching
  const rawSearchPath = typeof args.path === 'string' ? args.path : ''

  // Validate root prefix before any path rewriting
  if (rawSearchPath) {
    const rootError = await validateRootPrefix('search', rawSearchPath, context)
    if (rootError) return rootError
  }

  const rewrittenSearchPath = rewritePythonMountPathForNonPythonTool(rawSearchPath)
  const searchPath = rewrittenSearchPath?.rewritten ? rewrittenSearchPath.rewrittenPath : rawSearchPath
  const searchGlob = typeof args.glob === 'string' ? args.glob : undefined
  const loopCheck = checkSearchLoop(context, query, searchPath, searchGlob, 0, userMaxResults)
  if (loopCheck.isBlocked) {
    return toolErrorJson(
      'search',
      'loop_blocked',
      `BLOCKED: You have run this exact search ${loopCheck.consecutive} times in a row. ` +
        'The results have NOT changed. You already have this information. ' +
        'STOP re-searching and proceed with your task.',
      { hint: 'Stop searching and proceed with your task using the results you already have.' }
    )
  }

  let genericBackend: VfsBackend | null = null
  let directoryHandle: FileSystemDirectoryHandle | null = null
  let vfsSubPath = '' // sub-path within the resolved VFS namespace
  let resolvedRootName: string | undefined // root name for overlay prefix stripping
  // Non-empty when searchPath was routed to a Native Host root (no FileSystemDirectoryHandle).
  let nativeHostRoutePath: string | null = null

  // VFS path support: resolve vfs:// URIs to directory handles via backends
  if (searchPath.startsWith('vfs://')) {
    try {
      const resolved = await resolveVfsTarget(searchPath, context, 'list', { allowEmptyPath: true })
      vfsSubPath = resolved.path
      const backendHandle = await resolved.backend.getDirectoryHandle?.()
      if (!backendHandle) genericBackend = resolved.backend
      directoryHandle = backendHandle ?? null
    } catch (error) {
      if (isSubagentPermissionDenied(error)) {
        return toolErrorJson('search', SUBAGENT_PERMISSION_DENIED, error.message)
      }
      return toolErrorJson('search', 'path_not_found', `Failed to resolve VFS path: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    // Multi-root aware path resolution (mirrors ls.tool.ts resolveDiscoveryScope logic):
    // 1. Check if first segment of path matches a known root name
    // 2. If so, route to that root's handle directly (avoids fallback to wrong context.directoryHandle)
    // 3. Otherwise fall through to generic resolveNativeDirectoryHandleForPath
    let rootRouted = false
    try {
      const { getRuntimeHandlesForProject } = await import('@/native-fs')
      const projectId = context.projectId
      if (projectId && searchPath) {
        const allHandles = getRuntimeHandlesForProject(projectId)
        if (allHandles.size > 0) {
          const segments = searchPath.split('/')
          const maybeRoot = segments[0]
          if (allHandles.has(maybeRoot)) {
            const rootHandle = allHandles.get(maybeRoot)!
            directoryHandle = rootHandle
            vfsSubPath = segments.slice(1).join('/')
            resolvedRootName = maybeRoot
            rootRouted = true
          }
        }
        // Native Host roots deliberately expose no FileSystemDirectoryHandle and
        // are therefore invisible to getRuntimeHandlesForProject. Consult the DB
        // root registry so paths like "rootName/web/src" route to the disk scanner
        // instead of silently falling through to the OPFS workspace handle — that
        // fall-through made search return scannedFiles: 0 (no error) for
        // native-host-backed projects.
        if (!rootRouted) {
          const { getProjectRootRepository } = await import('@/sqlite/repositories/project-root.repository')
          const nativeRootNames = (await getProjectRootRepository().findByProject(projectId))
            .filter(root => root.backend === 'native-host')
            .map(root => root.name)
          if (nativeRootNames.includes(searchPath.split('/')[0])) {
            nativeHostRoutePath = searchPath
            rootRouted = true
          }
        }
      }
    } catch { /* fall through to generic resolution */ }

    if (!rootRouted) {
      const { handle, nativePath } = await resolveNativeDirectoryHandleForPath(
        searchPath, context.directoryHandle, context.workspaceId
      )
      directoryHandle = handle
      vfsSubPath = nativePath
    }
  }

  if (!directoryHandle && !genericBackend && searchPath.startsWith('vfs://')) {
    return toolErrorJson('search', 'no_active_workspace', 'No active workspace')
  }

  try {
    const manager = getSearchWorkerManager()
    const userContextLines = typeof args.context_lines === 'number' ? args.context_lines : 0

    // 当结果数量多时，自动减少上下文行数以控制返回大小
    let contextLines = userContextLines
    if (userMaxResults > 100 && userContextLines > 3) {
      // 结果很多且上下文很多时，降低上下文行数
      contextLines = Math.min(userContextLines, 3)
    }

    // Collect pending overlays from OPFS to ensure search consistency with read tool
    const pendingOverlays = genericBackend ? {} : await collectPendingOverlays(context.workspaceId, context.projectId)

    // Inflate maxResults for the worker to collect enough raw hits across many files.
    // The user-facing limit is per-file (after aggregation), but the worker limit is
    // per-hit. Without inflation, one high-frequency file could exhaust the budget
    // before other files even appear. We use a generous fixed ceiling so that
    // aggregation can discover as many distinct files as possible.
    const internalMaxResults = 10000

    // Build search options; rootName is used to strip the root prefix from overlay keys
    // so they match the worker's relative file paths.
    const buildSearchOptions = (subPath?: string, rootName?: string) => {
      const rawOverlays = Object.keys(pendingOverlays).length > 0 ? pendingOverlays : undefined
      const strippedOverlays = rootName
        ? (() => {
            const s = stripOverlayRootPrefix(pendingOverlays, rootName)
            return Object.keys(s).length > 0 ? s : undefined
          })()
        : rawOverlays
      return {
        query,
        path: subPath,
        glob: typeof args.glob === 'string' ? args.glob : undefined,
        regex: useRegex,
        caseSensitive: args.case_sensitive === true,
        wholeWord: args.whole_word === true,
        maxResults: internalMaxResults,
        contextLines,
        deadlineMs: typeof args.deadline_ms === 'number' ? args.deadline_ms : 60000,
        maxFileSize: typeof args.max_file_size === 'number' ? args.max_file_size : undefined,
        includeIgnored: args.include_ignored === true,
        excludeDirs: Array.isArray(args.exclude_dirs)
          ? args.exclude_dirs.filter((v): v is string => typeof v === 'string')
          : undefined,
        pendingOverlays: strippedOverlays,
      }
    }

    // Determine whether to search a single root or all roots
    let result: SearchInDirectoryResult

    if (genericBackend) {
      const matcher = buildTextMatcher(query, { regex: useRegex, caseSensitive: args.case_sensitive === true, wholeWord: args.whole_word === true })
      result = await withToolTimeout(searchBackend(genericBackend, vfsSubPath, args, context,
        (path, text) => findTextMatches(path, text, matcher, contextLines, internalMaxResults)), timeoutMs, 'search')
    } else if (!directoryHandle || nativeHostRoutePath) {
      const nativeResult = await withToolTimeout(
        searchNativeHostRoots(context, nativeHostRoutePath ?? searchPath, {
          query,
          regex: useRegex,
          caseSensitive: args.case_sensitive === true,
          wholeWord: args.whole_word === true,
          glob: typeof args.glob === 'string' ? args.glob : undefined,
          maxResults: internalMaxResults,
          contextLines,
          deadlineMs: typeof args.deadline_ms === 'number' ? args.deadline_ms : 60000,
          maxFileSize: Math.max(1, typeof args.max_file_size === 'number' ? args.max_file_size : 1024 * 1024),
          excludeDirs: Array.isArray(args.exclude_dirs)
            ? args.exclude_dirs.filter((v): v is string => typeof v === 'string')
            : [],
        }),
        timeoutMs,
        'search',
      )
      if (!nativeResult) {
        return toolErrorJson('search', 'no_active_workspace', 'No active workspace')
      }
      result = nativeResult
    } else {
      // The heavy I/O (search worker + overlay collection) is wrapped with a
      // wall-clock timeout so a stalled worker doesn't hang the agent loop.
      result = await withToolTimeout(
        (async () => {
        if (searchPath) {
          // Specific path provided — search single resolved root
          // Use resolvedRootName (the actual root handle name, e.g. "creatorweave")
          // instead of searchPath, so stripOverlayRootPrefix strips only the root prefix,
          // leaving overlay keys that match the worker's relative paths (relative to root handle).
          const rootName = resolvedRootName || searchPath || undefined
          const r = await manager.searchInDirectory(directoryHandle, buildSearchOptions(vfsSubPath || undefined, rootName))

          // Prepend root prefix AND sub-path to hit paths so they are fully qualified.
          // The worker returns paths relative to the resolved sub-directory (vfsSubPath),
          // so we must reconstruct the full path: rootName/subPath/workerRelativePath.
          // (e.g. "creatorweave/web/src/i18n/index.ts" not "creatorweave/i18n/index.ts")
          if (resolvedRootName) {
            const prefix = vfsSubPath
              ? `${resolvedRootName}/${vfsSubPath}/`
              : `${resolvedRootName}/`
            for (const hit of r.results) {
              hit.path = `${prefix}${hit.path}`
            }
          }
          return r
        } else {
          // No path — search ALL roots and merge results
          const allHandles = await getAllRootHandles(context)
          if (allHandles.size <= 1) {
            // Single root or no multi-root — infer root name from handle map
            const singleRootName = allHandles.size === 1 ? [...allHandles.keys()][0] : undefined
            return manager.searchInDirectory(directoryHandle, buildSearchOptions(undefined, singleRootName))
          } else {
            // Multi-root: search each root and merge (searchAllRoots handles prefix stripping per root)
            return searchAllRoots(manager, allHandles, buildSearchOptions(), internalMaxResults)
          }
        }
        })(),
        timeoutMs,
        'search',
      )

      // Hybrid projects (OPFS/FS Access handles + Native Host roots): a non-null
      // directoryHandle above normally hides native-host roots entirely, because
      // searchNativeHostRoots is only reached when directoryHandle is null.
      // After the handle-based search completes, scan the native-host roots too
      // and merge, so an unscoped search covers the whole project.
      const nativeRootNames = await listNativeHostRootNames(context)
      if (nativeRootNames && nativeRootNames.length > 0) {
        const nativeResult = await withToolTimeout(
          searchNativeHostRoots(context, '', {
            query,
            regex: useRegex,
            caseSensitive: args.case_sensitive === true,
            wholeWord: args.whole_word === true,
            glob: typeof args.glob === 'string' ? args.glob : undefined,
            maxResults: internalMaxResults,
            contextLines,
            deadlineMs: typeof args.deadline_ms === 'number' ? args.deadline_ms : 60000,
            maxFileSize: Math.max(1, typeof args.max_file_size === 'number' ? args.max_file_size : 1024 * 1024),
            excludeDirs: Array.isArray(args.exclude_dirs)
              ? args.exclude_dirs.filter((v): v is string => typeof v === 'string')
              : [],
          }),
          timeoutMs,
          'search',
        )
        if (nativeResult) {
          mergeSearchResults(result, nativeResult)
        }
      }
    }

    // Aggregate raw hits into file-level results
    let files = aggregateResultsToFiles(
      result.results,
      query,
      useRegex,
      args.case_sensitive === true
    )

    // Truncate file-level results to the user's requested limit
    // (internalMaxResults was inflated to collect more hits for aggregation)
    const truncatedFiles = files.length > userMaxResults
    if (truncatedFiles) {
      files = files.slice(0, userMaxResults)
    }

    // Decide whether to compact hits (1 per file) or keep all.
    // Compacting is for multi-file searches to keep messages small.
    // Single-file results (e.g. searching a specific file) keep all hits
    // so the LLM gets full context without extra read calls.
    const isSingleFile = files.length === 1

    let filesForLLM: typeof files
    if (isSingleFile) {
      // Keep all hits for single-file results — no compression needed
      filesForLLM = files
    } else {
      // Multi-file: cap to 1 hit per file for compact LLM context
      filesForLLM = files.map(f => ({
        ...f,
        hits: f.hits.slice(0, 1),
        hasMoreHits: f.hits.length > 1,
      }))
    }
    result.files = filesForLLM

    // Clear raw hit-level results to keep the stored message small.
    // The renderer reconstructs detail from files[] and on-demand search.
    result.results = []

    // Pagination hint when results are truncated
    const paginationHint =
      (result.truncated || truncatedFiles) && userMaxResults > 0
        ? ` Hint: Results were truncated. Consider narrowing with path, glob, or more specific patterns, or increase max_results for broader results.`
        : ''

    const fileCount = files.length
    const titleMatchCount = files.filter(f => f.titleMatch).length
    // Hint for the LLM: only shown when results are actually compacted (multi-file).
    const compactHint = !isSingleFile && filesForLLM.some(f => f.hasMoreHits)
      ? ' Results are compacted to 1 line per file (hasMoreHits=true means more lines match). To see all hits in a file, search again with path set to that file.'
      : ''
    // When we auto-upgraded literal → regex, tell the LLM so it can learn the
    // convention (pass mode="regex" explicitly next time). This is informational,
    // not an error — the search already ran successfully.
    const upgradeHint = autoUpgradedToRegex
      ? ` Note: query looked like a regex, so it was auto-run in regex mode. Next time you can pass mode="regex" explicitly.`
      : ''

    return toolOkJson(
      'search',
      {
        query,
        mode: useRegex ? 'regex' : 'literal',
        ...result,
        message: `Found ${result.totalMatches} matches across ${fileCount} files.${titleMatchCount > 0 ? ` (${titleMatchCount} title match${titleMatchCount !== 1 ? 'es' : ''})` : ''}.${compactHint}${upgradeHint}`,
      },
      {
        ...(loopCheck.warning ? { _warning: loopCheck.warning } : {}),
        ...((paginationHint || compactHint) ? { _hint: [paginationHint, compactHint].filter(Boolean).join('') } : {}),
      }
    )
  } catch (error) {
    if (isToolTimeoutError(error)) {
      return toolErrorJson('search', 'timeout', error.message, { retryable: true })
    }
    const structured = parseStructuredError(error)
    if (structured?.code === 'path_not_found') {
      return toolErrorJson(
        'search',
        'path_not_found',
        typeof structured.message === 'string'
          ? structured.message
          : 'Requested search path was not found under current root.',
        {
          details: {
            requestedPath: structured.requestedPath as string | undefined,
            resolvedRootName: structured.resolvedRootName as string | undefined,
          },
          hint: 'Try path="src/..." relative to current root, or omit path to search from root.',
        }
      )
    }
    return toolErrorJson(
      'search',
      'internal_error',
      `Search failed: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true }
    )
  }
}

export const searchPromptDoc: ToolPromptDoc = {
  category: 'file-ops',
  section: '### Content Search',
  lines: [
    '- `search(query, ...)` - Search text in files and return matched file/line locations. **IMPORTANT**: Always use `max_results` parameter (default 50) to limit results. Use `glob` parameter (e.g., "**/*.ts") to filter file types when searching large codebases.',
  ],
}
