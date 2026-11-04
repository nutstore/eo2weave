import { useEffect, useState } from 'react'
import { Editor, loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { X } from 'lucide-react'
import { useT } from '@/i18n'
import '@/lib/monaco-setup'
import { BrandDialog, BrandDialogContent, BrandDialogTitle } from '@creatorweave/ui'

loader.config({ monaco })

export default function TextAttachmentPreview({ file, onClose, onRestoreFocus }: { file: File; onClose: () => void; onRestoreFocus: () => void }) {
  const t = useT()
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))

  useEffect(() => {
    let active = true
    setContent(null)
    setError(false)
    Promise.resolve().then(() => file.text()).then((text) => { if (active) setContent(text) }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [file, attempt])

  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

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
          {error ? <div role="alert" className="p-4 text-sm">{t('conversation.input.textPreviewFailed')} <button type="button" onClick={() => setAttempt((n) => n + 1)} className="underline">{t('conversation.input.retryPreview')}</button></div> : content === null ? <div role="status" className="p-4 text-sm">{t('conversation.input.loadingPreview')}</div> : (
            <Editor height="100%" language="plaintext" value={content} theme={dark ? 'vs-dark' : 'vs'} options={{ readOnly: true, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, wordWrap: 'on' }} />
          )}
        </div>
      </BrandDialogContent>
    </BrandDialog>
  )
}
