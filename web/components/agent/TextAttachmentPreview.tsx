import { useCallback, useEffect, useRef, useState } from 'react'
import { Editor, loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { X } from 'lucide-react'
import { useT } from '@/i18n'
import '@/lib/monaco-setup'
import { BrandDialog, BrandDialogContent, BrandDialogTitle } from '@creatorweave/ui'
import { readAdjacentWindow, readForwardWindow, type LoadedWindow } from '@/components/agent/text-preview-window'

loader.config({ monaco })

/** Distance (px) from the scroll edge that triggers a window swap. */
const EDGE_TRIGGER_PX = 80
/** Debounce for edge-triggered swaps; after a swap it doubles as a cooldown so the programmatic re-anchor scroll cannot instantly re-trigger. */
const SWAP_DEBOUNCE_MS = 120

function formatChars(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * Normalize line endings so a window's text can be compared with the Monaco
 * model's value: Monaco stores the model with a single EOL sequence (LF or
 * CRLF), while a window's text keeps the file's own line endings.
 */
function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** Absolute file character offset of the line at the top of the viewport. */
function topVisibleCharOffset(editor: monaco.editor.IStandaloneCodeEditor, win: LoadedWindow): number {
  const model = editor.getModel()
  const range = editor.getVisibleRanges()[0]
  if (!model || !range) return win.startChar
  return win.startChar + model.getOffsetAt({ lineNumber: range.startLineNumber, column: 1 })
}

/**
 * Read-only preview for text attachments using virtualized windowed loading.
 *
 * The File stays a random-access source (Blob.slice); only one ~200k-character
 * window is materialized in the Monaco model at a time. Scrolling into the
 * bottom/top edge loads the next/previous window, which overlaps the current
 * one around the seam, and the viewport is restored to the character the user
 * was reading — so nothing is skipped at the seam and the last window is
 * always scrollable. Any file size is viewable at constant memory; Ctrl+F
 * only searches the loaded window — the model never holds the whole file.
 */
export default function TextAttachmentPreview({ file, onClose, onRestoreFocus }: { file: File; onClose: () => void; onRestoreFocus: () => void }) {
  const t = useT()
  const [win, setWin] = useState<LoadedWindow | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const winRef = useRef<LoadedWindow | null>(null)
  const busyRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Absolute character offset of the line the user was reading when a swap
  // was requested; re-applied once the new window is in the model.
  const pendingRef = useRef<number | null>(null)
  // Scroll position set by the anchor after a swap — the scroll event it
  // triggers must not start another swap.
  const anchorScrollRef = useRef<number | null>(null)

  // Initial load: the first window covering the head of the file.
  useEffect(() => {
    let active = true
    setWin(null)
    winRef.current = null
    setError(false)
    readForwardWindow(file, 0, 0)
      .then((first) => {
        if (!active) return
        // Keep the ref in step with the state: the scroll handler and swapTo
        // both read winRef, so leaving it null would disable all navigation
        // past the first window.
        winRef.current = first
        setWin(first)
      })
      .catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [file, attempt])

  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  // Restore the reading position after a swap: scroll so the character the
  // user was on sits at the top of the viewport again.
  const applyPendingScroll = useCallback(() => {
    const editor = editorRef.current
    const current = winRef.current
    const pending = pendingRef.current
    if (!editor || !current || pending === null) return
    const model = editor.getModel()
    if (!model) return
    // The model still holds the old window: wait for the content change.
    // The comparison is done on normalized line endings, because Monaco
    // stores the model with a single EOL sequence while the window text
    // keeps the file's own line endings.
    const modelValue = model.getValue()
    if (modelValue !== current.text && normalizeEol(modelValue) !== normalizeEol(current.text)) return
    const offset = Math.max(0, pending - current.startChar)
    const position = model.getPositionAt(Math.min(offset, model.getValueLength()))
    const target = editor.getTopForLineNumber(position.lineNumber)
    // Record the target before scrolling: the resulting scroll event must not
    // be mistaken for the user reaching the edge again.
    anchorScrollRef.current = target
    editor.setScrollTop(target)
    pendingRef.current = null
  }, [])

  const swapTo = useCallback(async (direction: 'next' | 'prev') => {
    const current = winRef.current
    const editor = editorRef.current
    if (!current || !editor || busyRef.current) return
    if (direction === 'next' ? current.atEof : current.atStart) return
    busyRef.current = true
    try {
      // Remember where the user is reading before the model changes.
      pendingRef.current = topVisibleCharOffset(editor, current)
      const next = await readAdjacentWindow(file, current, direction)
      winRef.current = next
      setWin(next)
    } catch {
      setError(true) // reuse the pane-level error/retry path
      pendingRef.current = null
    } finally {
      busyRef.current = false
      timerRef.current = setTimeout(() => { timerRef.current = null }, SWAP_DEBOUNCE_MS)
    }
  }, [file])

  const handleEditorMount = useCallback((editor: monaco.editor.IStandaloneCodeEditor) => {
    editorRef.current = editor

    editor.onDidChangeModelContent(() => { applyPendingScroll() })

    editor.onDidScrollChange((event) => {
      // Ignore the scroll event caused by the anchor after a swap.
      if (anchorScrollRef.current !== null && Math.abs(event.scrollTop - anchorScrollRef.current) < 2) {
        anchorScrollRef.current = null
        return
      }
      const current = winRef.current
      if (!current || busyRef.current || timerRef.current) return
      const atBottom = event.scrollTop + editor.getLayoutInfo().height >= event.scrollHeight - EDGE_TRIGGER_PX
      const atTop = event.scrollTop <= EDGE_TRIGGER_PX
      const wanted = atBottom && !current.atEof ? 'next' : atTop && !current.atStart ? 'prev' : null
      if (!wanted) return
      timerRef.current = setTimeout(() => { timerRef.current = null; void swapTo(wanted) }, SWAP_DEBOUNCE_MS)
    })
  }, [swapTo, applyPendingScroll])

  // Apply the pending scroll once the new window is rendered. Runs on every
  // win change, so it also covers swaps whose new window has the same text
  // as the old one — Monaco fires no content-change event for those, and the
  // anchor would otherwise never be applied (leaving the viewport stuck).
  useEffect(() => {
    if (!win) return
    const id = window.setTimeout(() => { applyPendingScroll() }, 0)
    return () => window.clearTimeout(id)
  }, [win, applyPendingScroll])

  useEffect(() => () => { editorRef.current = null }, [])

  const multiWindow = win !== null && !(win.atStart && win.atEof)

  return (
    <BrandDialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <BrandDialogContent aria-describedby={undefined} onCloseAutoFocus={(event) => { event.preventDefault(); onRestoreFocus() }} onEscapeKeyDown={(event) => {
        if (document.querySelector('.monaco-editor .find-widget.visible')) event.preventDefault()
      }} className="flex h-[90vh] w-[90vw] max-w-[860px] flex-col overflow-hidden rounded-lg bg-white p-0 shadow-2xl dark:bg-neutral-900">
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 dark:border-neutral-700">
          <BrandDialogTitle className="min-w-0 break-all text-sm font-medium text-neutral-700 dark:text-neutral-200">{file.name}</BrandDialogTitle>
          <button type="button" onClick={onClose} aria-label={t('conversation.input.closePreview')} className="rounded p-1 text-neutral-500 hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 dark:hover:bg-neutral-800"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {error ? <div role="alert" className="p-4 text-sm">{t('conversation.input.textPreviewFailed')} <button type="button" onClick={() => setAttempt((n) => n + 1)} className="underline">{t('conversation.input.retryPreview')}</button></div> : win === null ? <div role="status" className="p-4 text-sm">{t('conversation.input.loadingPreview')}</div> : (
            <div className="flex min-h-0 flex-1 flex-col">
              {multiWindow && <div role="note" className="border-b border-neutral-200 px-4 py-2 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">{t('conversation.input.textPreviewWindow', { start: formatChars(win.startChar + 1), end: formatChars(win.endChar) })}</div>}
              <div className="min-h-0 flex-1">
                {/* Ctrl+F only searches the loaded ~200k-char window, not the
                    whole file — see the component header comment. */}
                <Editor
                  height="100%"
                  language="plaintext"
                  value={win.text}
                  theme={dark ? 'vs-dark' : 'vs'}
                  onMount={handleEditorMount}
                  options={{ readOnly: true, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, wordWrap: 'on' }}
                />
              </div>
            </div>
          )}
        </div>
      </BrandDialogContent>
    </BrandDialog>
  )
}
