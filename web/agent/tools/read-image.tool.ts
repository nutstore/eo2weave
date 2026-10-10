import type { ToolContext, ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'
import { resolveVfsTarget } from './vfs-resolver'
import { isSubagentPermissionDenied, SUBAGENT_PERMISSION_DENIED } from './agent-file-protection'
import { fileToBase64, isOcrCompatibleImage } from '@/services/ocr.service'
import { t as translateStatic } from '@creatorweave/i18n'
import { useI18nStore } from '@/i18n/store'
import { toolErrorJson, toolOkJson } from './tool-envelope'

const SUPPORTED_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'])
const MAX_SOURCE_BYTES = 10 * 1024 * 1024
const MAX_IMAGE_PIXELS = 20_000_000
const MAX_IMAGE_EDGE = 4096
const MAX_NORMALIZED_BYTES = 4 * 1024 * 1024

function translateReadImage(key: string, params?: Record<string, string | number>): string {
  return translateStatic(useI18nStore.getState().locale, `conversation.readImage.${key}`, params)
}

class ReadImagePreparationError extends Error {
  constructor(
    readonly code: 'image_too_large' | 'image_dimensions_too_large' | 'invalid_image',
    message: string,
  ) {
    super(message)
  }
}

function inferMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const mimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    bmp: 'image/bmp',
    gif: 'image/gif',
  }
  return mimeTypes[ext] ?? 'application/octet-stream'
}

function isSupportedImage(path: string, mimeType: string): boolean {
  if (isOcrCompatibleImage(mimeType)) return true
  return SUPPORTED_IMAGE_EXTENSIONS.has(path.split('.').pop()?.toLowerCase() ?? '')
}

function displayPath(path: string): string {
  return path.replace(/^vfs:\/\/(workspace|assets)\//, '')
}

function detectImageMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a') return 'image/gif'
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)) === 'GIF89a') return 'image/gif'
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp'
  return null
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new ReadImagePreparationError('invalid_image', translateReadImage('normalizeFailed')))
    }, type, quality)
  })
}

async function normalizeImage(file: File): Promise<{ file: File; width: number; height: number }> {
  if (typeof createImageBitmap !== 'function') {
    throw new ReadImagePreparationError('invalid_image', translateReadImage('browserUnsupported'))
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new ReadImagePreparationError('invalid_image', translateReadImage('invalidImage'))
  }

  try {
    const sourcePixels = bitmap.width * bitmap.height
    if (!bitmap.width || !bitmap.height || sourcePixels > MAX_IMAGE_PIXELS) {
      throw new ReadImagePreparationError(
        'image_dimensions_too_large',
        translateReadImage('dimensionsTooLarge', {
          width: bitmap.width,
          height: bitmap.height,
          maxPixels: MAX_IMAGE_PIXELS.toLocaleString(),
        }),
      )
    }

    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const needsReencode = scale < 1 || file.size > MAX_NORMALIZED_BYTES || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
    if (!needsReencode) return { file, width, height }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      throw new ReadImagePreparationError('invalid_image', translateReadImage('normalizeFailed'))
    }
    context.drawImage(bitmap, 0, 0, width, height)

    for (const quality of [0.9, 0.75, 0.6]) {
      const blob = await canvasToBlob(canvas, 'image/webp', quality)
      if (blob.size <= MAX_NORMALIZED_BYTES) {
        return { file: new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: 'image/webp' }), width, height }
      }
    }
    throw new ReadImagePreparationError(
      'image_too_large',
      translateReadImage('normalizedTooLarge', { maxSize: Math.round(MAX_NORMALIZED_BYTES / 1024 / 1024) }),
    )
  } finally {
    bitmap.close()
  }
}

export const readImageDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_image',
    description:
      'Read an image file from the authorized workspace or assets directory. ' +
      'Returns portable image bytes and dimensions. In run_code, use image(result) to emit it explicitly. ' +
      'Supports PNG, JPEG, WebP, BMP, and GIF images.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Image path in the authorized workspace (for example "photos/scan.png") ' +
            'or an asset path such as "vfs://assets/scan.png".',
        },
      },
      required: ['path'],
    },
  },
}

export const readImageExecutor: ToolExecutor = async (
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<string> => {
  const path = typeof args.path === 'string' ? args.path : undefined
  if (!path) return toolErrorJson('read_image', 'invalid_arguments', 'path is required')

  try {
    const target = await resolveVfsTarget(path, context, 'read')
    const result = await target.backend.readFile(target.path, { encoding: 'binary' })
    const binaryContent = result.content as ArrayBuffer | Uint8Array
    const bytes = binaryContent instanceof Uint8Array
      ? binaryContent
      : new Uint8Array(binaryContent)
    if (bytes.byteLength > MAX_SOURCE_BYTES) {
      return toolErrorJson(
        'read_image',
        'image_too_large',
        translateReadImage('sourceTooLarge', {
          size: (bytes.byteLength / 1024 / 1024).toFixed(1),
          maxSize: MAX_SOURCE_BYTES / 1024 / 1024,
        }),
        { details: { path: target.path, size: bytes.byteLength, maxSize: MAX_SOURCE_BYTES } },
      )
    }

    const declaredMimeType = result.mimeType || inferMimeType(target.path)
    const mimeType = detectImageMimeType(bytes) || declaredMimeType

    if (!isSupportedImage(target.path, mimeType)) {
      return toolErrorJson(
        'read_image',
        'not_an_image',
        translateReadImage('notImage', { mimeType }),
        { details: { path: target.path, mimeType } },
      )
    }

    const sourceFile = new File([bytes], target.path.split('/').pop() || 'image.png', { type: mimeType })
    context.abortSignal?.throwIfAborted()
    const { file, width, height } = await normalizeImage(sourceFile)
    const data = await fileToBase64(file)
    context.abortSignal?.throwIfAborted()
    return toolOkJson('read_image', {
      type: 'image', path: displayPath(target.path), data, mimeType: file.type, width, height,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isSubagentPermissionDenied(error)) {
      return toolErrorJson('read_image', SUBAGENT_PERMISSION_DENIED, message)
    }
    if (error instanceof ReadImagePreparationError) {
      return toolErrorJson('read_image', error.code, error.message)
    }
    if (message.includes('File not found') || message.includes('NotFoundError') || message.includes('not found')) {
      return toolErrorJson('read_image', 'file_not_found', `Image file not found: ${path}`)
    }
    return toolErrorJson('read_image', 'internal_error', translateReadImage('readFailed', { message }), { retryable: true })
  }
}

export const readImagePromptDoc: ToolPromptDoc = {
  category: 'file-ops',
  lines: [
    '- `read_image(path)` - Read an authorized image as portable JSON. Direct Agent calls display it; inside run_code call `image(result)` explicitly. Use `ocr` separately for text recognition.',
  ],
}
