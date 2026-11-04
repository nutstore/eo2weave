import { useCallback, useEffect, useRef, useState } from 'react'
import { Editor, loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { X } from 'lucide-react'
import { useT } from '@/i18n'
import '@/lib/monaco-setup'
import { BrandDialog, BrandDialogContent, BrandDialogTitle } from '@creatorweave/ui'
import { readBackwardWindow, readForwardWindow, type LoadedWindow } from './text-preview-window'

loader.config({ monaco })

/** Distance (px) from the scroll edge that triggers a window swap. */
const EDGE_TRIGGER_PX = 80
/** Debounce for edge-triggered swaps; after a swap it doubles as a cooldown so the programmatic re-anchor scroll cannot instantly re-trigger. */
const SWAP_DEBOUNCE_MS = 120

function formatChars(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * Read-only preview for text attachments using virtualized windowed loading.
 *
 * The File stays a random-access source (Blob.slice); only one ~200k-character
 * window is materialized in the Monaco model at a time. Scrolling into the
 * bottom/top edge loads the next/previous window and re-anchors the viewport
 * at the seam, so any file size is viewable at constant memory. Ctrl+F only
 * searches the loaded window — the model never holds the whole file.
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
  // Set when a swap lands; consumed on the model content change it triggers,
  // so the seam re-anchor happens after Monaco has the new window text.
  const anchorRef = useRef<'top' | 'bottom' | null>(null)

  // Initial load: the first window covering the head of the file.
  useEffect(() => {
    let active = true
    setWin(null)
    winRef.current = null
    setError(false)
    readForwardWindow(file, 0, 0)
      .then((first) => { if (active) setWin(first) })
      .catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [file, attempt])

  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  const swapTo = useCallback(async (direction: 'next' | 'prev') => {
    const current = winRef.current
    if (!current || busyRef.current) return
    if (direction === 'next' ? current.atEof : current.atStart) return
    busyRef.current = true
    try {
      const next = direction === 'next'
        ? await readForwardWindow(file, current.endChar, current.endByte)
        : await readBackwardWindow(file, current.startChar, current.startByte)
      // Forward: the seam is the line the user was reading → window top.
      // Backward: the seam is its last line → window bottom.
      anchorRef.current = direction === 'next' ? 'top' : 'bottom'
      winRef.current = next
      setWin(next)
    } catch {
      setError(true) // reuse the pane-level error/retry path
    } finally {
      busyRef.current = false
      timerRef.current = setTimeout(() => { timerRef.current = null }, SWAP_DEBOUNCE_MS)
    }
  }, [file])

  const handleEditorMount = useCallback((editor: monaco.editor.IStandaloneCodeEditor) => {
    editorRef.current = editor

    editor.onDidChangeModelContent(() => {
      if (!anchorRef.current) return
      editor.setScrollTop(anchorRef.current === 'top' ? 0 : editor.getScrollHeight())
      anchorRef.current = null
    })

    editor.onDidScrollChange((event) => {
      const current = winRef.current
      if (!current || busyRef.current || timerRef.current) return
      const atBottom = event.scrollTop + editor.getLayoutInfo().height >= event.scrollHeight - EDGE_TRIGGER_PX
      const atTop = event.scrollTop <= EDGE_TRIGGER_PX
      const wanted = atBottom && !current.atEof ? 'next' : atTop && !current.atStart ? 'prev' : null
      if (!wanted) return
      timerRef.current = setTimeout(() => { timerRef.current = null; void swapTo(wanted) }, SWAP_DEBOUNCE_MS)
    })
  }, [swapTo])

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
        <div className="min-h-0 flex-1">
          {error ? <div role="alert" className="p-4 text-sm">{t('conversation.input.textPreviewFailed')} <button type="button" onClick={() => setAttempt((n) => n + 1)} className="underline">{t('conversation.input.retryPreview')}</button></div> : win === null ? <div role="status" className="p-4 text-sm">{t('conversation.input.loadingPreview')}</div> : (
            <>
              {multiWindow && <div role="note" className="border-b border-neutral-200 px-4 py-2 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">{t('conversation.input.textPreviewWindow', { start: formatChars(win.startChar + 1), end: formatChars(win.endChar) })}</div>}
              <div className="h-full">
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
            </>
          )}
        </div>
      </BrandDialogContent>
    </BrandDialog>
  )
}
