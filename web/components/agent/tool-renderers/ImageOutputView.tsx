import type { ImageOutput } from '@creatorweave/shared/code-output'

export function ImageOutputView({ image, alt }: { image: ImageOutput; alt: string }) {
  return <img src={`data:${image.mimeType};base64,${image.data}`} alt={alt}
    className="max-h-96 max-w-full rounded border object-contain" />
}
