/**
 * FileDiffViewer Component
 *
 * Displays side-by-side diff between OPFS and Native FS versions.
 * Uses Monaco DiffEditor for text comparison.
 * For format-registered files (HTML, NOL, etc.), delegates rendering to
 * the format-registry preview component; user toggles between preview
 * and source/diff view via the format view mode button.
 */

import React, { Suspense, useEffect, useRef, useState } from 'react'
import { type FileChange } from '@/opfs/types/opfs-types'
import { getActiveConversation } from '@/store/conversation-context.store'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@creatorweave/ui'
import { useT } from '@/i18n'
import {
  isImageFile,
  readFileFromOPFS,
  readBinaryFileFromOPFS,
  getFileContentType,
} from '@/opfs'
import { Columns2, UnfoldVertical, X, Eye, FileText, Download, Copy, Check, ClipboardCopy } from 'lucide-react'
import { getFormatUIHandler } from '@/agent/tools/format-registry'

const MonacoDiffEditor = React.lazy(() => import('./MonacoDiffEditor'))
const OfficePreview = React.lazy(() => import('@/components/file-viewer/OfficePreview').then(m => ({ default: m.OfficePreview })))

/** Office file extensions that use eo2suite remote preview (xlsx, xls, pptx, ppt, doc) */
const EO2_OFFICE_EXTS = new Set(['xlsx', 'xls', 'pptx', 'ppt', 'doc'])

/** Check if a file path points to an Office file (xlsx, pptx, doc, etc.) */
function isOfficeFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return EO2_OFFICE_EXTS.has(ext)
}

/** Check if a file path points to a docx file (rendered locally via docx-preview) */
function isDocxFile(path: string): boolean {
  return path.toLowerCase().endsWith('.docx')
}

/** Download a workspace file from OPFS */
async function downloadFile(filePath: string): Promise<void> {
  try {
    const activeConversation = await getActiveConversation()
    if (!activeConversation) return
    const { conversationId } = activeConversation
    const fileName = filePath.split('/').pop() || 'file'
    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''

    const binaryExts = new Set(['nol', 'zip', 'docx', 'xlsx', 'xls', 'pptx', 'ppt', 'doc', 'pdf', 'wasm', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp'])

    if (binaryExts.has(ext)) {
      const base64 = await readBinaryFileFromOPFS(conversationId, filePath)
      if (!base64) return
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const mimeMap: Record<string, string> = {
        nol: 'application/zip', zip: 'application/zip',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
      }
      const blob = new Blob([bytes], { type: mimeMap[ext] || 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()
      URL.revokeObjectURL(url)
    } else {
      const text = await readFileFromOPFS(conversationId, filePath)
      if (text == null) return
      const blob = new Blob([text], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()
      URL.revokeObjectURL(url)
    }
  } catch (err) {
    console.warn('[FileDiffViewer] Download failed:', err)
  }
}

/**
 * Read native file content through WorkspaceRuntime's routed disk executor.
 * This supports both browser-granted roots and Native Host scope roots.
 */
async function readNativeFileViaConversation(
  conversation: import('@/opfs').WorkspaceRuntime,
  filePath: string
): Promise<string | null> {
  try {
    const result = await conversation.readFile(filePath, undefined, { policy: 'prefer_native' })
    return result.source === 'native' && typeof result.content === 'string'
      ? result.content
      : null
  } catch {
    return null
  }
}

function fileContentToText(content: unknown): string | null {
  if (typeof content === 'string') return content
  return null
}

/**
 * Fallback readers for the "changed version" (OPFS draft) side.
 *
 * readFileFromOPFS navigates the raw OPFS files/ tree directly and can miss
 * content that lives in the workspace cache layer (e.g. writes that only
 * updated readCachedFile's store). Route every miss through the runtime's
 * readFile (multi-root routing + cache fallback) before giving up, and fall
 * back to readCachedFile last so pending create/modify drafts still render.
 */
async function readChangedVersionText(
  conversation: import('@/opfs').WorkspaceRuntime,
  filePath: string
): Promise<string | null> {
  let recoveredVia: 'runtime-read' | 'cached' | null = null
  try {
    const result = await conversation.readFile(filePath, undefined, { policy: 'prefer_opfs' })
    const text = fileContentToText(result.content)
    if (text !== null) {
      recoveredVia = 'runtime-read'
      return text
    }
  } catch {
    // Fall through to the cached-file fallback below.
  }
  try {
    const cached = await conversation.readCachedFile(filePath)
    const text = fileContentToText(cached)
    if (text !== null) recoveredVia = 'cached'
    return text
  } catch {
    return null
  } finally {
    if (recoveredVia) {
      // Recovery telemetry: tells us how often the primary files/ read is
      // broken (candidate causes: workspace-not-ready race, path-form
      // divergence, cross-conversation reads). High hit rate = the primary
      // reader needs fixing, not just this fallback.
      console.info(
        `[FileDiffViewer] primary OPFS read missed; recovered via ${recoveredVia}: ${filePath}`,
      )
    } else {
      // Terminal miss: capture the discriminating evidence. exactPendingMatch
      // rules out cross-workspace binding; basenameMatches exposes path-form
      // divergence; pendingCount rules out a stale/orphaned change entry.
      try {
        const pending = conversation.getPendingChanges()
        const pendingPaths = pending.map((p) => p.path)
        const base = filePath.split('/').pop() ?? ''
        console.error('[FileDiffViewer] changed-version body unreadable after all fallbacks', {
          path: filePath,
          pendingCount: pendingPaths.length,
          exactPendingMatch: pendingPaths.includes(filePath),
          basenameMatches: pendingPaths.filter((p) => p.endsWith(base)).slice(0, 5),
        })
      } catch {
        // Diagnostics are best-effort; never mask the original failure.
      }
    }
  }
}
const LazyDiffViewer = React.lazy(() => import('./LazyDiffViewer'))

import { type CommentSide, type LineComment } from './comment-types'

interface FileDiffViewerProps {
  fileChange: FileChange | null
  snapshotDiff?: {
    originalText: string
    modifiedText: string
    snapshotTitle?: string
    beforeKind?: 'text' | 'binary' | 'none'
    afterKind?: 'text' | 'binary' | 'none'
    beforeSize?: number
    afterSize?: number
    capturedAt?: number
    beforeBinary?: Uint8Array | null
    afterBinary?: Uint8Array | null
  } | null
  /** External comment state (managed by parent). Falls back to internal state if not provided. */
  commentsByPath?: Record<string, LineComment[]>
  /** Callback to update comment state in parent */
  onCommentsChange?: React.Dispatch<React.SetStateAction<Record<string, LineComment[]>>>
}

type FileContentState = {
  opfs: string | null
  native: string | null
  opfsImageUrl: string | null
  nativeImageUrl: string | null
  showNativePanel: boolean
  loading: boolean
  error: string | null
}

function getImageMimeType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.ico')) return 'image/x-icon'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.avif')) return 'image/avif'
  if (lower.endsWith('.heic')) return 'image/heic'
  if (lower.endsWith('.heif')) return 'image/heif'
  if (lower.endsWith('.tiff') || lower.endsWith('.tif')) return 'image/tiff'
  return 'application/octet-stream'
}

function formatSize(size?: number): string {
  const bytes = size || 0
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}B`
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return '-'
  try {
    return new Date(timestamp).toLocaleString('zh-CN', {
      hour12: false,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return String(timestamp)
  }
}

export const FileDiffViewer: React.FC<FileDiffViewerProps> = ({ fileChange, snapshotDiff = null, commentsByPath: externalCommentsByPath, onCommentsChange }) => {
  const t = useT()
  const [isSplitView, setIsSplitView] = useState(false)
  const [useFullEditor, setUseFullEditor] = useState(false)
  const [content, setContent] = useState<FileContentState>({
    opfs: null,
    native: null,
    opfsImageUrl: null,
    nativeImageUrl: null,
    showNativePanel: true,
    loading: false,
    error: null,
  })
  const [lightbox, setLightbox] = useState<{ src: string; title: string } | null>(null)
  const [officeBlob, setOfficeBlob] = useState<Blob | null>(null)
  const [docxBlob, setDocxBlob] = useState<Blob | null>(null)
  // Generic format handler state (for .nol and future formats registered in format-registry)
  const [formatBlob, setFormatBlob] = useState<Blob | null>(null)
  const [formatViewMode, setFormatViewMode] = useState<string>('preview')
  const docxContainerRef = useRef<HTMLDivElement>(null)
  const [snapshotImageUrls, setSnapshotImageUrls] = useState<{ before: string | null; after: string | null }>({
    before: null,
    after: null,
  })
  const [internalCommentsByPath, setInternalCommentsByPath] = useState<Record<string, LineComment[]>>({})
  // Use external state if provided (from SyncPreviewPanel), otherwise use internal state
  const commentsByPath = externalCommentsByPath ?? internalCommentsByPath
  const setCommentsByPath: React.Dispatch<React.SetStateAction<Record<string, LineComment[]>>> =
    onCommentsChange ?? setInternalCommentsByPath
  const [copiedPath, setCopiedPath] = useState(false)
  const [copiedContent, setCopiedContent] = useState(false)
  const [composer, setComposer] = useState<{
    side: CommentSide
    startLine: number
    endLine: number
    text: string
  } | null>(null)
  const activePath = fileChange?.path ?? ''
  const isSnapshotMode = Boolean(snapshotDiff)
  const hasBinarySnapshot = isSnapshotMode && (
    snapshotDiff?.beforeKind === 'binary' || snapshotDiff?.afterKind === 'binary'
  )
  const currentFileComments = activePath ? commentsByPath[activePath] ?? [] : []

  // Reset format view mode to default when file changes
  useEffect(() => {
    const ui = fileChange?.path ? getFormatUIHandler(fileChange.path) : null
    setFormatViewMode(ui?.viewModes.find(m => m.default)?.id ?? 'preview')
  }, [fileChange?.path])

  useEffect(() => {
    if (!fileChange) {
      setContent({
        opfs: null,
        native: null,
        opfsImageUrl: null,
        nativeImageUrl: null,
        showNativePanel: true,
        loading: false,
        error: null,
      })
      setOfficeBlob(null)
      setDocxBlob(null)
      setFormatBlob(null)
      return
    }

    if (snapshotDiff) {
      setContent({
        opfs: snapshotDiff.modifiedText,
        native: snapshotDiff.originalText,
        opfsImageUrl: null,
        nativeImageUrl: null,
        showNativePanel: true,
        loading: false,
        error: null,
      })
      return
    }

    const loadContents = async () => {
      setContent((prev) => ({ ...prev, loading: true, error: null }))

      try {
        const activeConversation = await getActiveConversation()
        if (!activeConversation) {
          throw new Error(t('sidebar.fileDiffViewer.noWorkspace'))
        }

        const { conversation, conversationId } = activeConversation
        const filePath = fileChange.path
        const isImage = isImageFile(filePath)
        const isOffice = isOfficeFile(filePath)
        const isDocx = isDocxFile(filePath)
        const formatUI = getFormatUIHandler(filePath)
        const isFormat = !!formatUI
        let showNativePanel = fileChange.type !== 'add'

        let originalContent: string | null = null

        if (fileChange.type !== 'add') {
          const nativeContent = await readNativeFileViaConversation(conversation, filePath)
          // Deletion preview: keep the disk content visible even though the
          // OPFS side is already cleared. Without this, a delete shows only a
          // "file deleted" placeholder (showNativePanel=false + opfs=null →
          // early-return below) instead of WHAT is being deleted — which is
          // exactly what the user needs for informed consent.
          showNativePanel = fileChange.type === 'delete' ? true : nativeContent !== null
          originalContent = nativeContent
        }

        if (isImage) {
          let opfsImageUrl: string | null = null
          let nativeImageUrl: string | null = null
          const mimeType = getImageMimeType(filePath)

          try {
            if (fileChange.type !== 'delete') {
              const opfsBase64 = await readBinaryFileFromOPFS(conversationId, filePath)
              if (opfsBase64) {
                opfsImageUrl = `data:${mimeType};base64,${opfsBase64}`
              }
            }
          } catch (err) {
            console.warn('[FileDiffViewer] Failed to read OPFS image:', err)
          }

          try {
            if (fileChange.type !== 'add') {
              const native = await conversation.readFile(filePath, undefined, { policy: 'prefer_native' })
              if (native.source === 'native') {
                const nativeContent = native.content
                const bytes = typeof nativeContent === 'string'
                  ? new TextEncoder().encode(nativeContent)
                  : nativeContent instanceof Blob
                    ? new Uint8Array(await nativeContent.arrayBuffer())
                    : new Uint8Array(nativeContent)
                let binary = ''
                for (const byte of bytes) binary += String.fromCharCode(byte)
                nativeImageUrl = `data:${mimeType};base64,${btoa(binary)}`
              }
            }
          } catch (err) {
            console.warn('[FileDiffViewer] Failed to read native image:', err)
          }

          setContent({
            opfs: null,
            native: null,
            opfsImageUrl,
            nativeImageUrl,
            showNativePanel,
            loading: false,
            error: null,
          })
        } else if (isDocx) {
          // DOCX file: read binary blob for local docx-preview rendering
          if (fileChange.type !== 'delete') {
            try {
              const opfsBase64 = await readBinaryFileFromOPFS(conversationId, filePath)
              if (opfsBase64) {
                const bytes = Uint8Array.from(atob(opfsBase64), c => c.charCodeAt(0))
                const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
                setDocxBlob(blob)
              }
            } catch (err) {
              console.warn('[FileDiffViewer] Failed to read DOCX file:', err)
            }
          }
          setContent({
            opfs: null,
            native: null,
            opfsImageUrl: null,
            nativeImageUrl: null,
            showNativePanel,
            loading: false,
            error: null,
          })
        } else if (isOffice) {
          // Office file: read binary blob for preview
          if (fileChange.type !== 'delete') {
            try {
              const opfsBase64 = await readBinaryFileFromOPFS(conversationId, filePath)
              if (opfsBase64) {
                const bytes = Uint8Array.from(atob(opfsBase64), c => c.charCodeAt(0))
                const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
                const mimeTypes: Record<string, string> = {
                  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  xls: 'application/vnd.ms-excel',
                  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                  ppt: 'application/vnd.ms-powerpoint',
                  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  doc: 'application/msword',
                }
                const blob = new Blob([bytes], { type: mimeTypes[ext] || 'application/octet-stream' })
                setOfficeBlob(blob)
              }
            } catch (err) {
              console.warn('[FileDiffViewer] Failed to read Office file:', err)
            }
          }
          setContent({
            opfs: null,
            native: null,
            opfsImageUrl: null,
            nativeImageUrl: null,
            showNativePanel,
            loading: false,
            error: null,
          })
        } else if (isFormat) {
          // Format-registered file: read binary blob for preview + render text via handler
          let formatText: string | null = null
          if (fileChange.type !== 'delete') {
            try {
              const opfsBase64 = await readBinaryFileFromOPFS(conversationId, filePath)
              if (opfsBase64) {
                const bytes = Uint8Array.from(atob(opfsBase64), c => c.charCodeAt(0))
                const blob = new Blob([bytes], { type: 'application/zip' })
                setFormatBlob(blob)
                // Use format handler to render as text for text view mode
                if (formatUI?.renderTextContent) {
                  try {
                    formatText = await formatUI.renderTextContent(bytes, filePath)
                  } catch { /* ignore render error */ }
                }
              }
            } catch (err) {
              console.warn('[FileDiffViewer] Failed to read format file:', err)
            }
          }
          setContent({
            opfs: formatText,
            native: originalContent,
            opfsImageUrl: null,
            nativeImageUrl: null,
            showNativePanel,
            loading: false,
            error: null,
          })
        } else {
          let opfsContent: string | null = null
          try {
            if (fileChange.type !== 'delete') {
              opfsContent = await readFileFromOPFS(conversationId, filePath)
              // Direct files/ navigation can miss cache-layer drafts (the
              // add-type diff in the sync-to-disk auth flow). Retry through
              // the runtime's routed reader + cache before showing the
              // unreadable placeholder.
              if (opfsContent === null) {
                opfsContent = await readChangedVersionText(conversation, filePath)
              }
            }
          } catch (err) {
            console.warn('[FileDiffViewer] Failed to read OPFS content:', err)
            opfsContent = null
          }

          let nativeContent: string | null = null
          try {
            if (fileChange.type !== 'add') {
              nativeContent = await readNativeFileViaConversation(conversation, filePath)
              if (!nativeContent && showNativePanel) {
                // Deletion preview fallback: if the disk file is already gone
                // (or unreadable) we still force the native panel so the
                // renderer shows the "will be deleted" diff/placeholder
                // instead of silently collapsing to an empty view.
                if (fileChange.type === 'delete') {
                  nativeContent = ''
                  showNativePanel = true
                } else {
                  nativeContent = t('sidebar.fileDiffViewer.cannotReadNativeContent')
                }
              }
            }
          } catch (err) {
            console.warn('[FileDiffViewer] Failed to read native content:', err)
            nativeContent = t('sidebar.fileDiffViewer.readNativeFileFailed')
          }

          setContent({
            opfs: opfsContent,
            native: nativeContent,
            opfsImageUrl: null,
            nativeImageUrl: null,
            showNativePanel,
            loading: false,
            error: null,
          })
        }
      } catch (err) {
        setContent({
          opfs: null,
          native: null,
          opfsImageUrl: null,
          nativeImageUrl: null,
          showNativePanel: true,
          loading: false,
          error: err instanceof Error ? err.message : t('sidebar.fileDiffViewer.loadFailedError'),
        })
      }
    }

    loadContents()
  }, [fileChange, snapshotDiff])

  // Render docx into container (same approach as FilePreview)
  useEffect(() => {
    if (!docxBlob || !docxContainerRef.current) return

    let cancelled = false
    const container = docxContainerRef.current

    import('docx-preview').then(({ renderAsync }) => {
      if (cancelled) return
      renderAsync(docxBlob, container, undefined, {
        className: 'docx-preview',
        inWrapper: true,
        ignoreWidth: false,
        ignoreHeight: false,
        ignoreFonts: false,
        breakPages: true,
      }).catch((err: unknown) => {
        if (!cancelled) {
          console.warn('[FileDiffViewer] docx-preview render failed:', err)
        }
      })
    })

    return () => {
      cancelled = true
      container.innerHTML = ''
    }
  }, [docxBlob])

  useEffect(() => {
    if (!lightbox) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLightbox(null)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [lightbox])

  useEffect(() => {
    if (!isSnapshotMode || !fileChange || !isImageFile(fileChange.path)) {
      setSnapshotImageUrls({ before: null, after: null })
      return
    }

    const beforeBlob = snapshotDiff?.beforeBinary
      ? new Blob([snapshotDiff.beforeBinary], { type: getImageMimeType(fileChange.path) })
      : null
    const afterBlob = snapshotDiff?.afterBinary
      ? new Blob([snapshotDiff.afterBinary], { type: getImageMimeType(fileChange.path) })
      : null
    const beforeUrl = beforeBlob ? URL.createObjectURL(beforeBlob) : null
    const afterUrl = afterBlob ? URL.createObjectURL(afterBlob) : null
    setSnapshotImageUrls({ before: beforeUrl, after: afterUrl })

    return () => {
      if (beforeUrl) URL.revokeObjectURL(beforeUrl)
      if (afterUrl) URL.revokeObjectURL(afterUrl)
    }
  }, [isSnapshotMode, snapshotDiff, fileChange])


  if (!fileChange) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 py-12 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted dark:bg-muted">
          <svg className="h-8 w-8 text-tertiary dark:text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h2l3 3H7a2 2 0 01-2 2z"
            />
          </svg>
        </div>
        <h3 className="mb-2 text-lg font-medium text-secondary dark:text-foreground">{t('sidebar.fileDiffViewer.selectFile')}</h3>
        <p className="max-w-sm text-sm text-tertiary dark:text-muted">{t('sidebar.fileDiffViewer.selectFileHint')}</p>
      </div>
    )
  }

  if (content.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary-500 border-t-transparent" />
          <p className="text-sm text-tertiary dark:text-muted">{t('sidebar.fileDiffViewer.loadingFile')}</p>
        </div>
      </div>
    )
  }

  if (content.error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-950/30">
            <svg className="h-6 w-6 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <h3 className="mb-2 text-lg font-medium text-secondary dark:text-foreground">{t('sidebar.fileDiffViewer.loadFailed')}</h3>
          <p className="text-sm text-tertiary dark:text-muted">{content.error}</p>
        </div>
      </div>
    )
  }

  const isImage = !isSnapshotMode && isImageFile(fileChange.path)
  const isDocx = !isSnapshotMode && isDocxFile(fileChange.path) && fileChange.type !== 'delete'
  const isOffice = !isSnapshotMode && isOfficeFile(fileChange.path) && fileChange.type !== 'delete'
  const formatUI = !isSnapshotMode ? getFormatUIHandler(fileChange.path) : null
  const isFormat = !!formatUI && fileChange.type !== 'delete'
  const originalText = content.showNativePanel ? (content.native ?? '') : ''
  const modifiedText = content.opfs ?? ''

  const addComment = () => {
    if (!composer || !fileChange) return
    const text = composer.text.trim()
    if (!text) return

    const comment: LineComment = {
      id: `${fileChange.path}:${composer.side}:${composer.startLine}-${composer.endLine}:${Date.now()}`,
      path: fileChange.path,
      side: composer.side,
      startLine: composer.startLine,
      endLine: composer.endLine,
      text,
      createdAt: Date.now(),
    }

    setCommentsByPath((prev) => ({
      ...prev,
      [activePath]: [...(prev[activePath] ?? []), comment],
    }))
    setComposer(null)
  }

  const removeComment = (id: string) => {
    if (!activePath) return
    setCommentsByPath((prev) => ({
      ...prev,
      [activePath]: (prev[activePath] ?? []).filter((item: LineComment) => item.id !== id),
    }))
  }

  

  const renderTextDiff = () => {
    if (hasBinarySnapshot) {
      if (isImageFile(fileChange.path) && (snapshotImageUrls.before || snapshotImageUrls.after)) {
        return (
          <div className="flex h-full">
            <div className="flex flex-1 flex-col border-r border-subtle">
              <div className="border-b border-subtle bg-muted px-4 py-2 text-sm text-secondary">{t('sidebar.fileDiffViewer.beforeSnapshotLabel')}</div>
              <div className="flex flex-1 items-center justify-center bg-card p-4">
                {snapshotImageUrls.before ? (
                  <img
                    src={snapshotImageUrls.before}
                    alt={`${t('sidebar.fileDiffViewer.beforeSnapshotLabel')}: ${fileChange.path}`}
                    className="max-h-full max-w-full rounded border border-subtle object-contain"
                  />
                ) : (
                  <span className="text-sm text-secondary">{t('sidebar.fileDiffViewer.noImageContent')}</span>
                )}
              </div>
            </div>
            <div className="flex flex-1 flex-col">
              <div className="border-b border-subtle bg-muted px-4 py-2 text-sm text-secondary">{t('sidebar.fileDiffViewer.afterSnapshotLabel')}</div>
              <div className="flex flex-1 items-center justify-center bg-card p-4">
                {snapshotImageUrls.after ? (
                  <img
                    src={snapshotImageUrls.after}
                    alt={`${t('sidebar.fileDiffViewer.afterSnapshotLabel')}: ${fileChange.path}`}
                    className="max-h-full max-w-full rounded border border-subtle object-contain"
                  />
                ) : (
                  <span className="text-sm text-secondary">{t('sidebar.fileDiffViewer.noImageContent')}</span>
                )}
              </div>
            </div>
          </div>
        )
      }

      return (
        <div className="flex h-full items-center justify-center p-6">
          <div className="w-full max-w-2xl rounded-lg border border-subtle bg-background p-4">
            <h4 className="text-sm font-semibold text-primary mb-3">{t('sidebar.fileDiffViewer.binarySnapshot')}</h4>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded border border-subtle bg-elevated p-3">
                <div className="text-xs text-secondary">{t('sidebar.fileDiffViewer.beforeSnapshotLabel')}</div>
                <div className="mt-1 text-sm text-primary">
                  {t('sidebar.fileDiffViewer.binary')}: {snapshotDiff?.beforeKind === 'binary' ? t('sidebar.fileDiffViewer.binary') : snapshotDiff?.beforeKind === 'text' ? t('sidebar.fileDiffViewer.text') : t('sidebar.fileDiffViewer.none')}
                </div>
                <div className="text-sm text-primary">{t('sidebar.fileDiffViewer.size')}: {formatSize(snapshotDiff?.beforeSize)}</div>
              </div>
              <div className="rounded border border-subtle bg-elevated p-3">
                <div className="text-xs text-secondary">{t('sidebar.fileDiffViewer.afterSnapshotLabel')}</div>
                <div className="mt-1 text-sm text-primary">
                  {t('sidebar.fileDiffViewer.binary')}: {snapshotDiff?.afterKind === 'binary' ? t('sidebar.fileDiffViewer.binary') : snapshotDiff?.afterKind === 'text' ? t('sidebar.fileDiffViewer.text') : t('sidebar.fileDiffViewer.none')}
                </div>
                <div className="text-sm text-primary">{t('sidebar.fileDiffViewer.size')}: {formatSize(snapshotDiff?.afterSize)}</div>
              </div>
            </div>
            <p className="mt-3 text-xs text-secondary">{t('sidebar.fileDiffViewer.binaryContent')}</p>
          </div>
        </div>
      )
    }

    if (content.opfs === null && fileChange.type === 'modify') {
      // Changed-version body unreadable. Diffing the full disk text against an
      // empty string renders EVERY line as a deletion — actively misleading
      // (looks like the agent wants to wipe the file). Never silently diff
      // against a missing side; hide the diff and say so.
      return (
        <div className="flex h-full flex-col">
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
            {t('sidebar.fileDiffViewer.changedVersionBodyUnavailable')}
          </div>
          <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-tertiary dark:text-muted">
            {t('sidebar.fileDiffViewer.cannotReadChangedVersion')}
          </div>
        </div>
      )
    }

    if (!content.showNativePanel && content.opfs === null) {
      if (fileChange.type === 'add') {
        // New-file change whose body could not be loaded. This is NOT an
        // error state — the change itself is still valid and syncs normally;
        // only the preview body is missing. Say that instead of the generic
        // unreadable-content message.
        return (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm text-secondary dark:text-foreground">{t('sidebar.fileDiffViewer.addPreviewUnavailable')}</p>
            <p className="max-w-md text-xs text-tertiary dark:text-muted">{t('sidebar.fileDiffViewer.addPreviewUnavailableHint')}</p>
          </div>
        )
      }
      return (
        <div className="flex h-full items-center justify-center text-sm text-tertiary dark:text-muted">
          {t('sidebar.fileDiffViewer.cannotReadChangedVersion')}
        </div>
      )
    }

    // Default: use LazyDiffViewer (only shows changed hunks)
    // Switch to Monaco full editor when user clicks the button
    if (!useFullEditor) {
      return (
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-tertiary dark:text-muted">
                  {t('sidebar.fileDiffViewer.loadingFile')}
                </div>
              }
            >
              <LazyDiffViewer
                original={originalText}
                modified={modifiedText}
                path={fileChange.path}
                isSplitView={isSplitView}
                onToggleSplitView={() => setIsSplitView((v) => !v)}
                onSwitchToMonaco={() => setUseFullEditor(true)}
                comments={currentFileComments.map((item) => ({
                  side: item.side,
                  startLine: item.startLine,
                  endLine: item.endLine,
                }))}
                selectedTarget={composer ? {
                  side: composer.side,
                  startLine: composer.startLine,
                  endLine: composer.endLine,
                } : null}
                onLineSelectForComment={(target) => {
                  setComposer((prev) => ({
                    side: target.side,
                    startLine: target.startLine,
                    endLine: target.endLine,
                    text: prev && prev.side === target.side ? prev.text : '',
                  }))
                }}
              />
            </Suspense>
          </div>

          {composer && (
            <div className="shrink-0 border-t border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-850">
              <div className="flex items-center gap-2 px-3 py-1.5">
                <span className="shrink-0 text-[11px] font-medium text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
                  {composer.side === 'modified' ? t('sidebar.fileDiffViewer.modified') : t('sidebar.fileDiffViewer.current')}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-neutral-300 text-neutral-600 text-neutral-600 dark:text-neutral-600">
                  L{composer.startLine}{composer.startLine !== composer.endLine && `-${composer.endLine}`}
                </span>
                <div className="flex-1" />
                <kbd className="shrink-0 rounded border border-neutral-200 px-1 text-[10px] text-neutral-400 dark:border-neutral-600 text-neutral-500 text-neutral-500 dark:text-neutral-500">⌘↵</kbd>
                <button
                  type="button"
                  onClick={() => setComposer(null)}
                  className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-600 text-neutral-500 text-neutral-500 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-300"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex items-start gap-2 px-3 pb-2.5">
                <textarea
                  className="min-h-[48px] flex-1 resize-none rounded border border-neutral-200 bg-white px-2.5 py-1.5 text-[13px] leading-snug text-neutral-800 outline-none focus:border-neutral-400 dark:border-neutral-600 dark:bg-neutral-800 dark:text-foreground dark:focus:border-neutral-500"
                  placeholder={t('sidebar.fileDiffViewer.addComment')}
                  autoFocus
                  rows={2}
                  value={composer.text}
                  onChange={(e) => setComposer((prev) => (prev ? { ...prev, text: e.target.value } : prev))}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setComposer(null)
                    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault()
                      addComment()
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={addComment}
                  disabled={!composer.text.trim()}
                  className="mt-0.5 flex h-8 items-center rounded-md bg-neutral-900 px-3 text-[12px] font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-30 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
                >
                  {t('sidebar.fileDiffViewer.send')}
                </button>
              </div>
            </div>
          )}
        </div>
      )
    }

    // Full Monaco editor
    return (
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-tertiary dark:text-muted">
                {t('sidebar.fileDiffViewer.loadingMonaco')}
              </div>
            }
          >
            <MonacoDiffEditor
              original={originalText}
              modified={modifiedText}
              path={fileChange.path}
              renderSideBySide={isSplitView}
              comments={currentFileComments.map((item) => ({
                side: item.side,
                startLine: item.startLine,
                endLine: item.endLine,
              }))}
              selectedTarget={composer ? {
                side: composer.side,
                startLine: composer.startLine,
                endLine: composer.endLine,
              } : null}
              onLineSelectForComment={(target) => {
                setComposer((prev) => ({
                  side: target.side,
                  startLine: target.startLine,
                  endLine: target.endLine,
                  text: prev && prev.side === target.side ? prev.text : '',
                }))
              }}
            />
          </Suspense>
        </div>

        {composer && (
          <div className="shrink-0 border-t border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-850">
            <div className="flex items-center gap-2 px-3 py-1.5">
              <span className="shrink-0 text-[11px] font-medium text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
                {composer.side === 'modified' ? t('sidebar.fileDiffViewer.modified') : t('sidebar.fileDiffViewer.current')}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-neutral-300 text-neutral-600 text-neutral-600 dark:text-neutral-600">
                L{composer.startLine}{composer.startLine !== composer.endLine && `-${composer.endLine}`}
              </span>
              <div className="flex-1" />
              <kbd className="shrink-0 rounded border border-neutral-200 px-1 text-[10px] text-neutral-400 dark:border-neutral-600 text-neutral-500 text-neutral-500 dark:text-neutral-500">⌘↵</kbd>
              <button
                type="button"
                onClick={() => setComposer(null)}
                className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-600 text-neutral-500 text-neutral-500 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-300"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex items-start gap-2 px-3 pb-2.5">
              <textarea
                className="min-h-[48px] flex-1 resize-none rounded border border-neutral-200 bg-white px-2.5 py-1.5 text-[13px] leading-snug text-neutral-800 outline-none focus:border-neutral-400 dark:border-neutral-600 dark:bg-neutral-800 dark:text-foreground dark:focus:border-neutral-500"
                placeholder={t('sidebar.fileDiffViewer.addComment')}
                autoFocus
                rows={2}
                value={composer.text}
                onChange={(e) => setComposer((prev) => (prev ? { ...prev, text: e.target.value } : prev))}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setComposer(null)
                  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    addComment()
                  }
                }}
              />
              <button
                type="button"
                onClick={addComment}
                disabled={!composer.text.trim()}
                className="mt-0.5 flex h-8 items-center rounded-md bg-neutral-900 px-3 text-[12px] font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-30 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
              >
                {t('sidebar.fileDiffViewer.send')}
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Compact header bar */}
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-neutral-200 bg-neutral-50/80 px-3 dark:border-neutral-800 dark:bg-neutral-900/80">
        {/* Left: change indicator + file path */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className={`shrink-0 rounded-sm px-1.5 py-px text-[11px] font-semibold uppercase tracking-wider ${
            fileChange.type === 'add' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
            : fileChange.type === 'delete' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400'
            : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400'
          }`}>
            {fileChange.type === 'add' ? 'A' : fileChange.type === 'delete' ? 'D' : 'M'}
          </span>
          <span className="min-w-0 truncate font-mono text-[13px] text-neutral-700 text-neutral-300 text-neutral-300 dark:text-neutral-300" title={fileChange.path}>
            {fileChange.path}
          </span>
          {/* Copy file path button */}
          <button
            type="button"
            title={t('settings.pendingSyncPanel.copyPath')}
            onClick={() => {
              navigator.clipboard.writeText(fileChange.path).then(() => {
                setCopiedPath(true)
                setTimeout(() => setCopiedPath(false), 1500)
              })
            }}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-200/60 hover:text-neutral-600 text-neutral-500 text-neutral-500 dark:text-neutral-500 dark:hover:bg-neutral-700/60 dark:hover:text-neutral-300"
          >
            {copiedPath ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
          </button>
          {/* Copy file content button - only for text files */}
          {fileChange.type !== 'delete' && getFileContentType(fileChange.path) === 'text' && (
            <button
              type="button"
              title={t('settings.pendingSyncPanel.copyContent')}
              onClick={() => {
                const textContent = content.opfs
                if (textContent) {
                  navigator.clipboard.writeText(textContent).then(() => {
                    setCopiedContent(true)
                    setTimeout(() => setCopiedContent(false), 1500)
                  })
                }
              }}
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-200/60 hover:text-neutral-600 text-neutral-500 text-neutral-500 dark:text-neutral-500 dark:hover:bg-neutral-700/60 dark:hover:text-neutral-300"
            >
              {copiedContent ? <Check className="h-3 w-3 text-emerald-500" /> : <ClipboardCopy className="h-3 w-3" />}
            </button>
          )}
          {fileChange.size ? (
            <span className="shrink-0 text-xs tabular-nums text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
              {(fileChange.size / 1024).toFixed(1)}k
            </span>
          ) : null}
          {currentFileComments.length > 0 && (
            <span className="shrink-0 text-[11px] tabular-nums text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
              {t('sidebar.fileDiffViewer.commentsCount', { count: currentFileComments.length })}
            </span>
          )}
        </div>

        {/* Right: actions */}
        <div className="flex shrink-0 items-center gap-1">
          {/* Download file button */}
          {!isSnapshotMode && fileChange.type !== 'delete' && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => downloadFile(fileChange.path)}
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-200/60 hover:text-neutral-700 text-neutral-400 text-neutral-400 dark:text-neutral-400 dark:hover:bg-neutral-700/60 dark:hover:text-neutral-300"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t('sidebar.fileDiffViewer.download') ?? 'Download file'}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {isSnapshotMode && (
            <span className="text-[11px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
              {snapshotDiff?.snapshotTitle || t('sidebar.fileDiffViewer.binarySnapshot')} · {formatTime(snapshotDiff?.capturedAt)}
            </span>
          )}
          {/* Format view mode toggle: driven by format-registry */}
          {isFormat && formatBlob && formatUI && formatUI.viewModes.length > 1 && (() => {
            const targetMode = formatUI.viewModes.find(m => m.id !== formatViewMode)
            if (!targetMode) return null
            const targetLabel = targetMode.labelKey ? t(targetMode.labelKey) : targetMode.label
            const isTargetText = targetMode.id === 'text'
            return (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        const modes = formatUI.viewModes
                        const currentIdx = modes.findIndex(m => m.id === formatViewMode)
                        const nextIdx = (currentIdx + 1) % modes.length
                        setFormatViewMode(modes[nextIdx].id)
                      }}
                      className={`inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] transition-colors ${
                        isTargetText
                          ? 'bg-purple-100/80 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
                          : 'text-purple-600 hover:bg-purple-100/60 hover:text-purple-700 dark:text-purple-400 dark:hover:bg-purple-900/30 dark:hover:text-purple-300'
                      }`}
                    >
                      <Eye className="h-3 w-3" />
                      {targetLabel}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {isTargetText ? t('sidebar.fileDiffViewer.switchToText') : t('sidebar.fileDiffViewer.switchToPreview')}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )
          })()}
          {!isImage && !isOffice && !isDocx && !(isFormat && formatViewMode !== 'text') && (
            <>
              {/* Switch between Lazy and Full editor */}
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setUseFullEditor((v) => !v)}
                      className={`inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] transition-colors ${
                        useFullEditor
                          ? 'text-blue-600 hover:bg-blue-100/60 hover:text-blue-700 dark:text-blue-400 dark:hover:bg-blue-900/30 dark:hover:text-blue-300'
                          : 'text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-700 text-neutral-400 text-neutral-400 dark:text-neutral-400 dark:hover:bg-neutral-700/60 dark:hover:text-neutral-300'
                      }`}
                    >
                      <FileText className="h-3 w-3" />
                      {useFullEditor ? t('sidebar.fileDiffViewer.changesOnly') : t('sidebar.fileDiffViewer.fullEditor')}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {useFullEditor ? t('sidebar.fileDiffViewer.switchToChangesOnly') : t('sidebar.fileDiffViewer.switchToFullEditor')}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {/* Split/Merge view toggle */}
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setIsSplitView((v) => !v)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-200/60 hover:text-neutral-700 text-neutral-400 text-neutral-400 dark:text-neutral-400 dark:hover:bg-neutral-700/60 dark:hover:text-neutral-300"
                    >
                      {isSplitView ? <UnfoldVertical className="h-3.5 w-3.5" /> : <Columns2 className="h-3.5 w-3.5" />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{isSplitView ? t('sidebar.fileDiffViewer.mergeView') : t('sidebar.fileDiffViewer.splitView')}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </>
          )}
          

        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {isImage ? (
          <>
            <div className={`flex flex-1 flex-col ${content.showNativePanel ? 'border-r border dark:border-border' : ''}`}>
              <div className="border-b border bg-muted px-4 py-2 dark:border-border dark:bg-muted">
                <h4 className="text-sm font-medium text-secondary dark:text-muted">
                  {content.showNativePanel ? (isSnapshotMode ? t('sidebar.fileDiffViewer.beforeSnapshotLabel') : t('sidebar.fileDiffViewer.currentFile')) : (isSnapshotMode ? t('sidebar.fileDiffViewer.afterSnapshotLabel') : t('sidebar.fileDiffViewer.changedVersion'))}
                  {!content.showNativePanel && fileChange.type === 'delete' && (
                    <span className="ml-2 text-xs text-red-600">{t('sidebar.fileDiffViewer.deleteWarning')}</span>
                  )}
                </h4>
              </div>
              <div className="flex flex-1 items-center justify-center overflow-auto bg-card p-4 dark:bg-card">
                {(content.showNativePanel ? content.nativeImageUrl : content.opfsImageUrl) ? (
                  <button
                    type="button"
                    onClick={() =>
                      setLightbox({
                        src: (content.showNativePanel ? content.nativeImageUrl : content.opfsImageUrl)!,
                        title: content.showNativePanel
                          ? `${isSnapshotMode ? t('sidebar.fileDiffViewer.beforeSnapshotLabel') : t('sidebar.fileDiffViewer.currentFile')} - ${fileChange.path}`
                          : `${isSnapshotMode ? t('sidebar.fileDiffViewer.afterSnapshotLabel') : t('sidebar.fileDiffViewer.changedVersion')} - ${fileChange.path}`,
                      })
                    }
                    className="flex h-full w-full items-center justify-center"
                  >
                    <img
                      src={(content.showNativePanel ? content.nativeImageUrl : content.opfsImageUrl)!}
                      alt={content.showNativePanel
                        ? `${isSnapshotMode ? t('sidebar.fileDiffViewer.beforeSnapshotLabel') : t('sidebar.fileDiffViewer.currentFile')}: ${fileChange.path}`
                        : `${isSnapshotMode ? t('sidebar.fileDiffViewer.afterSnapshotLabel') : t('sidebar.fileDiffViewer.changedVersion')}: ${fileChange.path}`}
                      className="max-h-full max-w-full rounded border border dark:border-border object-contain"
                      loading="lazy"
                    />
                  </button>
                ) : (
                  <div className="text-sm text-tertiary dark:text-muted">
                    {content.showNativePanel
                      ? t('sidebar.fileDiffViewer.cannotReadNativeImage')
                      : fileChange.type === 'delete'
                        ? t('sidebar.fileDiffViewer.imageWillBeDeleted')
                        : t('sidebar.fileDiffViewer.cannotReadChangedImage')}
                  </div>
                )}
              </div>
            </div>

            {content.showNativePanel && (
              <div className="flex flex-1 flex-col">
                <div className="border-b border bg-muted px-4 py-2 dark:border-border dark:bg-muted">
                  <h4 className="text-sm font-medium text-secondary dark:text-muted">
                    {isSnapshotMode ? t('sidebar.fileDiffViewer.afterSnapshotLabel') : t('sidebar.fileDiffViewer.changedVersion')}
                    {fileChange.type === 'delete' && <span className="ml-2 text-xs text-red-600">{t('sidebar.fileDiffViewer.deleteWarning')}</span>}
                  </h4>
                </div>
                <div className="flex flex-1 items-center justify-center overflow-auto bg-card p-4 dark:bg-card">
                  {content.opfsImageUrl ? (
                    <button
                      type="button"
                      onClick={() =>
                        setLightbox({
                          src: content.opfsImageUrl!,
                          title: `${t('sidebar.fileDiffViewer.changedVersion')} - ${fileChange.path}`,
                        })
                      }
                      className="flex h-full w-full items-center justify-center"
                    >
                      <img
                        src={content.opfsImageUrl}
                        alt={`${t('sidebar.fileDiffViewer.changedVersion')}: ${fileChange.path}`}
                        className="max-h-full max-w-full rounded border border dark:border-border object-contain"
                        loading="lazy"
                      />
                    </button>
                  ) : (
                    <div className="text-sm text-tertiary dark:text-muted">
                      {fileChange.type === 'delete' ? t('sidebar.fileDiffViewer.imageWillBeDeleted') : t('sidebar.fileDiffViewer.cannotReadChangedImage')}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        ) : isDocx && docxBlob ? (
          <div className="flex-1 overflow-auto bg-white dark:bg-neutral-950">
            <div ref={docxContainerRef} className="docx-preview-container h-full" />
          </div>
        ) : isOffice && officeBlob ? (
          <div className="flex-1 overflow-hidden bg-card dark:bg-card">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-tertiary dark:text-muted">
                  {t('officePreview.loadingEditor')}
                </div>
              }
            >
              <OfficePreview blob={officeBlob} fileName={fileChange.path.split('/').pop() ?? fileChange.path} fileSize={fileChange.size ?? officeBlob.size} />
            </Suspense>
          </div>
        ) : isFormat && formatBlob && formatViewMode !== 'text' && formatUI?.PreviewComponent ? (
          <div className="flex-1 overflow-hidden bg-card dark:bg-card">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-tertiary dark:text-muted">
                  Loading preview...
                </div>
              }
            >
              <formatUI.PreviewComponent blob={formatBlob} fileName={fileChange.path.split('/').pop() ?? fileChange.path} fileSize={fileChange.size ?? formatBlob.size} />
            </Suspense>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden bg-card dark:bg-card">{renderTextDiff()}</div>
        )}
      </div>

      {currentFileComments.length > 0 && (
        <div className="border-t bg-elevated px-4 py-2">
          <div className="text-xs text-secondary mb-1">{t('sidebar.fileDiffViewer.currentFileComments')}</div>
          <div className="flex flex-wrap gap-2">
            {currentFileComments.map((item) => (
              <div key={item.id} className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1 text-xs">
                <span className="font-medium">
                  {item.side === 'modified' ? t('sidebar.fileDiffViewer.modified') : t('sidebar.fileDiffViewer.current')}{' '}
                  {item.startLine === item.endLine ? `L${item.startLine}` : `L${item.startLine}-L${item.endLine}`}
                </span>
                <span className="max-w-[360px] truncate" title={item.text}>{item.text}</span>
                <button className="text-tertiary hover:text-destructive" onClick={() => removeComment(item.id)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {lightbox && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/80" onClick={() => setLightbox(null)} role="presentation">
          <div className="flex items-center justify-between bg-black/40 px-4 py-3 text-white">
            <div className="truncate pr-3 text-sm">{lightbox.title}</div>
            <button
              type="button"
              onClick={() => setLightbox(null)}
              className="rounded-md border border-white/30 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-card/10"
            >
              {t('sidebar.fileDiffViewer.close')}
            </button>
          </div>
          <div className="flex flex-1 items-center justify-center p-6" onClick={(e) => e.stopPropagation()}>
            <img src={lightbox.src} alt={lightbox.title} className="max-h-full max-w-full object-contain" />
          </div>
        </div>
      )}
    </div>
  )
}
