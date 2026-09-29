/**
 * Write Tool - Write file contents to workspace, agent, or assets VFS.
 *
 * Supports workspace relative paths and vfs:// URIs.
 * Integrated with staleness checks and pending change tracking.
 */

import type { ToolDefinition, ToolExecutor, ToolContext, ToolPromptDoc } from './tool-types'
import { useOPFSStore } from '@/store/opfs.store'
import { useConversationStore } from '@/store/conversation.store'
import type { AssetMeta } from '@/types/asset'
import { inferMimeType } from '@/types/asset'
import { resolveVfsTarget } from './vfs-resolver'
import { toolErrorJson, toolOkJson } from './tool-envelope'
import { rewritePythonMountPathForNonPythonTool, validateRootPrefix } from './path-guards'
import { checkFileStaleness, refreshReadTimestamp } from './loop-guard'
import { resolveNativeDirectoryHandleForPath, withToolTimeout, isToolTimeoutError } from './tool-utils'
import { getResolvedPathForLoopGuard, formatToolErrorMessage } from './io-shared'
import { getFormatHandler, buildFormatWriteContext } from './format-registry'
import { stripEnvelopeEchoHeader } from './envelope-echo'

// Ensure format handlers are registered before first use
import './formats'

//=============================================================================
// Write Tool
//=============================================================================

export const writeDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'write',
    description:
      'Write content to a single file. Creates directories if needed. Returns confirmation. Supports workspace relative paths and vfs://workspace/..., vfs://agents/{id}/..., or vfs://webmcp/....',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to write. MUST include rootName prefix (e.g., "myRoot/src/file.ts").',
        },
        content: {
          type: 'string',
          description: 'Content to write',
        },
        timeout: {
          type: 'number',
          description: 'Maximum execution time in milliseconds (default: 30000).',
        },
      },
      required: ['path', 'content'],
    },
  },
}

type PendingChangeType = 'create' | 'modify' | 'delete'
type PendingChangeLike = { path: string; type: PendingChangeType }

function normalizePendingComparePath(inputPath: string): string {
  let normalized = inputPath.replace(/\\/g, '/').trim()
  if (normalized.startsWith('/mnt/')) {
    normalized = normalized.slice('/mnt/'.length)
  } else if (normalized === '/mnt') {
    normalized = ''
  }
  return normalized.replace(/^\/+/, '')
}

function getPendingWriteTypeForPath(
  pendingChanges: PendingChangeLike[],
  path: string
): Exclude<PendingChangeType, 'delete'> | null {
  const target = normalizePendingComparePath(path)
  for (let i = pendingChanges.length - 1; i >= 0; i--) {
    const pending = pendingChanges[i]
    if (normalizePendingComparePath(pending.path) !== target) continue
    if (pending.type === 'delete') continue
    return pending.type
  }
  return null
}

/**
 * Validate that a workspace-relative path includes a valid rootName prefix.
 * Returns an error string if the path is missing the prefix, or null if OK.
 * Skips vfs:// paths and non-workspace paths.
 * (Imported from path-guards for shared use across write/edit/delete tools.)
 */

export const writeExecutor: ToolExecutor = async (args, context) => {
  const path = args.path as string | undefined
  const content = args.content as string | undefined
  const timeoutMs = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : 30_000

  if (!path || content === undefined) {
    return toolErrorJson(
      'write',
      'invalid_arguments',
      'path and content are required'
    )
  }

  // Validate root prefix before any path rewriting
  const rootError = await validateRootPrefix('write', path, context)
  if (rootError) return rootError

  const rewrittenWritePath = rewritePythonMountPathForNonPythonTool(path)
  const effectiveWritePath = rewrittenWritePath?.rewritten ? rewrittenWritePath.rewrittenPath : path
  return executeSingleWrite(effectiveWritePath, content, context, timeoutMs)
}

async function executeSingleWrite(
  path: string,
  content: string,
  context: ToolContext,
  timeoutMs: number = 30_000,
): Promise<string> {
  const { getPendingChanges, hasCachedFile } = useOPFSStore.getState()

  // ── Defense-in-depth: strip envelope-echo header ──
  // e.g. content arriving as "[HTML] index.html\n\n<!DOCTYPE…" gets the
  // header removed before it hits disk. See stripEnvelopeEchoHeader docs.
  const { content: safeContent, stripped: strippedEnvelopeEcho } = stripEnvelopeEchoHeader(content, path)

  try {
    const target = await resolveVfsTarget(path, context, 'write')
    const resolvedPath = getResolvedPathForLoopGuard(target)

    // Staleness check: warn if file was modified externally since last read
    let stalenessWarning: string | null = null
    if (target.backend.label === 'workspace') {
      try {
        const { handle: nativeHandle, nativePath } = await resolveNativeDirectoryHandleForPath(
          target.path, context.directoryHandle, context.workspaceId
        )
        if (nativeHandle) {
          const fileHandle = await nativeHandle
            .getFileHandle(nativePath.split('/').pop()!, { create: false })
            .catch(() => null)
          if (fileHandle) {
            // getFile() returns a File object with lastModified
            const file = await fileHandle.getFile()
            stalenessWarning = checkFileStaleness(context, resolvedPath, file.lastModified)
          }
        }
      } catch {
        // Staleness check is best-effort — proceed with write if it fails
      }
    }

    let isNew = false
    let pendingCount = 0
    let status: 'pending' | 'saved' = 'saved'
    let message = ''

    const buildMeta = (extra?: Record<string, unknown>) => ({
      ...(stalenessWarning ? { _warning: stalenessWarning } : {}),
      ...(strippedEnvelopeEcho
        ? { _notice: `Stripped envelope-echo header from content before writing (content began with a "[Label] ${path.split('/').pop()}" line copied from read() output). Do not prepend such headers when writing files.` }
        : {}),
      ...extra,
    })

    // ── Pre-write: determine isNew for non-workspace backends ──
    const source = target.backend.label
    if (source !== 'workspace') {
      isNew = !(await target.backend.exists?.(target.path) ?? true)
    }

    // ── Unified backend write ──
    // If a format handler with write support is registered for this file type,
    // delegate content serialization to the handler (e.g. .nol → ZIP)
    const formatHandler = getFormatHandler(path)
    // Helper to wrap backend I/O with wall-clock timeout so a stalled backend
    // (revoked FS handle, locked OPFS) doesn't hang the agent loop.
    const writeWithTimeout = (writePromise: Promise<void>) =>
      withToolTimeout(writePromise, timeoutMs, 'write')

    if (formatHandler?.write) {
      const writeContext = await buildFormatWriteContext(target.backend, target.path, context.workspaceId)
      try {
        const binaryData = await formatHandler.write(safeContent, path, writeContext)
        await writeWithTimeout(target.backend.writeFile(target.path, binaryData))
      } catch (formatError) {
        // FormatWriteError: handler rejected the content with a progressive hint
        if (formatError instanceof Error && formatError.name === 'FormatWriteError' && 'hint' in formatError) {
          const fwe = formatError as { message: string; hint: string }
          return toolErrorJson('write', 'invalid_format', fwe.message, {
            hint: fwe.hint,
          })
        }
        throw formatError
      }
    } else if (formatHandler && !formatHandler.write) {
      // Format handler exists but is read-only (e.g. .pdf, .zip)
      return toolErrorJson('write', 'no_format_writer', `Cannot write .${formatHandler.extension} files directly with the write tool. Use the run_python tool instead if you need to modify this file.`, {
        hint: formatHandler.formatHint ?? `The .${formatHandler.extension} format handler only supports reading.`,
      })
    } else {
      await writeWithTimeout(target.backend.writeFile(target.path, safeContent))
    }

    // Collect asset metadata for assets backend (so UI shows AssetCard)
    if (source === 'assets') {
      collectAssetsFromWrite(target.path, safeContent.length, isNew, context.workspaceId)
    }

    // Post-write metadata: workspace needs pending tracking
    if (source === 'workspace') {
      const pendingChanges = getPendingChanges()
      pendingCount = pendingChanges.length
      const pendingType = getPendingWriteTypeForPath(pendingChanges, target.path)
      const wasCachedBeforeWrite = hasCachedFile(target.path)
      isNew = pendingType ? pendingType === 'create' : !wasCachedBeforeWrite
      status = 'pending'
      message = isNew
        ? `File "${path}" created. ${pendingCount} change(s) pending review.`
        : `File "${path}" updated. ${pendingCount} change(s) pending review.`
    } else {
      // Agent / Assets backends: isNew was already determined before write
      pendingCount = getPendingChanges().length
      status = 'saved'
      message = isNew ? `File "${path}" created.` : `File "${path}" updated.`
    }

    // Refresh timestamp after successful write to avoid false staleness on consecutive edits
    refreshReadTimestamp(context, resolvedPath, Date.now())

    // If writing to the skills namespace, refresh the user skills cache so
    // the new/updated skill appears in the available skills list immediately.
    if (target.backend.label === 'skills') {
      try {
        const { getSkillManager } = await import('@/skills/skill-manager')
        await getSkillManager().refreshUserSkills()
      } catch { /* non-fatal */ }
    }

    return toolOkJson(
      'write',
      {
        path,
        action: isNew ? 'create' : 'modify',
        size: safeContent.length,
        status,
        pendingCount,
        message,
        ...(formatHandler?.formatHint ? { formatHint: formatHandler.formatHint } : {}),
      },
      buildMeta()
    )
  } catch (error) {
    if (isToolTimeoutError(error)) {
      return toolErrorJson('write', 'timeout', error.message, { retryable: true })
    }
    return toolErrorJson(
      'write',
      'internal_error',
      `Failed to write file: ${formatToolErrorMessage(error)}`,
      { retryable: true }
    )
  }
}

//-----------------------------------------------------------------------------
// Prompt doc
//-----------------------------------------------------------------------------

export const writePromptDoc: ToolPromptDoc = {
  category: 'file-ops',
  section: '### File Operations',
  lines: [
    '- `write(path, content)` - Create new files or completely replace a file (supports `vfs://workspace/...`, `vfs://agents/{id}/...`, `vfs://webmcp/...`)',
  ],
}

/**
 * Collect an asset generated by write/edit into the conversation store.
 * This mirrors the snapshot-diff logic in execute.tool.ts but works
 * for direct vfs://assets/ writes where we already know the file details.
 */
export function collectAssetsFromWrite(
  assetPath: string,
  size: number,
  isNew: boolean,
  contextWorkspaceId?: string | null,
): void {
  // Only collect for new files to avoid duplicate entries on edits
  if (!isNew) return

  const fileName = assetPath.split('/').pop() || assetPath
  const asset: AssetMeta = {
    id: crypto.randomUUID(),
    name: fileName,
    size,
    mimeType: inferMimeType(fileName),
    direction: 'generated',
    createdAt: Date.now(),
  }

  // Prefer the workspace ID from the tool context (correct for parallel/subagent scenarios)
  // Do NOT fall back to the global activeConversationId — if context doesn't have one,
  // we simply skip asset collection rather than risk attaching to the wrong conversation.
  const targetId = contextWorkspaceId
  if (targetId) {
    useConversationStore.getState().collectAssets(targetId, [asset])
  }
}
