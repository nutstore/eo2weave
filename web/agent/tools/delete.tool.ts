/**
 * delete tool - Soft delete file(s) / directory(ies) through OPFS pending pipeline.
 *
 * This tool does NOT delete files from native filesystem immediately.
 * It marks files as pending deletion in OPFS workspace. Actual deletion
 * happens when user triggers sync-to-disk.
 *
 * Supports:
 * - Single file or directory deletion via `path`
 * - Batch deletion via `paths`
 * - Recursive directory deletion via `recursive: true`
 * - Dry-run preview via `dry_run: true`
 */

import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'
import { useOPFSStore } from '@/store/opfs.store'
import { isProtectedAgentCoreFile, resolveVfsTarget, withVfsAgentIdHint } from './vfs-resolver'
import { rewritePythonMountPathForNonPythonTool, validateRootPrefix } from './path-guards'
import { withToolTimeout, isToolTimeoutError } from './tool-utils'

export const deleteDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'delete',
    description:
      'Soft delete file(s). Marks files as pending deletion in OPFS workspace. ' +
      'Use path for single file, or paths for batch. ' +
      'IMPORTANT: Files are not removed from real disk until sync is executed. ' +
      'Supports vfs://workspace/..., vfs://agents/{id}/..., vfs://assets/..., and vfs://webmcp/... paths.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Single file or directory path to delete (soft delete)',
        },
        paths: {
          type: 'array',
          description: 'Multiple file/directory paths to delete (batch soft delete)',
          items: { type: 'string' },
        },
        recursive: {
          type: 'boolean',
          description:
            'Delete directories recursively. When true, a directory path will delete all contained files and subdirectories. Default: false.',
          default: false,
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview deletion targets without marking pending changes. Default: false',
          default: false,
        },
        timeout: {
          type: 'number',
          description: 'Maximum execution time in milliseconds (default: 60000).',
        },
      },
    },
  },
}

function normalizeTargetPath(raw: string): string {
  const normalized = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized) throw new Error('Path cannot be empty')

  if (normalized.startsWith('vfs://')) {
    const suffix = normalized.slice('vfs://'.length)
    const parts = suffix.split('/').filter(Boolean)
    if (parts.some((part) => part === '..')) {
      throw new Error('Path cannot include ".."')
    }
    return `vfs://${parts.join('/')}`
  }

  const parts = normalized.split('/').filter(Boolean)
  if (parts.some((part) => part === '..')) {
    throw new Error('Path cannot include ".."')
  }
  return parts.join('/')
}

function dedupePaths(rawPaths: string[]): string[] {
  const unique = new Set<string>()
  for (const raw of rawPaths) {
    const normalized = normalizeTargetPath(raw)
    unique.add(normalized)
  }
  return Array.from(unique)
}

/**
 * Check if a path might be a directory (heuristic).
 * Trailing slash is a strong signal; extensionless last segment is a weak signal.
 * Always confirmed via backend.listDir before acting.
 */
function mightBeDirectory(path: string): boolean {
  if (path.endsWith('/')) return true
  const stripped = path.startsWith('vfs://') ? path.split('/').slice(2).join('/') : path
  const lastSegment = stripped.split('/').pop() || ''
  return lastSegment.length > 0 && !lastSegment.includes('.')
}

/**
 * Resolve a target to either a file deletion or a directory deletion.
 * Returns the list of individual file paths that were deleted.
 */
async function deleteTarget(
  target: string,
  context: Parameters<typeof resolveVfsTarget>[1],
  recursive: boolean,
): Promise<{ deletedFiles: string[]; deletedDirs: string[] }> {
  const resolved = await resolveVfsTarget(target, context, 'delete')

  if (resolved.kind === 'agent' && isProtectedAgentCoreFile(resolved.path)) {
    throw new Error(`Protected agent file cannot be deleted: ${resolved.path}`)
  }

  // Always try listDir first for an authoritative directory check.
  // Skip only when clearly a file path (has extension) and non-recursive.
  const tryListDir = mightBeDirectory(target) || recursive
  let isDirectory = false

  if (tryListDir) {
    try {
      await resolved.backend.listDir(resolved.path)
      isDirectory = true
    } catch {
      // listDir failed → not a directory (or multi-root routing issue)
    }
  }

  if (!isDirectory) {
    // Regular file deletion
    await resolved.backend.deleteFile(resolved.path)
    return { deletedFiles: [target], deletedDirs: [] }
  }

  // Directory deletion (non-recursive guard)
  if (!recursive) {
    throw new Error(
      `"${target}" is a directory. Use recursive: true to delete directories.`,
    )
  }

  // Recursive directory deletion
  if (!resolved.backend.deleteDir) {
    return manualDirDelete(resolved.backend, resolved.path)
  }

  const result = await resolved.backend.deleteDir(resolved.path)
  return result
}

/**
 * Fallback directory deletion for backends without deleteDir.
 * Lists all files recursively and deletes them individually.
 */
async function manualDirDelete(
  backend: { deleteFile: (p: string) => Promise<void>; listDir: (p: string, opts?: any) => Promise<Array<{ name: string; path: string; kind: string }>> },
  dirPath: string,
): Promise<{ deletedFiles: string[]; deletedDirs: string[] }> {
  const deletedFiles: string[] = []
  const deletedDirs: string[] = []

  const entries = await backend.listDir(dirPath, { recursive: true, maxDepth: 100 })
  const files = entries.filter((e) => e.kind === 'file').map((e) => e.path)
  const dirs = entries
    .filter((e) => e.kind === 'directory')
    .sort((a, b) => b.path.split('/').length - a.path.split('/').length)

  for (const filePath of files) {
    try {
      await backend.deleteFile(filePath)
      deletedFiles.push(filePath)
    } catch {
      // Skip files that fail
    }
  }

  for (const dir of dirs) {
    deletedDirs.push(dir.path)
  }
  deletedDirs.push(dirPath)

  return { deletedFiles, deletedDirs }
}

export const deleteExecutor: ToolExecutor = async (args, context) => {
  const path = args.path as string | undefined
  const paths = args.paths as string[] | undefined
  const dryRun = args.dry_run === true
  const recursive = args.recursive === true
  const timeoutMs = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : 60_000

  const requestedTargets = paths && Array.isArray(paths) && paths.length > 0 ? paths : path ? [path] : []

  if (requestedTargets.length === 0) {
    return JSON.stringify({ error: 'Either path or paths must be provided' })
  }

  // Validate root prefix for each target before rewriting
  for (const target of requestedTargets) {
    const rootError = await validateRootPrefix('delete', target, context)
    if (rootError) return rootError
  }

  const rewrittenTargets = requestedTargets.map((target) => {
    const rewritten = rewritePythonMountPathForNonPythonTool(target)
    return rewritten?.rewritten ? rewritten.rewrittenPath : target
  })

  let targets: string[]
  try {
    targets = dedupePaths(rewrittenTargets)
  } catch (error) {
    return JSON.stringify({
      error: `Invalid path: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  if (dryRun) {
    // For dry run, also expand directories if recursive is set
    if (recursive) {
      const expandedTargets: string[] = []
      for (const target of targets) {
        try {
          const resolved = await resolveVfsTarget(target, context, 'list')
          // listDir will throw if path is not a directory — if it succeeds, it's a directory
          const allEntries = await resolved.backend.listDir(resolved.path, { recursive: true, maxDepth: 100 })
          // It's a directory — expand
          const files = allEntries.filter((e) => e.kind === 'file').map((e) => e.path)
          const dirs = allEntries.filter((e) => e.kind === 'directory').map((e) => e.path)
          expandedTargets.push(...files, ...dirs, target)
        } catch {
          // Not a directory or doesn't exist — treat as single file
          expandedTargets.push(target)
        }
      }
      return JSON.stringify({
        success: true,
        dryRun: true,
        total: expandedTargets.length,
        targets: expandedTargets,
        message: `Dry run: ${expandedTargets.length} item(s) would be deleted (recursive).`,
      })
    }

    return JSON.stringify({
      success: true,
      dryRun: true,
      total: targets.length,
      targets,
      message: `Dry run: ${targets.length} file(s) would be marked for deletion.`,
    })
  }

  const deleted: string[] = []
  const deletedDirs: string[] = []
  const failed: Array<{ path: string; error: string }> = []

  // Wrap the entire deletion loop in a wall-clock timeout. A stalled backend
  // (revoked FS handle, locked OPFS) shouldn't hang the agent loop indefinitely.
  try {
    await withToolTimeout(
      (async () => {
        for (const target of targets) {
          try {
            const result = await deleteTarget(target, context, recursive)

            deleted.push(...result.deletedFiles)
            deletedDirs.push(...result.deletedDirs)
          } catch (error) {
            failed.push({
              path: target,
              error: withVfsAgentIdHint(error instanceof Error ? error.message : String(error)),
            })
          }
        }
      })(),
      timeoutMs,
      'delete',
    )
  } catch (error) {
    if (isToolTimeoutError(error)) {
      // Partial result: include whatever was deleted before the timeout
      const pendingChanges = useOPFSStore.getState().getPendingChanges()
      return JSON.stringify({
        success: false,
        total: deleted.length + deletedDirs.length + failed.length + 1,
        deleted,
        deletedDirs,
        failed,
        timedOut: true,
        status: 'pending',
        pendingCount: pendingChanges.length,
        message: `${error.message} — ${deleted.length} file(s) deleted before timeout. ${pendingChanges.length} change(s) pending review.`,
      })
    }
    throw error
  }

  const pendingChanges = useOPFSStore.getState().getPendingChanges()

  // If any target was in the skills namespace, refresh user skills cache
  const hasSkillsTarget = targets.some((t) => t.startsWith('vfs://skills/') || t.startsWith('vfs://skill/'))
  if (hasSkillsTarget && deleted.length + deletedDirs.length > 0) {
    try {
      const { getSkillManager } = await import('@/skills/skill-manager')
      await getSkillManager().refreshUserSkills()
    } catch { /* non-fatal */ }
  }

  return JSON.stringify({
    success: failed.length === 0,
    total: deleted.length + deletedDirs.length + failed.length,
    deleted,
    deletedDirs,
    failed,
    status: 'pending',
    pendingCount: pendingChanges.length,
    message:
      failed.length === 0
        ? `${deleted.length} file(s) marked for deletion. ${pendingChanges.length} change(s) pending review.`
        : `${deleted.length} file(s) marked for deletion, ${failed.length} failed. ${pendingChanges.length} change(s) pending review.`,
  })
}

export const deletePromptDoc: ToolPromptDoc = {
  category: 'file-ops',
  section: '### File Operations',
  lines: [
    '- `delete(path)` - Soft delete single file (marks as pending deletion)',
    '- `delete(paths)` - Batch soft delete multiple files',
    '- `delete(..., recursive=true)` - Delete directory and all contents recursively',
    '- `delete(..., dry_run=true)` - Preview deletion targets without making changes',
  ],
}
