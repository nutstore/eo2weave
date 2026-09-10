/**
 * HtmlPreview - renders an HTML file through the shared safe sandbox.
 */

import { useState, useEffect, useCallback } from 'react'
import { ExternalLink } from 'lucide-react'
import { useT } from '@/i18n'
import toast from 'react-hot-toast'
import { HtmlSandboxPreview } from '@/components/agent/HtmlSandboxPreview'
import type { FormatPreviewProps } from '../../format-registry'

export function HtmlPreview({ blob, fileName, filePath }: FormatPreviewProps) {
  const t = useT()
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(!!blob)

  useEffect(() => {
    if (!blob) {
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const text = await blob.text()
        if (!cancelled) setContent(text)
      } catch {
        if (!cancelled) setContent(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [blob])

  const handleOpenInNewTab = useCallback(async () => {
    if (!content) return
    const path = filePath || fileName
    try {
      localStorage.setItem('preview-content-' + path, content)
      window.open(`/preview?path=${encodeURIComponent(path)}`, '_blank')
    } catch (err) {
      toast.error(t('filePreview.openInNewTabFailed', { error: err instanceof Error ? err.message : String(err) }))
    }
  }, [content, filePath, fileName, t])

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-neutral-400">{t('common.loading')}</div>
  }

  if (!content) {
    return <div className="flex h-full items-center justify-center text-sm text-red-400">{t('filePreview.cannotReadFile')}</div>
  }

  return (
    <HtmlSandboxPreview
      html={content}
      title={fileName}
      sandboxProfile="trusted-file"
      className="h-full rounded-none border-0"
      showReset
      extraActions={
        <button
          type="button"
          onClick={handleOpenInNewTab}
          className="flex h-11 w-11 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-white dark:focus-visible:ring-offset-neutral-900"
          aria-label={t('filePreview.openInNewTab') ?? 'Open in new tab'}
          title={t('filePreview.openInNewTab') ?? 'Open in new tab'}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      }
    />
  )
}
