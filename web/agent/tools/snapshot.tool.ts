/**
 * Snapshot Tools - OPFS change-snapshot review tools (not real Git)
 *
 * Built on OPFS change tracking and the snapshot system (pending_ops / fs_changesets),
 * for reviewing / reverting / rolling back agent edits. For real git, use the exec tool.
 */

import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'
import { useConversationContextStore } from '@/store/conversation-context.store'
import { toolErrorJson, toolOkJson } from './tool-envelope'

// Git-like tool implementations
import { 
  snapshotStatus, 
  formatSnapshotStatus,
  snapshotDiff,
  formatSnapshotDiff,
  snapshotLog,
  formatSnapshotLog,
  formatSnapshotLogOneline,
  snapshotShow,
  formatSnapshotShow,
  snapshotRestore,
  formatSnapshotRestore
} from '@/opfs/snapshot'

function parseFormat(raw: unknown): { ok: true; format: 'json' | 'text' } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, format: 'text' }
  if (raw === 'json' || raw === 'text') return { ok: true, format: raw }
  return { ok: false, error: `format must be "json" or "text"` }
}

function ensureWorkspaceId(context: { workspaceId?: string | null }): string | null {
  const workspaceId = context.workspaceId
  if (!workspaceId) return null
  return workspaceId
}

function ensureProjectId(context: { projectId?: string | null }): string | null {
  const projectId = context.projectId
  if (!projectId) return null
  return projectId
}

function parseBooleanArg(value: unknown, name: string): { ok: true; value: boolean } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: false }
  if (typeof value === 'boolean') return { ok: true, value }
  return { ok: false, error: `${name} must be boolean` }
}

/**
 * Build a path hint for when a `path` filter returns nothing.
 * If existing paths share a common prefix, the caller may have omitted the root prefix.
 */
function buildPathHint(inputPath: string, existingFiles: Array<{ path: string }>): string | undefined {
  // Collect every possible root prefix (the part before the first /) from existing paths
  const roots = new Set<string>()
  for (const f of existingFiles) {
    const slashIdx = f.path.indexOf('/')
    if (slashIdx > 0) {
      roots.add(f.path.substring(0, slashIdx))
    }
  }

  // No root prefixes at all (single-root project) - nothing to hint about
  if (roots.size === 0) return undefined

  // Check whether the input already starts with a root
  const alreadyHasRoot = [...roots].some((r) => inputPath.startsWith(r + '/'))
  if (alreadyHasRoot) {
    // Correct prefix but no result - the path itself is probably wrong
    return undefined
  }

  // Guess: the caller omitted the root prefix
  const suggestions = [...roots]
    .map((r) => `${r}/${inputPath}`)
    .filter((candidate) =>
      existingFiles.some((f) => f.path.startsWith(candidate))
    )

  if (suggestions.length === 1) {
    return `Did you mean "${suggestions[0]}"? (path needs root prefix)`
  } else if (suggestions.length > 1) {
    return `Possible paths: ${suggestions.map((s) => `"${s}"`).join(', ')}`
  }

  // No exact match, but still surface the available roots
  const rootList = [...roots].join(', ')
  const firstRoot = roots.values().next().value
  return `This project has multi-root layout. Available roots: [${rootList}]. Try "${firstRoot}/${inputPath}"`
}

//=============================================================================
// snapshot_status - show workspace status
//=============================================================================

export const snapshotStatusDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'snapshot_status',
    description:
      'Show OPFS pending changes and sync status. NOT real git — these are OPFS-internal ' +
      'change tracking snapshots for review/undo. Based on pending_ops and fs_changesets tables.',
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['json', 'text'],
          description: 'Output format. Default: text (git-style output)',
        },
      },
    },
  },
}

export const snapshotStatusExecutor: ToolExecutor = async (args, context) => {
  try {
    const workspaceId = ensureWorkspaceId(context)
    if (!workspaceId) {
      return toolErrorJson('snapshot_status', 'no_active_workspace', 'No active workspace')
    }

    const parsedFormat = parseFormat(args.format)
    if (!parsedFormat.ok) {
      return toolErrorJson('snapshot_status', 'invalid_arguments', parsedFormat.error)
    }

    const result = await snapshotStatus(workspaceId)
    const output = formatSnapshotStatus(result)
    if (parsedFormat.format === 'json') {
      return toolOkJson('snapshot_status', {
        format: 'json',
        status: result,
      })
    }

    return toolOkJson('snapshot_status', {
      format: 'text',
      output,
      status: result,
    })
  } catch (error) {
    return toolErrorJson(
      'snapshot_status',
      'internal_error',
      `Failed to get status: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true }
    )
  }
}

//=============================================================================
// snapshot_diff - show file differences
//=============================================================================

export const snapshotDiffDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'snapshot_diff',
    description:
      'Show diffs of OPFS pending changes vs snapshots. NOT real git. ' +
      'Modes: working (default) = pending changes, cached = staged changes, snapshot = specific snapshot.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['working', 'cached', 'snapshot'],
          description: 'Diff mode. working=uncommitted changes, cached=staged changes, snapshot=specific snapshot',
        },
        snapshot_id: {
          type: 'string',
          description: 'Snapshot ID for snapshot mode',
        },
        cached: {
          type: 'boolean',
          description: 'Alias of --cached. Equivalent to mode="cached".',
        },
        path: {
          type: 'string',
          description: 'Filter by path prefix',
        },
        name_only: {
          type: 'boolean',
          description: 'Show only names of changed files',
        },
        name_status: {
          type: 'boolean',
          description: 'Show names and status (A/M/D) of changed files',
        },
        stat: {
          type: 'boolean',
          description: 'Show diffstat summary',
        },
        numstat: {
          type: 'boolean',
          description: 'Show numeric diffstat summary',
        },
        patch: {
          type: 'boolean',
          description: 'Show patch body (default true unless stat/numstat/name_only/name_status is used)',
        },
        unified: {
          type: 'number',
          description: 'Generate diffs with <n> lines of context (like -U<n>)',
        },
        format: {
          type: 'string',
          enum: ['json', 'text'],
          description: 'Output format. Default: text (unified diff)',
        },
      },
    },
  },
}

export const snapshotDiffExecutor: ToolExecutor = async (args, context) => {
  try {
    const workspaceId = ensureWorkspaceId(context)
    if (!workspaceId) {
      return toolErrorJson('snapshot_diff', 'no_active_workspace', 'No active workspace')
    }

    const modeRaw = args.mode
    let mode = (modeRaw as 'working' | 'cached' | 'snapshot') || 'working'
    if (mode !== 'working' && mode !== 'cached' && mode !== 'snapshot') {
      return toolErrorJson(
        'snapshot_diff',
        'invalid_arguments',
        'mode must be one of: working, cached, snapshot'
      )
    }

    const cachedParsed = parseBooleanArg(args.cached, 'cached')
    if (!cachedParsed.ok) {
      return toolErrorJson('snapshot_diff', 'invalid_arguments', cachedParsed.error)
    }
    if (cachedParsed.value) {
      if (args.mode !== undefined && mode !== 'cached') {
        return toolErrorJson(
          'snapshot_diff',
          'invalid_arguments',
          'cached=true conflicts with mode. Use mode="cached" or remove mode.'
        )
      }
      mode = 'cached'
    }

    const snapshotId = args.snapshot_id as string | undefined
    if (mode === 'snapshot' && !snapshotId) {
      return toolErrorJson('snapshot_diff', 'invalid_arguments', 'snapshot_id is required when mode="snapshot"')
    }

    const nameOnlyParsed = parseBooleanArg(args.name_only, 'name_only')
    if (!nameOnlyParsed.ok) {
      return toolErrorJson('snapshot_diff', 'invalid_arguments', nameOnlyParsed.error)
    }
    const nameStatusParsed = parseBooleanArg(args.name_status, 'name_status')
    if (!nameStatusParsed.ok) {
      return toolErrorJson('snapshot_diff', 'invalid_arguments', nameStatusParsed.error)
    }
    if (nameOnlyParsed.value && nameStatusParsed.value) {
      return toolErrorJson(
        'snapshot_diff',
        'invalid_arguments',
        'name_only and name_status cannot both be true'
      )
    }

    const statParsed = parseBooleanArg(args.stat, 'stat')
    if (!statParsed.ok) {
      return toolErrorJson('snapshot_diff', 'invalid_arguments', statParsed.error)
    }
    const numstatParsed = parseBooleanArg(args.numstat, 'numstat')
    if (!numstatParsed.ok) {
      return toolErrorJson('snapshot_diff', 'invalid_arguments', numstatParsed.error)
    }

    const patchParsed = parseBooleanArg(args.patch, 'patch')
    if (!patchParsed.ok) {
      return toolErrorJson('snapshot_diff', 'invalid_arguments', patchParsed.error)
    }

    const unified = args.unified as number | undefined
    if (unified !== undefined && (!Number.isFinite(unified) || unified < 0 || !Number.isInteger(unified))) {
      return toolErrorJson('snapshot_diff', 'invalid_arguments', 'unified must be a non-negative integer')
    }

    const path = args.path as string | undefined
    const parsedFormat = parseFormat(args.format)
    if (!parsedFormat.ok) {
      return toolErrorJson('snapshot_diff', 'invalid_arguments', parsedFormat.error)
    }

    const result = await snapshotDiff(workspaceId, {
      mode,
      snapshotId,
      path,
      directoryHandle: null,
      contextLines: unified,
    })

    // If the path filter returned nothing, check whether a root prefix hint applies
    const filesChanged = result?.summary?.filesChanged ?? result?.files?.length ?? 0
    const hasPath = !!path
    let pathHint: string | undefined

    if (hasPath && filesChanged === 0) {
      // Re-query the diff without a path to collect root prefixes for the hint
      try {
        const fullResult = await snapshotDiff(workspaceId, {
          mode,
          snapshotId,
          path: undefined,
          directoryHandle: null,
          contextLines: unified,
        })
        pathHint = buildPathHint(path, fullResult?.files ?? [])
      } catch {
        // A failed query must not break the main flow
        pathHint = undefined
      }
    }

    const renderOptions = {
      nameOnly: nameOnlyParsed.value,
      nameStatus: nameStatusParsed.value,
      stat: statParsed.value,
      numstat: numstatParsed.value,
      patch: args.patch === undefined ? undefined : patchParsed.value,
    }

    let output = formatSnapshotDiff(result, renderOptions)

    // Append the path hint
    if (pathHint) {
      output = `No changes matched path "${path}".\n${pathHint}\n\n${output}`
    }
    if (parsedFormat.format === 'json') {
      return toolOkJson('snapshot_diff', {
        format: 'json',
        diff: result,
        render: renderOptions,
      })
    }

    return toolOkJson('snapshot_diff', {
      format: 'text',
      output,
      diff: result,
    })
  } catch (error) {
    return toolErrorJson(
      'snapshot_diff',
      'internal_error',
      `Failed to get diff: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true }
    )
  }
}

//=============================================================================
// snapshot_log - show commit history
//=============================================================================

export const snapshotLogDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'snapshot_log',
    description:
      'Show OPFS snapshot history (auto-saved changesets). NOT real git commit history. Based on fs_changesets table.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of commits to show. Default: 10',
        },
        path: {
          type: 'string',
          description: 'Filter by path (only commits affecting this path)',
        },
        status: {
          type: 'string',
          enum: ['committed', 'approved', 'rolled_back'],
          description: 'Filter by snapshot status',
        },
        oneline: {
          type: 'boolean',
          description: 'Use compact one-line format. Default: false',
        },
        format: {
          type: 'string',
          enum: ['json', 'text'],
          description: 'Output format. Default: text',
        },
      },
    },
  },
}

export const snapshotLogExecutor: ToolExecutor = async (args, context) => {
  try {
    const projectId = ensureProjectId(context)
    if (!projectId) {
      return toolErrorJson('snapshot_log', 'no_active_project', 'No active project')
    }
    if (args.limit !== undefined) {
      if (
        typeof args.limit !== 'number' ||
        !Number.isFinite(args.limit) ||
        args.limit <= 0 ||
        !Number.isInteger(args.limit)
      ) {
        return toolErrorJson('snapshot_log', 'invalid_arguments', 'limit must be a positive integer')
      }
    }
    const limit = (args.limit as number) || 10
    const path = args.path as string | undefined
    const status = args.status as 'committed' | 'approved' | 'rolled_back' | undefined
    if (status && status !== 'committed' && status !== 'approved' && status !== 'rolled_back') {
      return toolErrorJson(
        'snapshot_log',
        'invalid_arguments',
        'status must be one of: committed, approved, rolled_back'
      )
    }
    const oneline = args.oneline as boolean
    if (args.oneline !== undefined && typeof args.oneline !== 'boolean') {
      return toolErrorJson('snapshot_log', 'invalid_arguments', 'oneline must be boolean')
    }
    const parsedFormat = parseFormat(args.format)
    if (!parsedFormat.ok) {
      return toolErrorJson('snapshot_log', 'invalid_arguments', parsedFormat.error)
    }

    const result = await snapshotLog(projectId, {
      limit,
      path,
      status,
    })

    const output = oneline ? formatSnapshotLogOneline(result) : formatSnapshotLog(result)
    if (parsedFormat.format === 'json') {
      return toolOkJson('snapshot_log', {
        format: 'json',
        log: result,
      })
    }

    return toolOkJson('snapshot_log', {
      format: 'text',
      output,
      log: result,
      oneline: oneline === true,
    })
  } catch (error) {
    return toolErrorJson(
      'snapshot_log',
      'internal_error',
      `Failed to get log: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true }
    )
  }
}

//=============================================================================
// snapshot_show - show commit details
//=============================================================================

export const snapshotShowDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'snapshot_show',
    description:
      'Show detailed information about an OPFS snapshot (changeset). Includes summary and diffs. NOT real git.',
    parameters: {
      type: 'object',
      properties: {
        snapshot_id: {
          type: 'string',
          description: 'Snapshot ID to show. If omitted, shows the latest snapshot.',
        },
        include_diff: {
          type: 'boolean',
          description: 'Include unified diff for this snapshot. Default: false',
        },
        path: {
          type: 'string',
          description: 'Optional path prefix filter when include_diff=true',
        },
        format: {
          type: 'string',
          enum: ['json', 'text'],
          description: 'Output format. Default: text',
        },
      },
    },
  },
}

export const snapshotShowExecutor: ToolExecutor = async (args, context) => {
  try {
    const projectId = ensureProjectId(context)
    if (!projectId) {
      return toolErrorJson('snapshot_show', 'no_active_project', 'No active project')
    }
    const snapshotId = args.snapshot_id as string | undefined
    if (args.include_diff !== undefined && typeof args.include_diff !== 'boolean') {
      return toolErrorJson('snapshot_show', 'invalid_arguments', 'include_diff must be boolean')
    }
    const includeDiff = args.include_diff as boolean | undefined
    const path = args.path as string | undefined
    const parsedFormat = parseFormat(args.format)
    if (!parsedFormat.ok) {
      return toolErrorJson('snapshot_show', 'invalid_arguments', parsedFormat.error)
    }

    const result = await snapshotShow(projectId, snapshotId, {
      includeDiff: includeDiff === true,
      path,
    })

    if (!result) {
      return toolErrorJson('snapshot_show', 'not_found', 'No snapshots found')
    }

    const output = formatSnapshotShow(result)
    if (parsedFormat.format === 'json') {
      return toolOkJson('snapshot_show', {
        format: 'json',
        show: result,
      })
    }

    return toolOkJson('snapshot_show', {
      format: 'text',
      output,
      show: result,
    })
  } catch (error) {
    return toolErrorJson(
      'snapshot_show',
      'internal_error',
      `Failed to show commit: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true }
    )
  }
}

//=============================================================================
// snapshot_restore - restore files
//=============================================================================

export const snapshotRestoreDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'snapshot_restore',
    description:
      'Restore/undo OPFS pending changes or restore from a previous snapshot. NOT real git. ' +
      'Use staged=true to unstage files (like git restore --staged).',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'File paths to restore (supports glob patterns like "src/*.ts"). If omitted or empty, apply to all eligible paths.',
        },
        staged: {
          type: 'boolean',
          description: 'Unstage files instead of restoring working tree (like --staged flag)',
        },
        snapshot_id: {
          type: 'string',
          description: 'Restore from specific snapshot. If omitted, restores from latest.',
        },
        format: {
          type: 'string',
          enum: ['json', 'text'],
          description: 'Output format. Default: text',
        },
      },
    },
  },
}

export const snapshotRestoreExecutor: ToolExecutor = async (args, context) => {
  try {
    const workspaceId = ensureWorkspaceId(context)
    if (!workspaceId) {
      return toolErrorJson('snapshot_restore', 'no_active_workspace', 'No active workspace')
    }
    const rawPaths = args.paths
    const paths = Array.isArray(rawPaths) ? (rawPaths as string[]) : []
    const staged = args.staged as boolean
    const snapshotId = args.snapshot_id as string | undefined
    const parsedFormat = parseFormat(args.format)
    if (!parsedFormat.ok) {
      return toolErrorJson('snapshot_restore', 'invalid_arguments', parsedFormat.error)
    }

    if (rawPaths !== undefined && !Array.isArray(rawPaths)) {
      return toolErrorJson('snapshot_restore', 'invalid_arguments', 'paths must be an array of strings')
    }
    if (paths.some((path) => typeof path !== 'string' || !path)) {
      return toolErrorJson('snapshot_restore', 'invalid_arguments', 'paths must be a string array')
    }
    if (args.staged !== undefined && typeof args.staged !== 'boolean') {
      return toolErrorJson('snapshot_restore', 'invalid_arguments', 'staged must be boolean')
    }

    const result = await snapshotRestore(workspaceId, {
      paths,
      staged: staged || false,
      worktree: !staged,
      snapshotId,
      directoryHandle: null,
    })

    // Refresh the status
    await useConversationContextStore.getState().updateCurrentCounts()
    await useConversationContextStore.getState().refreshPendingChanges(true)

    const output = formatSnapshotRestore(result)
    if (parsedFormat.format === 'json') {
      return toolOkJson('snapshot_restore', {
        format: 'json',
        restore: result,
      })
    }

    return toolOkJson('snapshot_restore', {
      format: 'text',
      output,
      restore: result,
    })
  } catch (error) {
    return toolErrorJson(
      'snapshot_restore',
      'internal_error',
      `Failed to restore: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true }
    )
  }
}

export const snapshotPromptDoc: ToolPromptDoc = {
  category: 'snapshot',
  section: '### Snapshot Tools (OPFS Change Review)',
  lines: [
    '- `snapshot_status(format?)` - Show OPFS pending changes and sync status. NOT real git.',
    '- `snapshot_diff(mode?, path?, ...)` - Show diffs of OPFS pending/staged changes vs snapshots',
    '- `snapshot_log(limit?, path?, ...)` - Show OPFS snapshot history (auto-saved changesets)',
    '- `snapshot_show(snapshot_id?, ...)` - Show details of a specific OPFS snapshot',
    '- `snapshot_restore(paths?, staged?, snapshot_id?)` - Restore/undo OPFS pending changes',
  ],
}
