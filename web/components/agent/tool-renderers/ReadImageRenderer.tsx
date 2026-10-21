import { Image } from 'lucide-react'
import type { ImageOutput } from '@creatorweave/shared/code-output'
import { registerRenderer } from './registry'
import { ImageOutputView } from './ImageOutputView'

function isImageOutput(value: unknown): value is ImageOutput {
  if (!value || typeof value !== 'object') return false
  const part = value as Record<string, unknown>
  return (
    part.type === 'image' &&
    typeof part.data === 'string' &&
    typeof part.mimeType === 'string'
  )
}

function getImage(result: Record<string, unknown> | null): ImageOutput | null {
  if (isImageOutput(result?.data)) return result.data

  if (Array.isArray(result?.contentParts)) {
    const image = result.contentParts.find(isImageOutput)
    if (image) return image
  }

  return null
}

registerRenderer({
  name: 'read_image',
  icon: <Image className="h-3.5 w-3.5" />,
  Summary(ctx) { return <span className="truncate">{String(ctx.args.path || 'read_image')}</span> },
  Detail(ctx) {
    const image = getImage(ctx.result)
    const path = String(ctx.args.path || 'read_image')
    return <div className="px-3 py-2">
      {image
        ? <ImageOutputView image={image} alt={path} />
        : <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(ctx.result, null, 2)}</pre>}
    </div>
  },
})
