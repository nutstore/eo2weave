/**
 * Renderer for `page_screenshot` tool — display the captured image inline.
 *
 * The executor returns a V2 envelope with:
 *   - data: { format, width, height }   (text metadata)
 *   - contentParts: [ { type: 'image', data, mimeType }, { type: 'text', text } ]
 *
 * The image data is already a base64 dataUrl or raw base64 string; we
 * reconstruct the data URL here and render an <img> element.
 */

import { ImageIcon, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { registerRenderer } from './registry'
import type { ToolRenderCtx } from './types'

interface ImagePart {
  type: 'image'
  data: string
  mimeType: string
}

function extractImagePart(ctx: ToolRenderCtx): ImagePart | null {
  // The tool result is delivered to the renderer as a JSON envelope string
  // via ctx.rawResult. contentParts (with the image) live inside the
  // envelope. We parse it here so this renderer works regardless of
  // whether the parent component also parsed out contentParts.
  const raw = ctx.rawResult || (typeof ctx.result === 'object' && ctx.result !== null ? JSON.stringify(ctx.result) : '')
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const candidates: unknown[] = []
  candidates.push((parsed as { contentParts?: unknown }).contentParts)
  const data = (parsed as { data?: unknown }).data
  if (data && typeof data === 'object') {
    candidates.push((data as { contentParts?: unknown }).contentParts)
  }

  for (const parts of candidates) {
    if (Array.isArray(parts)) {
      const image = parts.find(
        (p): p is ImagePart =>
          !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'image',
      )
      if (image && image.data && image.mimeType) return image
    }
  }
  return null
}

function imagePartToDataUrl(part: ImagePart): string {
  // dataUrl (e.g. "data:image/png;base64,xxx") vs raw base64
  if (part.data.startsWith('data:')) return part.data
  return `data:${part.mimeType};base64,${part.data}`
}

function formatBytes(base64: string): string {
  // Approximate decoded size (base64 is ~4/3 the raw size)
  const bytes = Math.floor(base64.length * 0.75)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

registerRenderer({
  name: 'page_screenshot',
  icon: <ImageIcon className="h-3.5 w-3.5 text-neutral-400" />,
  Summary(ctx) {
    const img = extractImagePart(ctx)
    const format = (ctx.result?.data as { format?: string } | undefined)?.format || 'png'

    return (
      <>
        <code className="font-medium text-neutral-700 dark:text-foreground">page_screenshot</code>
        <span className="text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 text-xs">viewport</span>
        {img && (
          <span className="ml-auto text-neutral-400 text-xs shrink-0">
            {format.toUpperCase()} · {formatBytes(img.data)}
          </span>
        )}
        {ctx.isExecuting && <Loader2 className="h-3 w-3 animate-spin text-blue-500" />}
      </>
    )
  },
  Detail(ctx) {
    // Hooks must run unconditionally (rules-of-hooks) — early returns stay below.
    const [loaded, setLoaded] = useState(false)

    if (ctx.isError) {
      return (
        <div className="px-3 py-2">
          <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/30 p-2 text-xs text-red-600 dark:text-red-400">
            {typeof ctx.result?.error === 'object' &&
            (ctx.result.error as { message?: string }).message
              ? (ctx.result.error as { message: string }).message
              : 'Screenshot failed'}
          </div>
        </div>
      )
    }

    const img = extractImagePart(ctx)
    if (!img) {
      if (ctx.isExecuting) {
        return (
          <div className="px-3 py-2 text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
            Capturing screenshot…
          </div>
        )
      }
      return (
        <div className="px-3 py-2 text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
          No screenshot data available
        </div>
      )
    }

    const src = imagePartToDataUrl(img)

    return (
      <div className="px-3 py-2 space-y-2">
        <div className="rounded-md overflow-hidden border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900">
          <img
            src={src}
            alt="Screenshot of the current page"
            className="block w-full h-auto max-h-[480px] object-contain"
            onLoad={() => setLoaded(true)}
            style={{ opacity: loaded ? 1 : 0.5, transition: 'opacity 200ms' }}
          />
        </div>
        <div className="flex items-center justify-between text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
          <span>
            {img.mimeType} · {formatBytes(img.data)}
          </span>
          <a
            href={src}
            download={`screenshot.${img.mimeType.split('/')[1] || 'png'}`}
            className="text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
          >
            Download
          </a>
        </div>
      </div>
    )
  },
})
