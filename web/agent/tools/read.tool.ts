/**
 * Read Tool - Read file contents from workspace, agent, or assets VFS.
 *
 * Supports workspace relative paths and vfs:// URIs.
 * Integrated with read-state tracking, loop guards, and staleness checks.
 *
 * Binary files are handled through the format registry:
 *   import './formats' to register built-in format handlers (nol, zip, etc.)
 */

import type { ToolDefinition, ToolExecutor, ToolContext, ToolPromptDoc } from './tool-types'
import { useOPFSStore } from '@/store/opfs.store'
import type { ReadPolicy } from '@/opfs/types/opfs-types'
import { resolveVfsTarget } from './vfs-resolver'
import { ensureReadFileState, getReadStateKey } from './read-state'
import { resolveNativeDirectoryHandleForPath, withToolTimeout, isToolTimeoutError } from './tool-utils'
import { toolErrorJson, toolOkJson } from './tool-envelope'
import { rewritePythonMountPathForNonPythonTool, validateRootPrefix } from './path-guards'
import {
  checkReadLoop,
  recordReadMtime,
  checkContentSizeLimit,
} from './loop-guard'
import { getFormatHandler } from './format-registry'
import { getResolvedPathForLoopGuard, formatToolErrorMessage, isKnownBinaryExtension, tryDecodeAsText } from './io-shared'
import { isSubagentPermissionDenied, SUBAGENT_PERMISSION_DENIED } from './agent-file-protection'

// Register built-in format handlers
import './formats'

//=============================================================================
// Read Tool
//=============================================================================

export const readDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read',
    description:
      'Read file contents. Uses cached version if file has pending modifications. Supports workspace relative paths and vfs://workspace/..., vfs://agents/{id}/..., or vfs://webmcp/....',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to read. MUST include rootName prefix (e.g., "myRoot/src/file.ts"). Do NOT use bare relative paths like "src/file.ts".',
        },
        start_line: {
          type: 'number',
          description: 'Optional 1-based start line for partial text read',
        },
        line_count: {
          type: 'number',
          description: 'Optional line count for partial text read',
        },
        max_size: {
          type: 'number',
          description:
            '⚠️ Default limit is ~100KB. REQUIRED for files likely exceeding 100KB (e.g. logs, CSV, JSON, large source files). Set to a larger value (e.g. 1048576 for 1MB, 10485760 for 10MB) to read bigger files. If a read returns "content_too_large", increase max_size and retry.',
        },
        read_policy: {
          type: 'string',
          description:
            'Optional source strategy: auto (default), prefer_opfs, prefer_native.',
          enum: ['auto', 'prefer_opfs', 'prefer_native'],
        },
        timeout: {
          type: 'number',
          description: 'Maximum execution time in milliseconds (default: 30000).',
        },
      },
    },
  },
}

interface ReadRangeOptions {
  startLine?: number
  lineCount?: number
}

function isReadPolicy(value: unknown): value is ReadPolicy {
  return value === 'auto' || value === 'prefer_opfs' || value === 'prefer_native'
}

/**
 * Build a retry hint string for content_too_large errors.
 * Tells the agent exactly what max_size value to use on retry.
 */
function buildMaxSizeHint(suggestedMaxSize: number): string {
  return `Retry with max_size=${suggestedMaxSize} to read the full file.`
}

export const readExecutor: ToolExecutor = async (args, context) => {
  const path = args.path as string | undefined
  const maxSize = args.max_size as number | undefined
  const timeoutMs = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : 30_000
  const readPolicyArg = args.read_policy
  const readPolicy: ReadPolicy | undefined =
    readPolicyArg === undefined ? undefined : (readPolicyArg as ReadPolicy)
  if (readPolicyArg !== undefined && !isReadPolicy(readPolicyArg)) {
    return toolErrorJson(
      'read',
      'invalid_arguments',
      'read_policy must be one of: auto, prefer_opfs, prefer_native'
    )
  }
  if (maxSize !== undefined) {
    if (typeof maxSize !== 'number' || !Number.isFinite(maxSize) || maxSize <= 0) {
      return toolErrorJson('read', 'invalid_arguments', 'max_size must be > 0')
    }
  }
  if (args.offset !== undefined || args.limit !== undefined) {
    return toolErrorJson(
      'read',
      'invalid_arguments',
      'offset/limit are no longer supported. Use start_line/line_count instead.'
    )
  }
  if (!path) {
    return toolErrorJson('read', 'invalid_arguments', 'path is required')
  }

  // Validate root prefix before any path rewriting
  const rootError = await validateRootPrefix('read', path, context)
  if (rootError) return rootError

  const rewrittenReadPath = rewritePythonMountPathForNonPythonTool(path)
  const effectiveReadPath = rewrittenReadPath?.rewritten ? rewrittenReadPath.rewrittenPath : path

  const rangeOptions: ReadRangeOptions = {
    startLine: args.start_line as number | undefined,
    lineCount: args.line_count as number | undefined,
  }

  const validationError = validateReadRange(rangeOptions)
  if (validationError) {
    return toolErrorJson('read', 'invalid_arguments', validationError)
  }

  return executeSingleRead(effectiveReadPath, context, rangeOptions, maxSize, readPolicy, timeoutMs)
}

function isOPFSWorkspaceMiss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('File not found in OPFS workspace:') ||
    message.includes('File not found in OPFS cache:')
  )
}

/**
 * Try to read a binary file through a registered format handler.
 * Returns the tool response string, or null if no handler / handler failed.
 */
async function tryFormatHandlerRead(
  binaryData: ArrayBuffer | Uint8Array,
  path: string,
  fileSize: number,
  contentType: string,
  options: ReadRangeOptions,
  readStateKey: string,
  readFileState: Map<string, import('./tool-types').ReadFileStateEntry>,
  source: string,
  meta: Record<string, unknown>,
  loopDedupKey: string,
  mtime: number | undefined,
  context: ToolContext,
): Promise<string | null> {
  const handler = getFormatHandler(path)
  if (!handler) return null

  try {
    const result = await handler.read(binaryData, path)

    const totalLines = result.content.split('\n').length
    const sizeLimitCheck = checkContentSizeLimit(result.content, fileSize, totalLines)
    if (!sizeLimitCheck.ok) {
      return toolErrorJson('read', 'content_too_large', sizeLimitCheck.error, {
        details: { totalLines: sizeLimitCheck.totalLines },
        hint: buildMaxSizeHint(sizeLimitCheck.suggestedMaxSize),
      })
    }

    readFileState.set(
      readStateKey,
      buildReadStateEntry(result.content, options, normalizeReadStateSource(source, 'workspace'))
    )
    recordReadMtime(context, loopDedupKey, mtime ?? Date.now(), fileSize)

    return toolOkJson(
      'read',
      {
        path,
        kind: result.kind,
        content: result.content,
        metadata: {
          size: fileSize,
          contentType,
          ...result.metadata,
        },
        ...(result.entries ? { entries: result.entries } : {}),
        ...(handler.formatHint ? { formatHint: handler.formatHint } : {}),
      },
      meta
    )
  } catch {
    // Handler failed — fall through to generic binary rejection
    return null
  }
}

async function executeSingleRead(
  path: string,
  context: ToolContext,
  options: ReadRangeOptions = {},
  maxSize?: number,
  readPolicy?: ReadPolicy,
  timeoutMs: number = 30_000,
): Promise<string> {
  const { readFile } = useOPFSStore.getState()
  const readFileState = ensureReadFileState(context)

  // Loop guard: check consecutive read counter before reading (defined outside try for scope)
  let loopCheckResult: ReturnType<typeof checkReadLoop> | null = null
  let resolvedPathForLoopGuard: string | null = null

  try {
    const target = await resolveVfsTarget(path, context, 'read')
    const readStateKey = getReadStateKey(target)

    // Loop guard: check consecutive read counter before reading
    resolvedPathForLoopGuard = getResolvedPathForLoopGuard(target)
    loopCheckResult = checkReadLoop(
      context,
      resolvedPathForLoopGuard,
      options.startLine ?? 1,
      options.lineCount ?? 0
    )
    if (loopCheckResult.isBlocked) {
      return toolErrorJson(
        'read',
        'loop_blocked',
        `BLOCKED: You have read this exact file region ${loopCheckResult.consecutive} times in a row. ` +
          'The content has NOT changed. You already have this information. ' +
          'STOP re-reading and proceed with your task.',
        { hint: 'Stop reading and proceed with writing or responding.' }
      )
    }

    const buildMeta = (extra?: Record<string, unknown>) => ({
      ...(loopCheckResult!.warning ? { _warning: loopCheckResult!.warning } : {}),
      ...extra,
    })

    // ── Unified backend read ──
    // Check if a format handler wants binary mode for this file
    const formatHandler = getFormatHandler(path)
    const needsBinary = formatHandler?.binaryMode ?? false

    const backendResult = await withToolTimeout(
      target.backend.readFile(target.path, {
        readPolicy: readPolicy as any,
        ...(needsBinary ? { encoding: 'binary' as const } : {}),
      }),
      timeoutMs,
      'read',
    )
    const content = backendResult.content
    const metadata = { size: backendResult.size, contentType: backendResult.mimeType, mtime: backendResult.mtime }
    if (maxSize && metadata.size > maxSize) {
      return toolErrorJson(
        'read',
        'too_large',
        `File size ${metadata.size} exceeds requested max_size ${maxSize}.`,
        { details: { path, fileSize: metadata.size, maxSize } }
      )
    }

    if (typeof content === 'string') {
      const totalLines = content.split('\n').length
      const formatted = applyTextRange(content, options)
      // Safety limit: cap the actual payload returned to the model.
      const sizeLimitCheck = checkContentSizeLimit(formatted, metadata.size, totalLines)
      if (!sizeLimitCheck.ok) {
        return toolErrorJson('read', 'content_too_large', sizeLimitCheck.error, {
          details: { totalLines: sizeLimitCheck.totalLines },
          hint: buildMaxSizeHint(sizeLimitCheck.suggestedMaxSize),
        })
      }
      readFileState.set(
        readStateKey,
        buildReadStateEntry(
          formatted,
          options,
          normalizeReadStateSource(backendResult.source, target.backend.label)
        )
      )
      // Record mtime for future dedup — backend may provide mtime, otherwise use wall clock
      const effectiveMtime = backendResult.mtime ?? Date.now()
      recordReadMtime(context, loopCheckResult!.dedupKey, effectiveMtime, metadata.size)
      return toolOkJson(
        'read',
        {
          path,
          kind: 'text',
          content: formatted,
          metadata: { size: metadata.size, contentType: metadata.contentType },
          range: {
            start_line: options.startLine,
            line_count: options.lineCount,
          },
        },
        buildMeta({ source: backendResult.source || target.backend.label })
      )
    }

    // ── Binary content: try format handler, then attempt text decode ──
    if (content instanceof ArrayBuffer || content instanceof Uint8Array) {
      const formatResult = await tryFormatHandlerRead(
        content,
        path,
        metadata.size,
        metadata.contentType,
        options,
        readStateKey,
        readFileState,
        backendResult.source || target.backend.label,
        buildMeta({ source: backendResult.source || target.backend.label }),
        loopCheckResult!.dedupKey,
        metadata.mtime,
        context,
      )
      if (formatResult) return formatResult

      // No format handler matched. Check if extension is a known binary format.
      if (isKnownBinaryExtension(path)) {
        return toolErrorJson(
          'read',
          'binary_file_rejected',
          `This is a binary file (${metadata.contentType || 'unknown type'}), which cannot be displayed as text. ` +
            'Please use the `run_python` tool to read binary files (e.g. images, PDFs, Excel, ZIP, etc.). ' +
            `Example: use sync-to-opfs(paths=["${path}"]) first, then read it in Python via /mnt/${path}.`,
          { details: { path, contentType: metadata.contentType, size: metadata.size } }
        )
      }

      // Unknown extension — try decoding as UTF-8 text
      const decoded = tryDecodeAsText(content)
      if (decoded !== null) {
        const totalLines = decoded.split('\n').length
        const formatted = applyTextRange(decoded, options)
        const sizeLimitCheck = checkContentSizeLimit(formatted, metadata.size, totalLines)
        if (!sizeLimitCheck.ok) {
          return toolErrorJson('read', 'content_too_large', sizeLimitCheck.error, {
            details: { totalLines: sizeLimitCheck.totalLines },
            hint: buildMaxSizeHint(sizeLimitCheck.suggestedMaxSize),
          })
        }
        readFileState.set(
          readStateKey,
          buildReadStateEntry(
            formatted,
            options,
            normalizeReadStateSource(backendResult.source, target.backend.label)
          )
        )
        const effectiveMtime = backendResult.mtime ?? Date.now()
        recordReadMtime(context, loopCheckResult!.dedupKey, effectiveMtime, metadata.size)
        return toolOkJson(
          'read',
          {
            path,
            kind: 'text',
            content: formatted,
            metadata: { size: metadata.size, contentType: metadata.contentType },
            range: {
              start_line: options.startLine,
              line_count: options.lineCount,
            },
          },
          buildMeta({ source: backendResult.source || target.backend.label })
        )
      }

      // Decoding failed — genuinely binary content with unknown extension
      return toolErrorJson(
        'read',
        'binary_file_rejected',
        `This is a binary file (${metadata.contentType || 'unknown type'}), which cannot be displayed as text. ` +
          'Please use the `run_python` tool to read binary files (e.g. images, PDFs, Excel, ZIP, etc.). ' +
          `Example: use sync-to-opfs(paths=["${path}"]) first, then read it in Python via /mnt/${path}.`,
        { details: { path, contentType: metadata.contentType, size: metadata.size } }
      )
    }

    // Defensive fallback: backend returned a content shape we don't recognise
    // (neither string nor binary). Treat as internal error.
    return toolErrorJson(
      'read',
      'internal_error',
      `Failed to read file: unsupported content shape from backend (${path}).`,
      { retryable: true }
    )
  } catch (error) {
    if (isToolTimeoutError(error)) {
      return toolErrorJson('read', 'timeout', error.message, { retryable: true })
    }
    if (isSubagentPermissionDenied(error)) {
      return toolErrorJson('read', SUBAGENT_PERMISSION_DENIED, error.message)
    }
    if (isOPFSWorkspaceMiss(error)) {
      try {
        const target = await resolveVfsTarget(path, context, 'read')
        if (target.kind !== 'workspace') {
          throw error
        }
        const readStateKey = getReadStateKey(target)
        const { handle: nativeHandle, nativePath } = await resolveNativeDirectoryHandleForPath(
          target.path, context.directoryHandle, context.workspaceId
        )
        if (nativeHandle) {
          const result = readPolicy
            ? await readFile(nativePath, nativeHandle, context.workspaceId, readPolicy, context.projectId)
            : await readFile(nativePath, nativeHandle, context.workspaceId, undefined, context.projectId)
          const { content, metadata } = result
          if (maxSize && metadata.size > maxSize) {
            return toolErrorJson(
              'read',
              'too_large',
              `File size ${metadata.size} exceeds requested max_size ${maxSize}.`,
              { details: { path, fileSize: metadata.size, maxSize } }
            )
          }
          if (typeof content === 'string') {
            const totalLines = content.split('\n').length
            const formatted = applyTextRange(content, options)
            // Safety limit: cap the actual payload returned to the model.
            const sizeLimitCheck = checkContentSizeLimit(formatted, metadata.size, totalLines)
            if (!sizeLimitCheck.ok) {
              return toolErrorJson('read', 'content_too_large', sizeLimitCheck.error, {
                details: { totalLines: sizeLimitCheck.totalLines },
                hint: buildMaxSizeHint(sizeLimitCheck.suggestedMaxSize),
              })
            }
            readFileState.set(
              readStateKey,
              buildReadStateEntry(
                formatted,
                options,
                normalizeReadStateSource(result.source, 'workspace')
              )
            )
            // Record mtime for future dedup
            recordReadMtime(context, loopCheckResult!.dedupKey, metadata.mtime, metadata.size)
            return toolOkJson(
              'read',
              {
                path,
                kind: 'text',
                content: formatted,
                metadata: { size: metadata.size, contentType: metadata.contentType },
                range: {
                  start_line: options.startLine,
                  line_count: options.lineCount,
                },
              },
              {
                ...(loopCheckResult!.warning ? { _warning: loopCheckResult!.warning } : {}),
                source: 'native_fallback',
              }
            )
          }
          // ── Native fallback: try format handler on binary content ──
          if (metadata.contentType === 'binary' && content instanceof Uint8Array) {
            const formatResult = await tryFormatHandlerRead(
              content,
              path,
              metadata.size,
              'application/octet-stream',
              options,
              readStateKey,
              readFileState,
              result.source ?? '',
              {
                ...(loopCheckResult!.warning ? { _warning: loopCheckResult!.warning } : {}),
                source: 'native_fallback',
              },
              loopCheckResult!.dedupKey,
              metadata.mtime,
              context,
            )
            if (formatResult) return formatResult
          }

          // Native fallback binary: check known extension, then try text decode
          const nativeBinary = content instanceof Uint8Array ? content
            : content instanceof ArrayBuffer ? content : null
          if (nativeBinary && !isKnownBinaryExtension(path)) {
            const decoded = tryDecodeAsText(nativeBinary)
            if (decoded !== null) {
              const totalLines = decoded.split('\n').length
              const formatted = applyTextRange(decoded, options)
              const sizeLimitCheck = checkContentSizeLimit(formatted, metadata.size, totalLines)
              if (!sizeLimitCheck.ok) {
                return toolErrorJson('read', 'content_too_large', sizeLimitCheck.error, {
                  details: { totalLines: sizeLimitCheck.totalLines },
                  hint: buildMaxSizeHint(sizeLimitCheck.suggestedMaxSize),
                })
              }
              readFileState.set(
                readStateKey,
                buildReadStateEntry(
                  formatted,
                  options,
                  normalizeReadStateSource(result.source, 'workspace')
                )
              )
              recordReadMtime(context, loopCheckResult!.dedupKey, metadata.mtime, metadata.size)
              return toolOkJson(
                'read',
                {
                  path,
                  kind: 'text',
                  content: formatted,
                  metadata: { size: metadata.size, contentType: metadata.contentType },
                  range: {
                    start_line: options.startLine,
                    line_count: options.lineCount,
                  },
                },
                {
                  ...(loopCheckResult!.warning ? { _warning: loopCheckResult!.warning } : {}),
                  source: 'native_fallback',
                }
              )
            }
          }
          return toolErrorJson(
            'read',
            'binary_file_rejected',
            `This is a binary file (${metadata.contentType || 'unknown type'}), which cannot be displayed as text. ` +
              'Please use the `run_python` tool to read binary files (e.g. images, PDFs, Excel, ZIP, etc.). ' +
              `Example: use sync-to-opfs(paths=["${path}"]) first, then read it in Python via /mnt/${path}.`,
            { details: { path, contentType: metadata.contentType, size: metadata.size } }
          )
        }
      } catch (fallbackError) {
        // eslint-disable-next-line no-ex-assign -- intentionally propagates to outer error handler
        error = fallbackError
      }
    }
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return toolErrorJson('read', 'file_not_found', `File not found: ${path}`)
    }
    if (isOPFSWorkspaceMiss(error)) {
      return toolErrorJson('read', 'file_not_found', `File not found: ${path}`)
    }
    return toolErrorJson(
      'read',
      'internal_error',
      `Failed to read file: ${formatToolErrorMessage(error)}`,
      { retryable: true }
    )
  }
}

function hasRangeOptions(options: ReadRangeOptions): boolean {
  return options.startLine !== undefined || options.lineCount !== undefined
}

function buildReadStateEntry(
  content: string,
  options: ReadRangeOptions,
  source: import('./tool-types').ReadFileStateEntry['source'] = 'workspace'
) {
  const hasRange = hasRangeOptions(options)
  return {
    content,
    timestamp: Date.now(),
    offset: hasRange ? (options.startLine ?? 1) : undefined,
    limit: hasRange ? options.lineCount : undefined,
    isPartialView: false,
    source,
  }
}

function normalizeReadStateSource(
  source: string | undefined,
  fallback: import('./tool-types').ReadFileStateEntry['source']
): import('./tool-types').ReadFileStateEntry['source'] {
  const value = source ?? fallback
  if (
    value === 'workspace' ||
    value === 'native' ||
    value === 'opfs' ||
    value === 'agent' ||
    value === 'assets' ||
    value === 'skills' ||
    value === 'webmcp' ||
    value === 'native_fallback'
  ) {
    return value
  }
  return fallback
}

function validateReadRange(options: ReadRangeOptions): string | null {
  if (options.startLine !== undefined && options.startLine < 1) {
    return 'start_line must be >= 1'
  }
  if (options.lineCount !== undefined && options.lineCount <= 0) {
    return 'line_count must be > 0'
  }
  return null
}

function applyTextRange(content: string, options: ReadRangeOptions): string {
  const hasLineRange = options.startLine !== undefined || options.lineCount !== undefined
  if (!hasLineRange) {
    return content
  }

  const start = (options.startLine ?? 1) - 1
  const count = options.lineCount ?? Number.MAX_SAFE_INTEGER
  const lines = content.split('\n')
  return lines.slice(start, start + count).join('\n')
}

//-----------------------------------------------------------------------------
// Prompt doc
//-----------------------------------------------------------------------------

export const readPromptDoc: ToolPromptDoc = {
  category: 'file-ops',
  section: '### File Operations',
  lines: [
    '- `read(path)` - Read file contents (supports relative workspace paths and `vfs://workspace/...`, `vfs://agents/{id}/...`, `vfs://webmcp/...`)',
    '- `read(paths)` - Read multiple files',
  ],
}
