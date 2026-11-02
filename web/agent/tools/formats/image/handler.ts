/**
 * Image Format Handler — metadata extraction for AI read tool.
 *
 * Strategy:
 *   - Decodes image headers to extract dimensions (width, height)
 *   - Reports format, size, and dimensions
 *   - For SVG, returns text content directly (it's human-readable XML)
 *   - For raster images, returns metadata + OCR hint
 *
 * Write support: direct passthrough (binary copy).
 */

import type { FormatHandler, FormatReadResult } from '../../format-registry'
import { formatSize } from '@/lib/utils'

/** Supported image extensions */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg',
])

/** MIME types for image extensions */
const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}

/** Extract dimensions from PNG header (IHDR chunk) */
function getPngDimensions(data: Uint8Array): { width: number; height: number } | null {
  // PNG signature: 8 bytes, then IHDR chunk: 4-byte length + 4-byte type + 4-byte width + 4-byte height
  if (data.length < 24) return null
  // Check PNG signature
  if (data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4E || data[3] !== 0x47) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const width = view.getUint32(16, false) // big-endian
  const height = view.getUint32(20, false)
  return { width, height }
}

/** Extract dimensions from JPEG header (SOF markers) */
function getJpegDimensions(data: Uint8Array): { width: number; height: number } | null {
  if (data[0] !== 0xFF || data[1] !== 0xD8) return null
  let offset = 2
  while (offset < data.length - 1) {
    if (data[offset] !== 0xFF) return null
    const marker = data[offset + 1]
    // SOF0 (Baseline), SOF1, SOF2 (Progressive)
    if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
      if (offset + 9 > data.length) return null
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
      const height = view.getUint16(offset + 5, false)
      const width = view.getUint16(offset + 7, false)
      return { width, height }
    }
    // Skip to next marker
    if (offset + 3 > data.length) return null
    const segLen = (data[offset + 2] << 8) | data[offset + 3]
    offset += 2 + segLen
  }
  return null
}

/** Extract dimensions from GIF header */
function getGifDimensions(data: Uint8Array): { width: number; height: number } | null {
  // GIF87a or GIF89a
  if (data.length < 10) return null
  if (data[0] !== 0x47 || data[1] !== 0x49 || data[2] !== 0x46) return null
  // Width and height are little-endian 16-bit at offset 6 and 8
  const width = data[6] | (data[7] << 8)
  const height = data[8] | (data[9] << 8)
  return { width, height }
}

/** Extract dimensions from BMP header */
function getBmpDimensions(data: Uint8Array): { width: number; height: number } | null {
  // BM signature + DIB header
  if (data.length < 26) return null
  if (data[0] !== 0x42 || data[1] !== 0x4D) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const width = view.getInt32(18, true)   // little-endian
  const height = Math.abs(view.getInt32(22, true)) // absolute value (negative = top-down)
  return { width, height }
}

/** Extract dimensions from WebP header */
function getWebpDimensions(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 30) return null
  // RIFF signature
  if (data[0] !== 0x52 || data[1] !== 0x49 || data[2] !== 0x46 || data[3] !== 0x46) return null
  // WEBP
  if (data[8] !== 0x57 || data[9] !== 0x45 || data[10] !== 0x42 || data[11] !== 0x50) return null

  const chunkType = String.fromCharCode(data[12], data[13], data[14], data[15])

  if (chunkType === 'VP8 ') {
    // Lossy
    if (data.length < 30) return null
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const width = view.getUint16(26, true) & 0x3FFF
    const height = view.getUint16(28, true) & 0x3FFF
    return { width, height }
  } else if (chunkType === 'VP8L') {
    // Lossless
    if (data.length < 25) return null
    const bits = data[21] | (data[22] << 8) | (data[23] << 16) | (data[24] << 24)
    const width = (bits & 0x3FFF) + 1
    const height = ((bits >> 14) & 0x3FFF) + 1
    return { width, height }
  } else if (chunkType === 'VP8X') {
    // Extended
    if (data.length < 30) return null
    const width = ((data[24] | (data[25] << 8) | (data[26] << 16)) + 1)
    const height = ((data[27] | (data[28] << 8) | (data[29] << 16)) + 1)
    return { width, height }
  }
  return null
}

/** Extract dimensions from ICO header */
function getIcoDimensions(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 8) return null
  if (data[0] !== 0x00 || data[1] !== 0x00) return null
  // Type: 1 = ICO
  if (data[2] !== 0x01 || data[3] !== 0x00) return null
  // First entry dimensions (0 means 256)
  const w = data[6] || 256
  const h = data[7] || 256
  return { width: w, height: h }
}

/** Get image dimensions from binary data based on extension */
function getImageDimensions(data: Uint8Array, ext: string): { width: number; height: number } | null {
  switch (ext) {
    case 'png': return getPngDimensions(data)
    case 'jpg':
    case 'jpeg': return getJpegDimensions(data)
    case 'gif': return getGifDimensions(data)
    case 'bmp': return getBmpDimensions(data)
    case 'webp': return getWebpDimensions(data)
    case 'ico': return getIcoDimensions(data)
    default: return null
  }
}

export const imageHandler: FormatHandler = {
  extension: 'png', // Primary extension; handles all image types via getImageDimensions
  label: 'Image',
  binaryMode: true,
  formatHint:
    'This is a binary image file — it CANNOT be edited or written with the write/edit tools. '
    + 'read() returns metadata (dimensions, format, size). '
    + 'Use Python (Pillow) to manipulate images: resize, crop, convert, etc.',

  async read(data: ArrayBuffer | Uint8Array, path: string): Promise<FormatReadResult> {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
    const ext = path.split('.').pop()?.toLowerCase() || ''
    const fileName = path.split('/').pop() || path
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream'
    const fileSize = bytes.byteLength

    // SVG is text-based — return content directly
    if (ext === 'svg') {
      const text = new TextDecoder().decode(bytes)
      // Try to extract width/height from SVG attributes
      const widthMatch = text.match(/\bwidth\s*=\s*["']?(\d+(?:\.\d+)?)(?:px)?["']?/i)
      const heightMatch = text.match(/\bheight\s*=\s*["']?(\d+(?:\.\d+)?)(?:px)?["']?/i)
      const viewBoxMatch = text.match(/\bviewBox\s*=\s*["']\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/i)

      let width: number | null = null
      let height: number | null = null
      if (widthMatch) width = parseFloat(widthMatch[1])
      if (heightMatch) height = parseFloat(heightMatch[1])
      if (viewBoxMatch && (!width || !height)) {
        width = width || parseFloat(viewBoxMatch[3])
        height = height || parseFloat(viewBoxMatch[4])
      }

      const parts: string[] = [
        `[SVG Image] ${fileName}`,
        `Size: ${formatSize(fileSize)}`,
        `MIME: ${mimeType}`,
      ]
      if (width && height) {
        parts.push(`Dimensions: ${width} × ${height}`)
      }
      parts.push('')
      parts.push('--- SVG Source ---')
      parts.push(text)

      return { content: parts.join('\n'), kind: 'image', metadata: { width, height, mimeType, fileSize } }
    }

    // Raster image: extract metadata
    const dims = getImageDimensions(bytes, ext)

    const parts: string[] = [
      `[Image] ${fileName}`,
      `Format: ${ext.toUpperCase()}`,
      `MIME: ${mimeType}`,
      `Size: ${formatSize(fileSize)}`,
    ]
    if (dims) {
      parts.push(`Dimensions: ${dims.width} × ${dims.height}`)
      const megapixels = (dims.width * dims.height) / 1_000_000
      if (megapixels >= 0.1) {
        parts.push(`Megapixels: ${megapixels.toFixed(1)} MP`)
      }
    }
    parts.push('')
    parts.push('💡 Use OCR to extract text, or Python (Pillow) for image processing:')

    const csvFileName = path.split('/').pop()!
    if (ext === 'gif') {
      parts.push(`   from PIL import Image`)
      parts.push(`   img = Image.open('/mnt/<rootName>/${csvFileName}')`)
      parts.push(`   print(f'Frames: {img.n_frames}')`)
    } else {
      parts.push(`   from PIL import Image`)
      parts.push(`   img = Image.open('/mnt/<rootName>/${csvFileName}')`)
      parts.push(`   img.resize((w, h)).save('output.png')`)
    }

    return {
      content: parts.join('\n'),
      kind: 'image',
      metadata: {
        width: dims?.width ?? null,
        height: dims?.height ?? null,
        mimeType,
        fileSize,
      },
    }
  },

  async write(_content: string, _path: string): Promise<ArrayBuffer> {
    throw new FormatWriteError(
      'Image files cannot be written or edited with the write/edit tools.',
      'Images are binary files. Use Python (Pillow) to manipulate them:\n'
      + '  from PIL import Image\n'
      + '  img = Image.open("/mnt/<rootName>/path/to/image.png")\n'
      + '  img.resize((w, h)).save("/mnt/<rootName>/path/to/output.png")\n\n'
      + 'Common operations: resize, crop, rotate, convert format, adjust colors.',
    )
  },
}

class FormatWriteError extends Error {
  hint: string
  constructor(message: string, hint: string) {
    super(message)
    this.name = 'FormatWriteError'
    this.hint = hint
  }
}

export { IMAGE_EXTENSIONS, MIME_TYPES }
