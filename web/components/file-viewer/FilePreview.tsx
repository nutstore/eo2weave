/**
 * FilePreview - file content display with Monaco Editor.
 * Supports text files with syntax highlighting and images with direct display.
 *
 * Edit mode (toggleable):
 * - Switch to edit mode to directly modify file content
 * - Save with ⌘S or the save button
 * - Unsaved changes are tracked and warned on file switch / close
 *
 * Comment feature (preview mode only):
 * - Click line numbers to start a single-line comment
 * - Shift+Click line numbers for multi-line selection
 * - Send comments to AI conversation
 */

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react'
import { X, FileText, Copy, Check, Eye, Code, MessageSquare, Send, Trash2, Download, ExternalLink, Pencil, Save, Circle, PanelRightClose, Maximize2, RefreshCw } from 'lucide-react'
import { Editor, loader, type OnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import type { editor as MonacoEditor } from 'monaco-editor'
import { formatBytes } from '@/lib/utils'
import { useT } from '@/i18n'
import { useWorkspacePreferencesStore } from '@/store/workspace-preferences.store'
import { useConversationStore } from '@/store/conversation.store'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'
import { useAgentStore } from '@/store/agent.store'
import { useSettingsStore } from '@/store/settings.store'
import { createUserMessage } from '@/agent/message-types'
import type { ConversationStatus } from '@/agent/message-types'
import { toast } from 'sonner'
import { OfficePreview, OFFICE_EXTS, getEo2EditorUrl } from './OfficePreview'
import '@/agent/tools/formats'
import { getFormatUIHandler } from '@/agent/tools/format-registry'
import '@/lib/monaco-setup'

// Configure Monaco loader to use the locally bundled monaco-editor package
// instead of loading from CDN. Without this, the Editor component will try
// to fetch Monaco from jsdelivr CDN on first render, which may hang forever
// in offline or network-restricted environments.
let _loaderConfigured = false
if (!_loaderConfigured) {
  loader.config({ monaco })
  _loaderConfigured = true
}

// ── Comment Types ──────────────────────────────────────────────────────────

interface LineComment {
  id: string
  path: string
  startLine: number
  endLine: number
  text: string
  createdAt: number
  /** Optional selected text snippet (for text-selection-based comments) */
  selectedText?: string
  /** Optional column range for precise text selection */
  startColumn?: number
  endColumn?: number
}

interface ComposerState {
  startLine: number
  endLine: number
  text: string
  /** Optional selected text snippet (for text-selection-based comments) */
  selectedText?: string
  /** Optional column range for precise text selection */
  startColumn?: number
  endColumn?: number
}

// ── FilePreview Props ──────────────────────────────────────────────────────

interface FilePreviewProps {
  filePath: string | null
  fileHandle: FileSystemFileHandle | null
  onClose: () => void
  /** Pre-loaded Blob to display (e.g. from OPFS assets/). When provided, skips OPFS/disk read. */
  blob?: Blob | null
}

/** Get Monaco language ID from file path */
function getMonacoLanguage(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.ts')) return 'typescript'
  if (lower.endsWith('.tsx')) return 'typescript'
  if (lower.endsWith('.js')) return 'javascript'
  if (lower.endsWith('.jsx')) return 'javascript'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.html')) return 'html'
  if (lower.endsWith('.css')) return 'css'
  if (lower.endsWith('.scss')) return 'scss'
  if (lower.endsWith('.md')) return 'markdown'
  if (lower.endsWith('.py')) return 'python'
  if (lower.endsWith('.go')) return 'go'
  if (lower.endsWith('.rs')) return 'rust'
  if (lower.endsWith('.java')) return 'java'
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml'
  if (lower.endsWith('.csv')) return 'plaintext'
  if (lower.endsWith('.xml')) return 'xml'
  if (lower.endsWith('.sql')) return 'sql'
  if (lower.endsWith('.sh')) return 'shell'
  if (lower.endsWith('.bash')) return 'shell'
  if (lower.endsWith('.zsh')) return 'shell'
  if (lower.endsWith('.dockerfile')) return 'dockerfile'
  if (lower.endsWith('.vue')) return 'html'
  if (lower.endsWith('.php')) return 'php'
  if (lower.endsWith('.rb')) return 'ruby'
  if (lower.endsWith('.swift')) return 'swift'
  if (lower.endsWith('.kt')) return 'kotlin'
  if (lower.endsWith('.c')) return 'c'
  if (lower.endsWith('.cpp') || lower.endsWith('.hpp')) return 'cpp'
  if (lower.endsWith('.h')) return 'c'
  return 'plaintext'
}

/** Image extensions — handled by format registry (image/ directory).
 * Kept for reference but removed from direct-render path so that
 * enhanced ImagePreview (zoom, pan, rotate) is used instead. */
// const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg'])

/** Binary (non-image, non-office) extensions */
const BINARY_EXTS = new Set([
  'wasm', 'zip', 'gz', 'tar', 'br', 'zst',
  'mp3', 'mp4', 'webm', 'ogg', 'wav', 'avi', 'woff', 'woff2', 'ttf', 'eot', 'otf',
  'exe', 'dll', 'so', 'dylib',
])

/** Text extensions */
const TEXT_EXTS = new Set([
  'txt', 'md', 'mdx', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'env',
  'xml', 'svg', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  'py', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp',
  'sh', 'bash', 'zsh', 'sql', 'graphql', 'gql', 'php', 'rb', 'vue', 'svelte',
  'lock', 'gitignore', 'editorconfig', 'dockerfile', 'makefile',
])

function getFileType(path: string): 'text' | 'image' | 'binary' | 'office' | 'format' {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  // Images are now handled by format registry (image/ directory)
  // which provides an enhanced preview with zoom/pan/rotate.
  // HTML is also handled by format registry (html/ directory).
  if (OFFICE_EXTS.has(ext)) return 'office'
  // Check format registry (e.g. .nol, .pdf, .docx, .png, .jpg, .html, etc.)
  if (getFormatUIHandler(path)) return 'format'
  if (TEXT_EXTS.has(ext)) return 'text'
  if (BINARY_EXTS.has(ext)) return 'binary'
  // Unknown extension - try text
  return 'text'
}

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

/** Trigger browser download via a temporary <a> element */
function triggerDownload(url: string, fileName: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Do NOT revoke — url may be a long-lived blob URL (e.g. imageUrl)
}

/** Shape of WorkspaceRuntime.readFile / opfs.store.readFile results */
interface WorkspaceReadResult {
  content: unknown
  metadata: { mtime?: number | null }
}

/**
 * Normalize a workspace read result into FilePreview's text/blob state.
 * Shared by the opfs.store read and the project-runtime fallback so both
 * paths distribute content identically (Blob vs string vs ArrayBuffer).
 */
function applyReadResult(
  result: WorkspaceReadResult,
  fileType: 'text' | 'image' | 'binary' | 'office' | 'format'
): { text?: string; blob?: Blob; fSize: number; mtime: number | null } {
  const mtime = result.metadata.mtime || null
  if (result.content instanceof Blob) {
    return { blob: result.content, fSize: result.content.size, mtime }
  }
  if (typeof result.content === 'string') {
    return { text: result.content, fSize: new Blob([result.content]).size, mtime }
  }
  // ArrayBuffer - for image/office/format, keep as Blob; for text, decode it
  const buffer = result.content as ArrayBuffer
  if (fileType === 'image' || fileType === 'office' || fileType === 'format') {
    return { blob: new Blob([buffer]), fSize: buffer.byteLength, mtime }
  }
  return { text: new TextDecoder().decode(buffer), fSize: buffer.byteLength, mtime }
}

export function FilePreview({ filePath, fileHandle, onClose, blob: externalBlob }: FilePreviewProps) {
  const t = useT()
  const display = useWorkspacePreferencesStore((s) => s.display)
  const filePreviewMode = useWorkspacePreferencesStore((s) => s.filePreviewMode)
  const setFilePreviewMode = useWorkspacePreferencesStore((s) => s.setFilePreviewMode)
  const [content, setContent] = useState<string | null>(null)
  const [editMode, setEditMode] = useState(false)
  const [editedContent, setEditedContent] = useState('')
  const [originalForDiff, setOriginalForDiff] = useState('')
  const [saving, setSaving] = useState(false)
  const [fileSize, setFileSize] = useState<number>(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [diskNewer, setDiskNewer] = useState(false)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [officeBlob, setOfficeBlob] = useState<Blob | null>(null)
  // Generic format handler state (for .nol and future formats registered in format-registry)
  const [formatBlob, setFormatBlob] = useState<Blob | null>(null)
  const [formatTextContent, setFormatTextContent] = useState<string | null>(null)
  const [formatViewMode, setFormatViewMode] = useState<string>('preview')
  const [isDark, setIsDark] = useState(
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  )

  // ── Comment State ──────────────────────────────────────────────────────
  const [comments, setComments] = useState<LineComment[]>([])
  const [composer, setComposer] = useState<ComposerState | null>(null)
  // Multi-line selection: track anchor line (like LazyDiffViewer's Shift+Click)
  const anchorLineRef = useRef<number | null>(null)
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  // Monaco decorations for comment highlights
  const decorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null)
  // Mirror editMode for use inside Monaco mouse handlers (registered once on
  // mount). Avoids popping the comment composer when the user selects text
  // while editing the file.
  const editModeRef = useRef(false)
  useEffect(() => {
    editModeRef.current = editMode
  }, [editMode])

  const fileType = useMemo(() => (filePath ? getFileType(filePath) : 'text'), [filePath])
  const formatUI = useMemo(() => (filePath ? getFormatUIHandler(filePath) : null), [filePath])

  // Reset comments + edit state when file changes
  useEffect(() => {
    setComments([])
    setComposer(null)
    anchorLineRef.current = null
    setEditMode(false)
    setEditedContent('')
    setOriginalForDiff('')
  }, [filePath])

  // Track dark mode changes
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    const updateTheme = () => setIsDark(root.classList.contains('dark'))

    updateTheme()

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'class') {
          updateTheme()
          break
        }
      }
    })
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })

    return () => observer.disconnect()
  }, [])

  // ── Update Monaco decorations for comments & selection ─────────────────
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    const newDecorations: MonacoEditor.IModelDeltaDecoration[] = []

    // Highlight commented lines
    for (const comment of comments) {
      for (let line = comment.startLine; line <= comment.endLine; line++) {
        newDecorations.push({
          range: {
            startLineNumber: line,
            startColumn: 1,
            endLineNumber: line,
            endColumn: 1,
          },
          options: {
            isWholeLine: true,
            className: 'fp-commented-line',
            glyphMarginClassName: 'fp-commented-glyph',
            glyphMarginHoverMessage: { value: comment.text },
          },
        })
      }
    }

    // Highlight selected composer range
    if (composer) {
      if (composer.selectedText) {
        // Precise text selection highlight
        newDecorations.push({
          range: {
            startLineNumber: composer.startLine,
            startColumn: composer.startColumn ?? 1,
            endLineNumber: composer.endLine,
            endColumn: composer.endColumn ?? 1,
          },
          options: {
            className: 'fp-selected-text',
          },
        })
      } else {
        // Whole-line highlight (click on line number)
        for (let line = composer.startLine; line <= composer.endLine; line++) {
          newDecorations.push({
            range: {
              startLineNumber: line,
              startColumn: 1,
              endLineNumber: line,
              endColumn: 1,
            },
            options: {
              isWholeLine: true,
              className: 'fp-selected-line',
              glyphMarginClassName: 'fp-selected-glyph',
            },
          })
        }
      }
    }

    if (decorationsRef.current) {
      decorationsRef.current.clear()
    }
    decorationsRef.current = editor.createDecorationsCollection(newDecorations)
  }, [comments, composer])

  // ── Monaco Editor Mount Handler ────────────────────────────────────────
  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor

    // Enable glyph margin for comment indicators
    editor.updateOptions({ glyphMargin: true })

    // Click on line numbers or glyph margin to select lines for commenting
    editor.onMouseDown((e) => {
      // Only handle clicks on line numbers or glyph margin
      const target = e.target
      if (
        target.type !== 2 && // GUTTER_GLYPH_MARGIN
        target.type !== 3 && // GUTTER_LINE_NUMBERS
        target.type !== 4    // GUTTER_LINE_DECORATIONS
      ) {
        return
      }

      const lineNumber = target.position?.lineNumber
      if (!lineNumber) return

      const isShift = e.event.shiftKey

      if (isShift && anchorLineRef.current !== null) {
        // Shift+Click: extend selection from anchor
        const anchorLine = anchorLineRef.current
        const startLine = Math.min(anchorLine, lineNumber)
        const endLine = Math.max(anchorLine, lineNumber)
        setComposer((prev) => ({
          startLine,
          endLine,
          text: prev?.text ?? '',
        }))
      } else {
        // Normal click: single line selection
        anchorLineRef.current = lineNumber
        setComposer((prev) => ({
          startLine: lineNumber,
          endLine: lineNumber,
          text: prev?.text ?? '',
        }))
      }
    })

    // Text selection: when user finishes selecting text (mouse up),
    // open the comment composer immediately with the selected snippet.
    let suppressSelectionOnce = false
    // Track gutter clicks to suppress the text-selection path
    editor.onMouseDown((e) => {
      const target = e.target
      if (
        target.type === 2 || // GUTTER_GLYPH_MARGIN
        target.type === 3 || // GUTTER_LINE_NUMBERS
        target.type === 4    // GUTTER_LINE_DECORATIONS
      ) {
        suppressSelectionOnce = true
      }
    })

    editor.onMouseUp(() => {
      // Skip if this mouseup came from a gutter click
      if (suppressSelectionOnce) {
        suppressSelectionOnce = false
        return
      }
      // Skip in edit mode — text selection there is for editing, not commenting.
      if (editModeRef.current) return
      const selection = editor.getSelection()
      if (!selection || selection.isEmpty()) return

      const selectedText = editor.getModel()?.getValueInRange(selection) ?? ''
      // Ignore trivial selections (single char or whitespace-only) to avoid
      // popping the composer on accidental clicks / double-click-word when the
      // user just wanted to copy or focus.
      if (selectedText.trim().length < 2) return

      // Build composer with precise selection range + snippet
      setComposer((prev) => ({
        startLine: selection.startLineNumber,
        endLine: selection.endLineNumber,
        startColumn: selection.startColumn,
        endColumn: selection.endColumn,
        selectedText,
        text: prev?.text ?? '',
      }))
      anchorLineRef.current = null
    })
  }, [])

  // ── Comment Actions ────────────────────────────────────────────────────

  const addComment = useCallback(() => {
    if (!composer || !filePath) return
    const text = composer.text.trim()
    if (!text) return

    const comment: LineComment = {
      id: `${filePath}:${composer.startLine}-${composer.endLine}:${Date.now()}`,
      path: filePath,
      startLine: composer.startLine,
      endLine: composer.endLine,
      text,
      createdAt: Date.now(),
      ...(composer.selectedText ? { selectedText: composer.selectedText } : {}),
      ...(composer.startColumn ? { startColumn: composer.startColumn } : {}),
      ...(composer.endColumn ? { endColumn: composer.endColumn } : {}),
    }

    setComments((prev) => [...prev, comment])
    setComposer(null)
    anchorLineRef.current = null
  }, [composer, filePath])

  const removeComment = useCallback((id: string) => {
    setComments((prev) => prev.filter((c) => c.id !== id))
  }, [])

  const clearAllComments = useCallback(() => {
    setComments([])
    setComposer(null)
    anchorLineRef.current = null
  }, [])

  /** Send comments to AI conversation */
  const sendCommentsToAI = useCallback(async () => {
    if (comments.length === 0 || !filePath) return

    const payload = comments
      .map((item) => {
        const lineLabel = item.startLine === item.endLine
          ? `L${item.startLine}`
          : `L${item.startLine}-L${item.endLine}`
        // Include the selected text snippet if available for precise context
        const snippetPart = item.selectedText
          ? ` "${item.selectedText}"`
          : ''
        return `- ${item.path} [${lineLabel}]${snippetPart} ${item.text}`
      })
      .join('\n')

    const prompt = `Please review the following inline comments I left on the file:\n\n${payload}`

    const settings = useSettingsStore.getState()
    if (!settings.hasApiKey) {
      toast.error(t('conversation.toast.noApiKey'))
      return
    }

    // Close preview only in overlay mode; keep it open in split mode
    // so the user can continue watching the file alongside the conversation.
    if (filePreviewMode === 'overlay') {
      onClose()
    }

    // Ensure conversation exists
    const conversationStore = useConversationStore.getState()
    const { directoryHandle } = useAgentStore.getState()
    let targetConvId = conversationStore.activeConversationId
    if (!targetConvId) {
      const conv = conversationStore.createNew('File Comments Review')
      targetConvId = conv.id
      await conversationStore.setActive(targetConvId)
    }

    if (conversationStore.isConversationRunning(targetConvId)) {
      // Queue the message instead of rejecting
      const result = useConversationRuntimeStore.getState().enqueueMessage(targetConvId, {
        text: prompt,
        enqueuedAt: Date.now(),
      })
      if (result.enqueued) {
        setComments([])
        setComposer(null)
        anchorLineRef.current = null
      } else {
        toast.error(t('conversation.toast.queueFull'))
      }
      return
    }

    const userMessage = createUserMessage(prompt)
    const currentConv = conversationStore.conversations.find((c) => c.id === targetConvId)
    const currentMessages = currentConv ? [...currentConv.messages, userMessage] : [userMessage]
    conversationStore.updateMessages(targetConvId, currentMessages)

    // Clear comments after sending
    setComments([])
    setComposer(null)
    anchorLineRef.current = null

    await conversationStore.runAgent(
      targetConvId,
      settings.providerType,
      settings.modelName,
      settings.maxTokens,
      directoryHandle
    )
  }, [comments, filePath, t, onClose, filePreviewMode])

  // ── File loading logic ──────────────────────────────────────────────────
  // Ref to track the latest object URL for cleanup
  const objectUrlRef = useRef<string | null>(null)

  /**
   * Core file loader — reads from OPFS/disk/externalBlob and populates state.
   * Shared by: initial load effect, manual refresh button, and auto-refresh
   * after agent loop completes.
   *
   * @param silent When true (auto-refresh), skips clearing content state to avoid
   *               editor unmount/remount — instead replaces content in place and
   *               preserves scroll position. When false (initial load / file switch),
   *               fully resets state for a clean slate.
   */
  const loadFile = useCallback(async (path: string, silent = false) => {
    // For silent refresh, save scroll position to restore after content swap.
    // For non-silent loads, don't bother — it's a fresh file.
    let savedScroll: number | null = null
    if (silent && editorRef.current) {
      savedScroll = editorRef.current.getScrollTop()
    }

    if (!silent) {
      setLoading(true)
    }
    setError(null)
    if (!silent) {
      // Full reset for initial load / file switch
      setContent(null)
      setImageUrl(null)
      setOfficeBlob(null)
      setFormatBlob(null)
      setFormatTextContent(null)
      setFormatViewMode(formatUI?.viewModes.find((m) => m.default)?.id ?? 'preview')
      setDiskNewer(false)

      // Clean up previous object URL
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
    }

    try {
      let text: string | undefined
      let blob: Blob | undefined
      let fSize = 0
      let opfsMtime: number | null = null
      let diskMtime: number | null = null
      let opfsReadError: string | null = null

      // Fast path: external blob provided (e.g. from OPFS assets/)
      if (externalBlob) {
        fSize = externalBlob.size
        if (fileType === 'image' || fileType === 'office' || fileType === 'format') {
          blob = externalBlob
        } else {
          text = await externalBlob.text()
        }
      } else {
        try {
          const opfs = (await import('@/store/opfs.store')).useOPFSStore.getState()
          const result = await opfs.readFile(path)
          const applied = applyReadResult(result, fileType)
          text = applied.text
          blob = applied.blob
          fSize = applied.fSize
          opfsMtime = applied.mtime
        } catch (readErr) {
          // OPFS read failed. Keep the real cause visible: native-host roots
          // have no FileSystemFileHandle fallback, so swallowing this error
          // leaves the user with a generic "Cannot read file" and no clues.
          opfsReadError = readErr instanceof Error ? readErr.message : String(readErr)
          console.warn(`[FilePreview] readFile failed for "${path}":`, readErr)

          // Fallback: read through the active project's workspace runtime
          // directly. This covers two real failure modes the store wrapper
          // can't: (1) no active conversation workspace (welcome screen —
          // opfs.store throws "No active workspace" because activeWorkspaceId
          // is URL-driven and null before a conversation is opened); (2)
          // native-host roots where the OPFS files/ dir has no copy. The
          // runtime itself routes multi-root paths and native-host scopes,
          // so only the store-level workspace gate is bypassed here.
          try {
            const { getWorkspaceManager } = await import('@/opfs')
            const { useProjectStore } = await import('@/store/project.store')
            const manager = await getWorkspaceManager()
            const projectId = useProjectStore.getState().activeProjectId || null
            const wsMeta = projectId
              ? manager.getAllWorkspaces().find((w) => w.projectId === projectId)
              : manager.getAllWorkspaces()[0]
            const workspace = wsMeta ? await manager.getWorkspace(wsMeta.workspaceId) : undefined
            if (workspace) {
              const result = await workspace.readFile(path)
              const applied = applyReadResult(result, fileType)
              text = applied.text
              blob = applied.blob
              fSize = applied.fSize
              opfsMtime = applied.mtime
            }
          } catch (fallbackErr) {
            console.warn('[FilePreview] project-runtime fallback read failed:', fallbackErr)
          }
        }

        if (fileHandle) {
          try {
            const diskFile = await fileHandle.getFile()
            diskMtime = diskFile.lastModified

            if (opfsMtime !== null && diskMtime > opfsMtime) {
              fSize = diskFile.size
              if (fileType === 'image' || fileType === 'office' || fileType === 'format') {
                blob = diskFile
              } else {
                text = await diskFile.text()
              }
              setDiskNewer(true)
            } else if (opfsMtime === null) {
              fSize = diskFile.size
              if (fileType === 'image' || fileType === 'office' || fileType === 'format') {
                blob = diskFile
              } else {
                text = await diskFile.text()
              }
            }
          } catch {
            // Disk read failed, rely on OPFS if available
          }
        } else if (!text && !blob) {
          setError(
            opfsReadError
              ? `${t('filePreview.cannotReadFile')} (${opfsReadError})`
              : t('filePreview.cannotReadFile')
          )
          setLoading(false)
          return
        }
      } // end else (no externalBlob)

      if (!text && !blob) {
        setError(
          opfsReadError
            ? `${t('filePreview.cannotReadFile')} (${opfsReadError})`
            : t('filePreview.cannotReadFile')
        )
        setLoading(false)
        return
      }

      if (fSize > MAX_FILE_SIZE && fileType !== 'format') {
        setError(t('filePreview.fileTooLarge', { size: formatBytes(fSize), maxSize: formatBytes(MAX_FILE_SIZE) }))
        setLoading(false)
        return
      }

      setFileSize(fSize)

      if (fileType === 'image' && blob) {
        objectUrlRef.current = URL.createObjectURL(blob)
        setImageUrl(objectUrlRef.current)
      } else if (fileType === 'office' && blob) {
        setOfficeBlob(blob)
      } else if (fileType === 'format' && (blob || text !== undefined)) {
        // OPFS classifies HTML and other textual formats as strings. Normalize
        // them to a Blob so every registered format can use its PreviewComponent.
        const formatBlob = blob ?? new Blob([text!], { type: 'text/plain' })
        setFormatBlob(formatBlob)
        // Also render as text for text view mode
        if (formatUI?.renderTextContent) {
          try {
            const arrayBuffer = await formatBlob.arrayBuffer()
            const bytes = new Uint8Array(arrayBuffer)
            const renderedText = await formatUI.renderTextContent(bytes, path)
            setFormatTextContent(renderedText)
          } catch {
            /* ignore render error */
          }
        }
      } else if (text !== undefined) {
        setContent(text)
      }
    } catch (err) {
      setError(t('filePreview.readFileFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setLoading(false)
      // Restore scroll position after silent refresh (content was swapped in place)
      if (savedScroll != null && editorRef.current) {
        // Use rAF to ensure Monaco has laid out the new content
        requestAnimationFrame(() => {
          editorRef.current?.setScrollTop(savedScroll!)
        })
      }
    }
  }, [fileHandle, fileType, externalBlob, formatUI, t])

  // Load file content when filePath or fileHandle changes
  useEffect(() => {
    if (!filePath) {
      setContent(null)
      setImageUrl(null)
      setOfficeBlob(null)
      setFormatBlob(null)
      setFormatTextContent(null)
      setFormatViewMode(formatUI?.viewModes.find((m) => m.default)?.id ?? 'preview')
      setError(null)
      setDiskNewer(false)
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
      return
    }

    loadFile(filePath)
    // loadFile already depends on fileHandle/fileType/externalBlob/formatUI/t,
    // so we only need filePath + loadFile here. formatUI is included for the
    // cleanup branch above (which uses formatUI?.viewModes directly).
  }, [filePath, loadFile, formatUI])

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
      }
    }
  }, [])

  // ── Auto-refresh after agent loop completes ──────────────────────────────
  // When watching a file in split mode and the agent finishes a loop that may
  // have modified it, automatically reload to show the latest content.
  // Skip if user is in edit mode with unsaved changes (would discard their work).
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const convStatus = useConversationRuntimeStore((s) =>
    activeConversationId ? s.getConversationStatus(activeConversationId) : 'idle'
  )
  const prevStatusRef = useRef<ConversationStatus>('idle')

  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = convStatus
    // Edge: running/streaming → idle (loop just finished)
    if (prev !== 'idle' && prev !== 'error' && convStatus === 'idle' && filePath && !editMode) {
      loadFile(filePath, true)
    }
  }, [convStatus, filePath, editMode, loadFile])

  const handleCopy = useCallback(async () => {
    if (!content) return
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [content])

  /** Manual refresh — reload the current file from disk/OPFS */
  const handleRefresh = useCallback(() => {
    if (filePath) loadFile(filePath)
  }, [filePath, loadFile])

  const isDirty = editMode && editedContent !== originalForDiff

  const handleSave = useCallback(async () => {
    if (!filePath || !isDirty) return
    setSaving(true)
    try {
      const opfs = (await import('@/store/opfs.store')).useOPFSStore.getState()
      // Do NOT pass directoryHandle: writeFile resolves the correct per-root
      // native handle from the path's rootName prefix. Passing the global UI
      // handle skips root-prefix stripping in the directoryHandle branch, so
      // baselineFsMtime falls back to the OPFS mtime and detect_conflicts then
      // reports a false conflict (disk mtime != OPFS mtime).
      await opfs.writeFile(filePath, editedContent)
      setOriginalForDiff(editedContent)
      setContent(editedContent)
      toast.success(t('filePreview.saved'))
    } catch (err) {
      console.error('[FilePreview] Save failed:', err)
      toast.error(t('filePreview.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [filePath, isDirty, editedContent, t])

  // ⌘S / Ctrl+S to save while in edit mode
  useEffect(() => {
    if (!editMode) return
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        void handleSave()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [editMode, handleSave])

  // Warn on close if dirty
  const handleClose = useCallback(() => {
    if (isDirty) {
      if (!confirm(t('filePreview.unsavedOnClose'))) return
    }
    onClose()
  }, [isDirty, t, onClose])

  const handleDownload = useCallback(async () => {
    if (!filePath) return
    const name = filePath.split('/').pop() || 'file'

    try {
      // Prefer already-loaded blob data for binary types
      if (fileType === 'office' && officeBlob) {
        const url = URL.createObjectURL(officeBlob)
        triggerDownload(url, name)
        return
      }
      if (fileType === 'image' && imageUrl) {
        // imageUrl is a blob URL we created — use it directly
        triggerDownload(imageUrl, name)
        return
      }
      if (fileType === 'format' && formatBlob) {
        const url = URL.createObjectURL(formatBlob)
        triggerDownload(url, name)
        return
      }

      // Text content — create blob from string
      if (content != null) {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        triggerDownload(url, name)
        return
      }

      // Fallback: try reading from OPFS
      const opfs = (await import('@/store/opfs.store')).useOPFSStore.getState()
      const result = await opfs.readFile(filePath)
      if (result.content instanceof Blob) {
        const url = URL.createObjectURL(result.content)
        triggerDownload(url, name)
      } else if (result.content instanceof ArrayBuffer) {
        const blob = new Blob([result.content])
        const url = URL.createObjectURL(blob)
        triggerDownload(url, name)
      } else if (typeof result.content === 'string') {
        const blob = new Blob([result.content], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        triggerDownload(url, name)
      }
    } catch (err) {
      console.warn('[FilePreview] Download failed:', err)
      toast.error(t('filePreview.downloadFailed') ?? 'Download failed')
    }
  }, [filePath, fileType, content, officeBlob, imageUrl, formatBlob, t])

  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center bg-white dark:bg-neutral-950">
        <div className="text-center text-neutral-400">
          <FileText className="mx-auto mb-2 h-6 w-6" />
          <p className="text-xs">{t('filePreview.clickFileTreeToPreview')}</p>
        </div>
      </div>
    )
  }

  const fileName = filePath.split('/').pop() || filePath
  const language = getMonacoLanguage(filePath)

  // Whether Monaco is showing the file as editable text (excludes images,
  // office docs, binary). Both the edit toggle and the comment feature
  // require this — comments additionally need preview mode.
  const canTouchText = !loading && !error && (
    (content && fileType === 'text')
    || (fileType === 'format' && formatViewMode === 'text' && formatTextContent)
  )
  const canEdit = canTouchText
  const isCommentable = !editMode && canTouchText

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-white dark:bg-neutral-950">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-700">
        <div className="flex min-w-0 items-center gap-2">
          {diskNewer && (
            <span
              className="shrink-0 rounded bg-warning/20 px-1.5 py-0.5 text-[10px] font-semibold text-warning"
              title={t('filePreview.diskFileNewer')}
            >
              {t('filePreview.conflict')}
            </span>
          )}
          <span className="truncate text-xs font-medium text-neutral-700 dark:text-foreground" title={filePath}>
            {fileName}
          </span>
          <span className="shrink-0 text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">{formatBytes(fileSize)}</span>
          {/* Comment count badge */}
          {comments.length > 0 && (
            <span className="shrink-0 inline-flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
              <MessageSquare className="h-2.5 w-2.5" />
              {comments.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Format view mode toggle (driven by format-registry) */}
          {fileType === 'format' && formatBlob && formatUI && formatUI.viewModes.length > 1 && !loading && (
            <div className="flex items-center rounded border border-neutral-200 dark:border-neutral-600">
              {formatUI.viewModes.map((mode, i) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => setFormatViewMode(mode.id)}
                  className={`${i === 0 ? 'rounded-l' : 'rounded-r'} px-1.5 py-0.5 text-[10px] ${
                    formatViewMode === mode.id
                      ? 'bg-neutral-800 text-white dark:bg-neutral-200 dark:text-neutral-800'
                      : 'text-neutral-500 hover:bg-neutral-100 text-neutral-400 text-neutral-400 dark:text-neutral-400 dark:hover:bg-neutral-800'
                  }`}
                  title={mode.id === 'text' ? 'Text view (supports comments)' : `${mode.label} view`}
                >
                  {mode.id === 'text' ? <Code className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                </button>
              ))}
            </div>
          )}
          {/* Open in new tab via external service (generic for any format that supports it) */}
          {fileType === 'format' && formatBlob && filePath?.endsWith('.xlsx') && !loading && !error && (
            <button
              type="button"
              onClick={async () => {
                try {
                  const url = await getEo2EditorUrl(formatBlob, fileName)
                  window.open(url, '_blank', 'noopener')
                } catch (err) {
                  toast.error(t('filePreview.openInNewTabFailed', { error: err instanceof Error ? err.message : String(err) }))
                }
              }}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 text-neutral-500 text-neutral-500 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
              title={t('filePreview.openInNewTab')}
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
          {/* Refresh — reload file from disk/OPFS */}
          {filePath && (
            <button
              type="button"
              onClick={handleRefresh}
              disabled={loading}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-30 text-neutral-500 text-neutral-500 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
              title={t('filePreview.refresh')}
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          )}
          {/* Comment hint for text files */}
          {isCommentable && !composer && !editMode && (
            <span className="hidden shrink-0 text-[10px] text-neutral-300 text-neutral-600 text-neutral-600 dark:text-neutral-600 sm:inline">
              {t('filePreview.selectToComment')}
            </span>
          )}
          {content && (
            <button
              type="button"
              onClick={handleCopy}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 text-neutral-500 text-neutral-500 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
              title={t('filePreview.copyContent')}
            >
              {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
            </button>
          )}
          {!loading && !error && (
            <button
              type="button"
              onClick={handleDownload}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 text-neutral-500 text-neutral-500 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
              title={t('filePreview.download') ?? 'Download file'}
            >
              <Download className="h-3 w-3" />
            </button>
          )}
          {/* Edit / Preview mode toggle */}
          {canEdit && (
            <button
              type="button"
              onClick={() => {
                if (editMode && isDirty) {
                  if (!confirm(t('filePreview.unsavedOnSwitch'))) return
                }
                if (!editMode) {
                  // Entering edit mode: snapshot current content
                  const base = content ?? formatTextContent ?? ''
                  setEditedContent(base)
                  setOriginalForDiff(base)
                }
                setEditMode(!editMode)
              }}
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                editMode
                  ? 'bg-blue-600 text-white'
                  : 'text-neutral-500 hover:bg-neutral-100 text-neutral-400 text-neutral-400 dark:text-neutral-400 dark:hover:bg-neutral-800'
              }`}
              title={editMode ? t('filePreview.previewMode') : t('filePreview.editMode')}
            >
              {editMode ? <Eye className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
            </button>
          )}
          {/* Save button (edit mode only) */}
          {editMode && (
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || !isDirty}
              className="flex items-center gap-1 rounded bg-blue-600 px-2 py-0.5 text-[10px] font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-30"
              title={t('filePreview.save')}
            >
              <Save className="h-3 w-3" />
              {saving ? t('common.saving') : t('filePreview.save')}
            </button>
          )}
          {/* Unsaved indicator */}
          {isDirty && (
            <Circle className="h-1.5 w-1.5 shrink-0 fill-amber-500 text-amber-500" />
          )}
          {/* Toggle between split (side-by-side) and overlay (full-width drawer) mode */}
          <button
            type="button"
            onClick={() => setFilePreviewMode(filePreviewMode === 'split' ? 'overlay' : 'split')}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 text-neutral-500 text-neutral-500 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            title={filePreviewMode === 'split' ? t('filePreview.switchToOverlay') : t('filePreview.switchToSplit')}
          >
            {filePreviewMode === 'split' ? <Maximize2 className="h-3 w-3" /> : <PanelRightClose className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 text-neutral-500 text-neutral-500 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
            title={t('filePreview.close')}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading && <div className="p-4 text-center text-xs text-neutral-400">Loading...</div>}

        {error && <div className="p-4 text-center text-xs text-red-500">{error}</div>}

        {/* Image preview */}
        {fileType === 'image' && imageUrl && !loading && (
          <div className="flex h-full items-center justify-center p-4">
            <img
              src={imageUrl}
              alt={fileName}
              className="max-h-full max-w-full object-contain"
              style={{ imageRendering: fileName.endsWith('.ico') ? 'pixelated' : 'auto' }}
            />
          </div>
        )}

        {/* Office file preview (xlsx, xls, pptx, ppt, doc) via eo2suite */}
        {fileType === 'office' && officeBlob && !loading && !error && (
          <OfficePreview blob={officeBlob} fileName={fileName} fileSize={fileSize} />
        )}

        {/* Format preview (driven by format-registry).
            Always rendered when loaded (not conditionally unmounted) so that
            heavy components (e.g. OfficePreview uploading to eo2suite) are not
            re-mounted on every view-mode toggle. Hidden via CSS instead. */}
        {fileType === 'format' && formatBlob && formatUI?.PreviewComponent && !loading && !error && (
          <div className={formatViewMode === 'preview' ? 'h-full' : 'hidden'}>
            <Suspense fallback={<div className="flex h-full items-center justify-center"><p className="text-xs text-neutral-400">Loading...</p></div>}>
              <formatUI.PreviewComponent blob={formatBlob} fileName={fileName} fileSize={fileSize} filePath={filePath ?? undefined} />
            </Suspense>
          </div>
        )}

        {/* Binary (non-image) file */}
        {fileType === 'binary' && !loading && !error && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4">
            <FileText className="h-8 w-8 text-neutral-300" />
            <p className="text-xs text-neutral-500">{t('filePreview.binaryFile')}</p>
            <p className="text-[10px] text-neutral-400">
              {fileName} ({formatBytes(fileSize)})
            </p>
          </div>
        )}

        {/* Monaco Editor for text files and format text view */}
        {((content && fileType === 'text')
          || (fileType === 'format' && formatViewMode === 'text' && formatTextContent)
        ) && !loading && !error && (
          <Editor
            height="100%"
            language={fileType === 'format' ? 'plaintext' : language}
            value={editMode ? editedContent : (fileType === 'format' ? formatTextContent! : content!)}
            theme={isDark ? 'vs-dark' : 'vs'}
            onMount={handleEditorMount}
            onChange={(val) => {
              if (editMode) setEditedContent(val ?? '')
            }}
            options={{
              readOnly: !editMode,
              minimap: { enabled: display.showMiniMap },
              lineNumbers: display.showLineNumbers ? 'on' : 'off',
              scrollBeyondLastLine: false,
              wordWrap: display.wordWrap ? 'on' : 'off',
              automaticLayout: true,
              fontSize: display.fontSize === 'small' ? 13 : display.fontSize === 'large' ? 16 : 14,
              padding: { top: 8, bottom: 8 },
              scrollbar: {
                vertical: 'auto',
                horizontal: 'auto',
                verticalScrollbarSize: 10,
                horizontalScrollbarSize: 10,
              },
              glyphMargin: !editMode, // glyph margin only needed for comment feature
            }}
          />
        )}
      </div>

      {/* ── Comment Composer ─────────────────────────────────────────────── */}
      {composer && (
        <div className="shrink-0 border-t border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-850">
          <div className="flex items-center gap-2 px-3 py-1.5">
            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span className="shrink-0 text-[11px] font-medium text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
              {composer.startLine === composer.endLine
                ? `L${composer.startLine}`
                : `L${composer.startLine}-L${composer.endLine}`}
            </span>
            <div className="flex-1" />
            <kbd className="shrink-0 rounded border border-neutral-200 px-1 text-[10px] text-neutral-400 dark:border-neutral-600 text-neutral-500 text-neutral-500 dark:text-neutral-500">⌘↵</kbd>
            <button
              type="button"
              onClick={() => {
                setComposer(null)
                anchorLineRef.current = null
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-600 text-neutral-500 text-neutral-500 dark:text-neutral-500 dark:hover:bg-neutral-700 dark:hover:text-neutral-300"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {/* Show selected text snippet if available */}
          {composer.selectedText && (
            <div className="px-3 pb-1.5">
              <div className="flex items-start gap-1.5 rounded border border-blue-200 bg-blue-50/60 px-2 py-1 dark:border-blue-800/50 dark:bg-blue-950/20">
                <span className="shrink-0 text-[10px] font-medium text-blue-500 dark:text-blue-400">{"\""}</span>
                <code className="min-w-0 flex-1 truncate text-[11px] text-blue-700 dark:text-blue-300" title={composer.selectedText}>
                  {composer.selectedText.length > 100
                    ? `${[...composer.selectedText].slice(0, 100).join('')}...`
                    : composer.selectedText}
                </code>
                <span className="shrink-0 text-[10px] font-medium text-blue-500 dark:text-blue-400">{"\""}</span>
              </div>
            </div>
          )}
          <div className="flex items-start gap-2 px-3 pb-2.5">
            <textarea
              className="min-h-[48px] flex-1 resize-none rounded border border-neutral-200 bg-white px-2.5 py-1.5 text-[13px] leading-snug text-neutral-800 outline-none focus:border-neutral-400 dark:border-neutral-600 dark:bg-neutral-800 dark:text-foreground dark:focus:border-neutral-500"
              placeholder={t('filePreview.addComment')}
              autoFocus
              rows={2}
              value={composer.text}
              onChange={(e) => setComposer((prev) => (prev ? { ...prev, text: e.target.value } : prev))}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setComposer(null)
                  anchorLineRef.current = null
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
              {t('filePreview.send')}
            </button>
          </div>
        </div>
      )}

      {/* ── Comments Summary Bar ─────────────────────────────────────────── */}
      {comments.length > 0 && !composer && (
        <div className="shrink-0 border-t border-neutral-200 bg-amber-50/80 px-3 py-1.5 dark:border-neutral-700 dark:bg-amber-950/20">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="text-[11px] text-amber-700 dark:text-amber-300">
              {t('filePreview.commentsCount', { count: comments.length })}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={clearAllComments}
              className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-amber-600 transition-colors hover:bg-amber-100/80 dark:text-amber-400 dark:hover:bg-amber-900/30"
              title={t('filePreview.clearComments')}
            >
              <Trash2 className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={sendCommentsToAI}
              className="inline-flex h-6 items-center gap-1 rounded bg-amber-600 px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
            >
              <Send className="h-3 w-3" />
              {t('filePreview.sendToAI')}
            </button>
          </div>
          {/* Individual comment chips */}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {comments.map((item) => (
              <div
                key={item.id}
                className="inline-flex max-w-full items-center gap-1 rounded border border-amber-200 bg-white px-2 py-1 text-xs dark:border-amber-800 dark:bg-amber-950/40"
              >
                <span className="shrink-0 font-mono text-[10px] text-amber-600 dark:text-amber-400">
                  {item.startLine === item.endLine ? `L${item.startLine}` : `L${item.startLine}-L${item.endLine}`}
                </span>
                <span className="max-w-[240px] truncate text-neutral-700 text-neutral-300 text-neutral-300 dark:text-neutral-300" title={item.text}>
                  {item.text}
                </span>
                <button
                  className="shrink-0 text-neutral-400 hover:text-red-500 text-neutral-500 text-neutral-500 dark:text-neutral-500 dark:hover:text-red-400"
                  onClick={() => removeComment(item.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer - file path */}
      <div className="border-t border-neutral-100 px-3 py-1 dark:border-neutral-800">
        <span className="text-[10px] text-neutral-400" title={filePath}>
          {filePath}
        </span>
      </div>

      {/* ── CSS for Monaco comment decorations ───────────────────────────── */}
      <style>{`
        .fp-commented-line {
          background-color: rgba(245, 158, 11, 0.08) !important;
        }
        .fp-commented-glyph {
          background-color: rgba(245, 158, 11, 0.5);
          border-radius: 50%;
          margin-left: 4px;
          width: 6px !important;
          height: 6px !important;
          margin-top: 7px;
        }
        .fp-selected-line {
          background-color: rgba(59, 130, 246, 0.1) !important;
        }
        .fp-selected-glyph {
          background-color: rgba(59, 130, 246, 0.6);
          border-radius: 50%;
          margin-left: 4px;
          width: 6px !important;
          height: 6px !important;
          margin-top: 7px;
        }
        .fp-selected-text {
          background-color: rgba(59, 130, 246, 0.18) !important;
          border-radius: 2px;
        }
      `}</style>
    </div>
  )
}
