/**
 * Conversation Export Service
 *
 * Exports conversation records in multiple formats:
 * - JSON: structured readable history, not a lossless runtime checkpoint
 * - Markdown: human-readable, suitable for sharing and reading
 * - HTML: styled document, suitable for printing and archiving
 *
 * Images & attachments:
 * - User uploads / agent-generated files live in the conversation's OPFS
 *   assets directory and are read by conversation id (conversationId equals
 *   workspaceId).
 * - Inline base64 images (`msg.images`, `msg.contentParts`) are decoded.
 * - Markdown export bundles the document together with `images/` and
 *   `attachments/` folders into a single .zip when any file is available;
 *   the markdown references them via relative paths. (base64 data URIs are
 *   not used because many markdown renderers, e.g. GitHub, refuse them.)
 * - HTML export inlines images as base64 <img> tags (single-file document).
 * - JSON export embeds the raw `assets`/`images`/`contentParts` fields.
 *
 * @module conversation-export
 */

import { saveAs } from 'file-saver'
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import type { Conversation, Message } from '@/agent/message-types'
import { getMessageRecordType, type MessageRecordType } from '@/agent/message-types'
import { selectConversationExportMessages } from '@/agent/message-projections'
import type { AssetMeta } from '@/types/asset'

// ============================================================================
// Types
// ============================================================================

export type ConversationExportFormat = 'json' | 'markdown' | 'html'

export interface ConversationExportOptions {
  /** Export format */
  format: ConversationExportFormat
  /** Whether to include tool call details */
  includeToolCalls?: boolean
  /** Whether to include reasoning content */
  includeReasoning?: boolean
  /** Whether to include token usage info */
  includeUsage?: boolean
  /** Whether to include system messages */
  includeSystemMessages?: boolean
  /**
   * Whether to include images & attachments attached to messages.
   * - markdown: bundles files into a .zip next to conversation.md
   * - html: inlines images as base64 <img>
   * - json: embeds images/contentParts fields
   */
  includeImages?: boolean
  /** Custom filename (without extension) */
  filename?: string
  /** Add timestamp to filename */
  addTimestamp?: boolean
  /** Export progress callback */
  onProgress?: (progress: number, status: string) => void
}

export interface ConversationExportResult {
  success: boolean
  filename: string
  size: number
  format: ConversationExportFormat
  messageCount: number
  /** Number of image/attachment files that were readable (and thus bundled/inlined) */
  bundledFileCount?: number
  error?: string
}

/** Serializable representation of a conversation for JSON export */
export interface ConversationExportData {
  /** Export metadata */
  meta: {
    exportedAt: string
    format: string
    version: string
  }
  /** Conversation info */
  conversation: {
    id: string
    title: string
    createdAt: string
    updatedAt: string
  }
  /** Filtered messages */
  messages: Array<{
    id: string
    role: string
    recordType: MessageRecordType
    kind?: Message['kind']
    delegationNote?: Message['delegationNote']
    readImageHandoff?: Message['readImageHandoff']
    content: string | null
    reasoning?: string | null
    timestamp: string
    toolCalls?: Message['toolCalls']
    toolCallId?: string
    name?: string
    usage?: Message['usage']
    /** File asset metadata attached to the message (uploads / agent-generated) */
    assets?: AssetMeta[]
    /** Inline AI-generated images (base64) */
    images?: Message['images']
    /** Multimodal content parts, including image parts (base64) */
    contentParts?: Message['contentParts']
  }>
}

/**
 * A single image/attachment collected from a message for export packaging.
 */
export interface ExportArtifact {
  /** Bundle-relative path, e.g. "images/chart.png" or "attachments/data.xlsx" */
  bundlePath: string
  /** Original display name (e.g. "chart.png") */
  displayName: string
  mimeType: string
  isImage: boolean
  /** base64 payload without the data: prefix (empty when missing) */
  base64: string
  /** Raw bytes for zip packaging (absent when missing) */
  bytes?: Uint8Array
  /** True when the file could not be read from storage */
  missing: boolean
}

// ============================================================================
// Main Export Function
// ============================================================================

/**
 * In-memory representation of one conversation's export output:
 * a set of bundle-relative file paths → bytes, ready to be zipped.
 */
export interface ConversationExportFiles {
  /** conversation record used to produce the files */
  conversation: Conversation
  /** format that was rendered */
  format: ConversationExportFormat
  /** bundle-relative path → file bytes (already prefixed with the conversation's directory when dirPrefix was given) */
  files: Map<string, Uint8Array>
  /** number of filtered messages included */
  messageCount: number
  /** number of image/attachment files that were readable (and thus bundled/inlined) */
  bundledFileCount: number
}

/**
 * Render a conversation's export output into an in-memory file set.
 *
 * This is the core of the export pipeline with NO download side effect —
 * `exportConversation` (single download) and `exportConversationsBatch`
 * (multi-conversation zip) both build on it.
 *
 * @param dirPrefix optional sub-directory prefix for every file path (e.g. `01-My Talk`).
 *                  Used by batch export; single export passes none.
 */
export async function prepareConversationExport(
  conversation: Conversation,
  options: ConversationExportOptions,
  dirPrefix?: string,
): Promise<ConversationExportFiles | { error: string }> {
  const {
    format,
    includeToolCalls = true,
    includeReasoning = true,
    includeUsage = false,
    includeSystemMessages = false,
    includeImages = true,
  } = options

  // Filter and normalize messages
  const messages = selectConversationExportMessages(conversation.messages, {
    includeToolCalls,
    includeSystemMessages,
  })

  if (messages.length === 0) {
    return { error: 'No messages to export' }
  }

  // Collect images & attachments (shared across formats)
  let artifactsByMessage = new Map<string, ExportArtifact[]>()
  if (includeImages) {
    artifactsByMessage = await collectArtifacts(messages, conversation.id)
  }
  const allArtifacts = [...artifactsByMessage.values()].flat()
  const bundledCount = allArtifacts.filter((a) => !a.missing).length

  const files = new Map<string, Uint8Array>()
  const prefix = dirPrefix ? `${dirPrefix}/` : ''

  switch (format) {
    case 'json': {
      const json = buildJSONString(conversation, messages, {
        includeToolCalls,
        includeReasoning,
        includeUsage,
        includeImages,
      })
      files.set(`${prefix}conversation.json`, strToU8(json))
      break
    }
    case 'markdown': {
      const md = buildMarkdown(conversation, messages, {
        includeToolCalls,
        includeReasoning,
      }, artifactsByMessage)
      files.set(`${prefix}conversation.md`, strToU8(md))
      // Bundle media files next to the document.
      for (const artifact of allArtifacts) {
        if (artifact.missing || !artifact.bytes) continue
        files.set(`${prefix}${artifact.bundlePath}`, artifact.bytes)
      }
      break
    }
    case 'html': {
      const html = buildHTML(conversation, messages, {
        includeToolCalls,
        includeReasoning,
      }, artifactsByMessage)
      files.set(`${prefix}conversation.html`, strToU8(html))
      break
    }
    default:
      throw new Error(`Unsupported format: ${format}`)
  }

  return {
    conversation,
    format,
    files,
    messageCount: messages.length,
    bundledFileCount: bundledCount,
  }
}

/**
 * Export a conversation to the specified format and trigger download.
 */
export async function exportConversation(
  conversation: Conversation,
  options: ConversationExportOptions,
): Promise<ConversationExportResult> {
  const { format, filename, addTimestamp = true, onProgress } = options

  try {
    onProgress?.(10, 'Preparing messages...')

    const prepared = await prepareConversationExport(conversation, options)

    if ('error' in prepared) {
      return {
        success: false,
        filename: '',
        size: 0,
        format,
        messageCount: 0,
        error: prepared.error,
      }
    }

    onProgress?.(80, 'Saving file...')

    const baseName =
      filename || conversation.title.replace(/[/\\?%*:|"<>]/g, '-').trim() || 'conversation'

    // Single-file download. The prepared file set is either a single document
    // (md/json/html) or a markdown doc + bundled media — the latter becomes a zip.
    let blob: Blob
    let extension: string
    if (prepared.files.size > 1) {
      // Markdown + artifacts → zip bundle (same behavior as before this refactor)
      const mediaArtifacts: ExportArtifact[] = [...prepared.files.entries()]
        .filter(([p]) => p !== 'conversation.md')
        .map(([p, bytes]) => ({
          bundlePath: p,
          displayName: p,
          mimeType: 'application/octet-stream',
          isImage: false,
          base64: '',
          bytes,
          missing: false,
        }))
      blob = zipBundle('conversation.md', prepared.files.get('conversation.md')!, mediaArtifacts)
      extension = 'zip'
    } else {
      const [path, bytes] = [...prepared.files.entries()][0]
      const type =
        path.endsWith('.md') ? 'text/markdown;charset=utf-8' :
        path.endsWith('.json') ? 'application/json;charset=utf-8' :
        'text/html;charset=utf-8'
      blob = new Blob([bytes], { type })
      extension = path.split('.').pop() || format
    }

    const finalFilename = buildFilename(baseName, extension, addTimestamp)
    saveAs(blob, finalFilename)

    onProgress?.(100, 'Export complete')

    return {
      success: true,
      filename: finalFilename,
      size: blob.size,
      format,
      messageCount: prepared.messageCount,
      bundledFileCount: prepared.bundledFileCount,
    }
  } catch (error) {
    return {
      success: false,
      filename: '',
      size: 0,
      format,
      messageCount: 0,
      error: error instanceof Error ? error.message : 'Unknown error during export',
    }
  }
}

// ============================================================================
// Message Labels
// ============================================================================

function messageLabel(message: Message): string {
  switch (getMessageRecordType(message)) {
    case 'agent_input': return 'Agent Input'
    case 'context_summary': return 'Context Summary'
    case 'context_update': return 'Runtime Context'
    case 'run_changes': return 'Run Changes'
    case 'user_input': return 'User'
    case 'assistant_output': return 'Assistant'
    case 'tool_result': return 'Tool'
    case 'system': return 'System'
  }
}

// ============================================================================
// Artifact Collection (images & attachments)
// ============================================================================

/**
 * Collect exportable images/attachments for each message.
 *
 * Sources, in order:
 * 1. `msg.assets` — files in the conversation's OPFS assets directory
 *    (user uploads and agent-generated files). Read by conversation id.
 * 2. `msg.images` — inline base64 images generated via /image command.
 * 3. `msg.contentParts` image parts — inline base64 images (e.g. tool
 *    screenshots). Text parts are skipped: their text is already present
 *    in `msg.content`.
 *
 * Unreadable assets are kept as `missing` entries so the export can render
 * an explicit placeholder instead of silently dropping the file.
 */
async function collectArtifacts(
  messages: Message[],
  conversationId: string,
): Promise<Map<string, ExportArtifact[]>> {
  const result = new Map<string, ExportArtifact[]>()

  // Lazily resolve the conversation's OPFS assets directory (best effort —
  // may be missing for old/pruned conversations; resolved at most once).
  let assetsDir: FileSystemDirectoryHandle | null = null
  let assetsDirResolved = false
  const getAssetsDir = async (): Promise<FileSystemDirectoryHandle | null> => {
    if (assetsDirResolved) return assetsDir
    assetsDirResolved = true
    try {
      const { getWorkspaceManager } = await import('@/opfs')
      const manager = await getWorkspaceManager()
      const workspace = await manager.getWorkspace(conversationId)
      assetsDir = workspace ? await workspace.getAssetsDir() : null
    } catch {
      assetsDir = null
    }
    return assetsDir
  }

  const allocate = createBundleNameAllocator()
  const seenInlineBase64 = new Set<string>()
  let generatedSeq = 0
  let screenshotSeq = 0

  for (const msg of messages) {
    const artifacts: ExportArtifact[] = []

    // 1. File assets from OPFS
    for (const asset of msg.assets ?? []) {
      artifacts.push(await collectAssetArtifact(asset, getAssetsDir, allocate))
    }

    // 2. Inline generated images
    for (const img of msg.images ?? []) {
      generatedSeq += 1
      const ext = extFromMime(img.mimeType)
      const bundlePath = allocate('images', `generated-${generatedSeq}.${ext}`)
      artifacts.push(inlineArtifact(bundlePath, `generated-${generatedSeq}.${ext}`, img.mimeType, img.data))
    }

    // 3. Multimodal image parts (skip text parts — duplicated in msg.content)
    for (const part of msg.contentParts ?? []) {
      if (part.type !== 'image') continue
      // The same image may appear in several contentParts snapshots; skip dups.
      const dedupeKey = `${part.mimeType}:${part.data.slice(0, 96)}`
      if (seenInlineBase64.has(dedupeKey)) continue
      seenInlineBase64.add(dedupeKey)
      screenshotSeq += 1
      const ext = extFromMime(part.mimeType)
      const name = `screenshot-${screenshotSeq}.${ext}`
      const bundlePath = allocate('images', name)
      artifacts.push(inlineArtifact(bundlePath, name, part.mimeType, part.data))
    }

    if (artifacts.length > 0) result.set(msg.id, artifacts)
  }

  return result
}

/** Read an AssetMeta-backed file from the conversation's OPFS assets dir. */
async function collectAssetArtifact(
  asset: AssetMeta,
  getAssetsDir: () => Promise<FileSystemDirectoryHandle | null>,
  allocate: BundleNameAllocator,
): Promise<ExportArtifact> {
  const isImage = (asset.mimeType || '').startsWith('image/')
  const dir = isImage ? 'images' : 'attachments'
  const bundlePath = allocate(dir, asset.name)

  try {
    const dirHandle = await getAssetsDir()
    if (!dirHandle) throw new Error('assets dir unavailable')
    const blob = await readAssetFile(dirHandle, asset.name)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return {
      bundlePath,
      displayName: asset.name,
      mimeType: asset.mimeType || blob.type || 'application/octet-stream',
      isImage,
      base64: bytesToBase64(bytes),
      bytes,
      missing: false,
    }
  } catch {
    // File missing (pruned assets dir, old conversation, …) — keep a marker
    // so the export shows the file existed but could not be included.
    return {
      bundlePath,
      displayName: asset.name,
      mimeType: asset.mimeType || 'application/octet-stream',
      isImage,
      base64: '',
      missing: true,
    }
  }
}

/** Build an artifact from inline base64 image data. */
function inlineArtifact(
  bundlePath: string,
  displayName: string,
  mimeType: string,
  base64: string,
): ExportArtifact {
  return {
    bundlePath,
    displayName,
    mimeType: mimeType || 'image/png',
    isImage: true,
    base64,
    bytes: base64ToBytes(base64),
    missing: false,
  }
}

/** Read a file (possibly in nested subdirectories) from an OPFS dir handle. */
async function readAssetFile(
  dirHandle: FileSystemDirectoryHandle,
  assetPath: string,
): Promise<Blob> {
  const parts = assetPath.split('/').filter(Boolean)
  const fileName = parts.pop()
  if (!fileName) throw new Error(`invalid asset path: ${assetPath}`)

  let currentDir: FileSystemDirectoryHandle = dirHandle
  for (const segment of parts) {
    currentDir = await currentDir.getDirectoryHandle(segment)
  }
  const fileHandle = await currentDir.getFileHandle(fileName)
  return await fileHandle.getFile()
}

type BundleNameAllocator = (dir: 'images' | 'attachments', name: string) => string

/** Allocate unique bundle paths ("images/chart.png", "images/chart-2.png", …). */
function createBundleNameAllocator(): BundleNameAllocator {
  const used = new Set<string>()
  return (dir, name) => {
    if (!used.has(`${dir}/${name}`)) {
      used.add(`${dir}/${name}`)
      return `${dir}/${name}`
    }
    const dotIdx = name.lastIndexOf('.')
    const base = dotIdx > 0 ? name.slice(0, dotIdx) : name
    const ext = dotIdx > 0 ? name.slice(dotIdx) : ''
    let i = 2
    while (used.has(`${dir}/${base}-${i}${ext}`)) i += 1
    const final = `${dir}/${base}-${i}${ext}`
    used.add(final)
    return final
  }
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
}

function extFromMime(mimeType: string): string {
  return MIME_EXT[mimeType] || 'png'
}

/** Base64 → bytes (browser atob). */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Bytes → base64 (chunked to avoid call-stack limits on large files). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Zip the document plus all readable artifacts into a single download blob. */
function zipBundle(docPath: string, docBytes: Uint8Array, artifacts: ExportArtifact[]): Blob {
  const files: Zippable = {}
  // Compress the text document; store media files as-is (already compressed).
  files[docPath] = [docBytes, { level: 6 }]
  for (const artifact of artifacts) {
    if (artifact.missing || !artifact.bytes) continue
    files[artifact.bundlePath] = [artifact.bytes, { level: 0 }]
  }
  const zipped = zipSync(files)
  return new Blob([zipped], { type: 'application/zip' })
}

// ============================================================================
// Rendering helpers for artifacts
// ============================================================================

/** Strip characters that would break markdown alt text / link labels. */
function sanitizeMdLabel(label: string): string {
  return label.replace(/[[\]\\]/g, '')
}

/** Markdown lines for a message's images & attachments. */
function renderArtifactsMarkdown(artifacts: ExportArtifact[] | undefined): string[] {
  if (!artifacts || artifacts.length === 0) return []
  const lines: string[] = []
  for (const a of artifacts) {
    if (a.missing) {
      const kind = a.isImage ? 'Image' : 'Attachment'
      lines.push(`> ⚠️ ${kind} \`${a.displayName}\` could not be read from storage and is not included.`)
    } else if (a.isImage) {
      lines.push(`![${sanitizeMdLabel(a.displayName)}](${a.bundlePath})`)
    } else {
      lines.push(`📎 [${sanitizeMdLabel(a.displayName)}](${a.bundlePath})`)
    }
  }
  return lines
}

/** HTML snippet for a message's images & attachments (base64 inline). */
function renderArtifactsHtml(artifacts: ExportArtifact[] | undefined): string {
  if (!artifacts || artifacts.length === 0) return ''
  return artifacts
    .map((a) => {
      if (a.missing) {
        return `<div class="attachment attachment-missing">⚠️ ${escapeHtml(a.displayName)} (file not available)</div>`
      }
      if (a.isImage) {
        return `<img class="export-image" src="data:${a.mimeType};base64,${a.base64}" alt="${escapeHtml(a.displayName)}" />`
      }
      const size = a.bytes ? formatByteSize(a.bytes.length) : ''
      return `<div class="attachment">📎 ${escapeHtml(a.displayName)}${size ? ` (${size})` : ''}</div>`
    })
    .join('')
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ============================================================================
// JSON Export
// ============================================================================

function buildJSONString(
  conversation: Conversation,
  messages: Message[],
  options: {
    includeToolCalls: boolean
    includeReasoning: boolean
    includeUsage: boolean
    includeImages: boolean
  },
): string {
  const data: ConversationExportData = {
    meta: {
      exportedAt: new Date().toISOString(),
      format: 'creatorweave-conversation',
      version: '1.1.0',
    },
    conversation: {
      id: conversation.id,
      title: conversation.title,
      createdAt: new Date(conversation.createdAt).toISOString(),
      updatedAt: new Date(conversation.updatedAt).toISOString(),
    },
    messages: messages.map((msg) => ({
      id: msg.id,
      role: msg.role,
      recordType: getMessageRecordType(msg),
      kind: msg.kind,
      delegationNote: msg.delegationNote,
      readImageHandoff: msg.readImageHandoff ? {
        ...msg.readImageHandoff,
        imageData: options.includeImages ? msg.readImageHandoff.imageData : undefined,
      } : undefined,
      content: msg.content,
      reasoning: options.includeReasoning ? msg.reasoning : undefined,
      timestamp: new Date(msg.timestamp).toISOString(),
      toolCalls: options.includeToolCalls ? msg.toolCalls : undefined,
      toolCallId: options.includeToolCalls ? msg.toolCallId : undefined,
      name: options.includeToolCalls ? msg.name : undefined,
      usage: options.includeUsage ? msg.usage : undefined,
      // Attachments: asset metadata is lightweight and always included;
      // inline base64 payloads follow the includeImages switch.
      assets: msg.assets,
      images: options.includeImages ? msg.images : undefined,
      contentParts: options.includeImages ? msg.contentParts : undefined,
    })),
  }

  return JSON.stringify(data, null, 2)
}

// ============================================================================
// Markdown Export
// ============================================================================

function buildMarkdown(
  conversation: Conversation,
  messages: Message[],
  options: { includeToolCalls: boolean; includeReasoning: boolean },
  artifactsByMessage: Map<string, ExportArtifact[]>,
): string {
  const lines: string[] = []

  // Title
  lines.push(`# ${conversation.title}`)
  lines.push('')
  lines.push(
    `> Exported on ${new Date().toLocaleString()} | Created on ${new Date(conversation.createdAt).toLocaleString()}`,
  )
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const msg of messages) {
    const time = new Date(msg.timestamp).toLocaleString()
    const artifacts = artifactsByMessage.get(msg.id)

    switch (msg.role) {
      case 'user':
        lines.push(`### 👤 ${messageLabel(msg)} — ${time}`)
        lines.push('')
        lines.push(msg.content || '')
        lines.push('')
        lines.push(...renderArtifactsMarkdown(artifacts))
        lines.push('')
        break

      case 'assistant': {
        lines.push(`### 🤖 ${messageLabel(msg)} — ${time}`)
        lines.push('')

        // Reasoning
        if (options.includeReasoning && msg.reasoning) {
          lines.push('<details>')
          lines.push('<summary>💭 Reasoning</summary>')
          lines.push('')
          lines.push(msg.reasoning)
          lines.push('')
          lines.push('</details>')
          lines.push('')
        }

        // Content
        if (msg.content) {
          lines.push(msg.content)
          lines.push('')
        }

        // Generated / attached images
        const imageLines = renderArtifactsMarkdown(artifacts)
        if (imageLines.length > 0) {
          lines.push(...imageLines)
          lines.push('')
        }

        // Tool calls
        if (options.includeToolCalls && msg.toolCalls && msg.toolCalls.length > 0) {
          lines.push('<details>')
          lines.push(`<summary>🔧 Tool Calls (${msg.toolCalls.length})</summary>`)
          lines.push('')
          for (const tc of msg.toolCalls) {
            lines.push(`**${tc.function.name}**`)
            lines.push('```json')
            lines.push(formatToolArgs(tc.function.arguments))
            lines.push('```')
            lines.push('')
          }
          lines.push('</details>')
          lines.push('')
        }

        lines.push('---')
        lines.push('')
        break
      }

      case 'tool':
        if (options.includeToolCalls) {
          lines.push(`### 🔧 Tool: ${msg.name || 'unknown'} — ${time}`)
          lines.push('')
          lines.push('```')
          lines.push(msg.content || '')
          lines.push('```')
          lines.push('')
          const toolImageLines = renderArtifactsMarkdown(artifacts)
          if (toolImageLines.length > 0) {
            lines.push(...toolImageLines)
            lines.push('')
          }
          lines.push('---')
          lines.push('')
        }
        break

      case 'system':
        lines.push(`### ⚙️ System — ${time}`)
        lines.push('')
        lines.push(msg.content || '')
        lines.push('')
        break
    }
  }

  return lines.join('\n')
}

// ============================================================================
// HTML Export
// ============================================================================

function buildHTML(
  conversation: Conversation,
  messages: Message[],
  options: { includeToolCalls: boolean; includeReasoning: boolean },
  artifactsByMessage: Map<string, ExportArtifact[]>,
): string {
  const roleLabels: Record<string, { icon: string; label: string; color: string }> = {
    user: { icon: '👤', label: 'User', color: '#3b82f6' },
    assistant: { icon: '🤖', label: 'Assistant', color: '#8b5cf6' },
    tool: { icon: '🔧', label: 'Tool', color: '#f59e0b' },
    system: { icon: '⚙️', label: 'System', color: '#6b7280' },
  }

  const messageParts = messages.map((msg) => {
    const role = { ...(roleLabels[msg.role] || roleLabels.system), label: messageLabel(msg) }
    const time = new Date(msg.timestamp).toLocaleString()

    let body = ''

    // Reasoning section
    if (options.includeReasoning && msg.role === 'assistant' && msg.reasoning) {
      body += `
        <details class="reasoning">
          <summary>💭 Reasoning</summary>
          <div class="reasoning-content">${escapeHtml(msg.reasoning)}</div>
        </details>`
    }

    // Content
    if (msg.content) {
      body += `<div class="message-content">${escapeHtml(msg.content)}</div>`
    }

    // Images & attachments (inline base64 for images)
    body += renderArtifactsHtml(artifactsByMessage.get(msg.id))

    // Tool calls
    if (options.includeToolCalls && msg.role === 'assistant' && msg.toolCalls?.length) {
      body += `
        <details class="tool-calls">
          <summary>🔧 Tool Calls (${msg.toolCalls.length})</summary>
          ${msg.toolCalls
            .map(
              (tc) => `
            <div class="tool-call">
              <div class="tool-name">${escapeHtml(tc.function.name)}</div>
              <pre><code>${escapeHtml(formatToolArgs(tc.function.arguments))}</code></pre>
            </div>`,
            )
            .join('')}
        </details>`
    }

    // Tool result
    if (options.includeToolCalls && msg.role === 'tool') {
      body += `<pre class="tool-result"><code>${escapeHtml(msg.content || '')}</code></pre>`
    }

    return `
      <div class="message message-${msg.role}">
        <div class="message-header">
          <span class="role-icon">${role.icon}</span>
          <span class="role-label" style="color: ${role.color}">${role.label}</span>
          <span class="message-time">${time}</span>
        </div>
        ${body}
      </div>`
  })

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(conversation.title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f8fafc;
      color: #1e293b;
      line-height: 1.6;
      padding: 2rem;
      max-width: 800px;
      margin: 0 auto;
    }
    .header {
      text-align: center;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 2px solid #e2e8f0;
    }
    .header h1 { font-size: 1.5rem; color: #0f172a; margin-bottom: 0.5rem; }
    .header .meta { font-size: 0.8rem; color: #94a3b8; }
    .message {
      background: white;
      border-radius: 12px;
      padding: 1rem 1.25rem;
      margin-bottom: 1rem;
      border: 1px solid #e2e8f0;
      box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    }
    .message-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.75rem;
      font-size: 0.8rem;
    }
    .role-icon { font-size: 1rem; }
    .role-label { font-weight: 600; }
    .message-time { color: #94a3b8; margin-left: auto; }
    .message-content {
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.9rem;
    }
    .message-user { border-left: 3px solid #3b82f6; }
    .message-assistant { border-left: 3px solid #8b5cf6; }
    .message-tool { border-left: 3px solid #f59e0b; background: #fffbeb; }
    .message-system { border-left: 3px solid #6b7280; background: #f1f5f9; }
    .export-image {
      display: block;
      max-width: 100%;
      border-radius: 8px;
      margin-top: 0.5rem;
      border: 1px solid #e2e8f0;
    }
    .attachment {
      margin-top: 0.5rem;
      font-size: 0.85rem;
      color: #475569;
      background: #f1f5f9;
      border-radius: 8px;
      padding: 0.4rem 0.75rem;
    }
    .attachment-missing { color: #b45309; background: #fffbeb; }
    details {
      margin-top: 0.5rem;
      background: #f8fafc;
      border-radius: 8px;
      padding: 0.5rem 0.75rem;
    }
    details summary {
      cursor: pointer;
      font-size: 0.8rem;
      font-weight: 500;
      color: #64748b;
    }
    details pre, details code {
      font-size: 0.8rem;
      background: #1e293b;
      color: #e2e8f0;
      padding: 0.75rem;
      border-radius: 6px;
      overflow-x: auto;
      margin-top: 0.5rem;
    }
    .tool-call { margin-top: 0.5rem; }
    .tool-name { font-weight: 600; font-size: 0.85rem; color: #334155; }
    .tool-result {
      font-size: 0.8rem;
      background: #1e293b;
      color: #e2e8f0;
      padding: 0.75rem;
      border-radius: 6px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .reasoning-content { white-space: pre-wrap; font-size: 0.85rem; color: #475569; }
    @media print {
      body { padding: 0; max-width: none; }
      .message { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(conversation.title)}</h1>
    <div class="meta">
      Created: ${new Date(conversation.createdAt).toLocaleString()} |
      Messages: ${messages.length} |
      Exported: ${new Date().toLocaleString()}
    </div>
  </div>
  ${messageParts.join('')}
</body>
</html>`

  return html
}

// ============================================================================
// Utilities
// ============================================================================

function buildFilename(base: string, extension: string, addTimestamp: boolean): string {
  const safeName = base.replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]/g, '_')
  const timestamp = addTimestamp ? `_${Date.now()}` : ''
  return `${safeName}${timestamp}.${extension}`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatToolArgs(args: string | undefined | unknown): string {
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args), null, 2)
    } catch {
      return args
    }
  }
  if (args != null) return JSON.stringify(args, null, 2)
  return ''
}

// Exposed for tests only (unpack a bundle produced by zipBundle).
export function __testUnzip(blob: Blob): Promise<Record<string, Uint8Array>> {
  return blob.arrayBuffer().then((buf) => unzipSync(new Uint8Array(buf)))
}
