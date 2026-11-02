import type {
  WebMCPPluginDownloadFrame,
  WebMCPPluginDownloadPlan,
} from './types'

const DEFAULT_CHUNK_CHARS = 256 * 1024

interface PreparedDownload {
  fileName: string
  mimeType: string
  dataUrl: string
}

function sanitizeFileName(name: string): string {
  const cleaned = name.trim().replace(/[\\/]/g, '_').replace(/\s+/g, ' ')
  const safe = cleaned.replace(/[<>:"|?*\x00-\x1F]/g, '_')
  return safe.length > 0 ? safe : `download_${Date.now()}`
}

function guessMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    txt: 'text/plain',
    json: 'application/json',
    csv: 'text/csv',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    zip: 'application/zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return map[ext] ?? 'application/octet-stream'
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

async function prepareDownload(plan: WebMCPPluginDownloadPlan): Promise<PreparedDownload> {
  const response = await fetch(plan.downloadUrl)
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`)
  }

  const fileName = sanitizeFileName(plan.fileName || `download_${Date.now()}`)

  const mimeType =
    response.headers.get('content-type')?.split(';')[0]?.trim() || guessMimeType(fileName)

  const arrayBuffer = await response.arrayBuffer()
  const base64 = arrayBufferToBase64(arrayBuffer)
  const dataUrl = `data:${mimeType};base64,${base64}`

  return {
    fileName,
    mimeType,
    dataUrl,
  }
}

function chunkData(data: string, chunkChars = DEFAULT_CHUNK_CHARS): string[] {
  if (chunkChars <= 0) return [data]
  const chunks: string[] = []
  for (let i = 0; i < data.length; i += chunkChars) {
    chunks.push(data.slice(i, i + chunkChars))
  }
  return chunks
}

export async function streamPluginDownload(
  plan: WebMCPPluginDownloadPlan,
  emit: (frame: WebMCPPluginDownloadFrame) => void
): Promise<void> {
  try {
    const prepared = await prepareDownload(plan)
    const chunks = chunkData(prepared.dataUrl)

    emit({
      type: 'start',
      transferId: plan.transferId,
      fileName: prepared.fileName,
      mimeType: prepared.mimeType,
      totalChunks: chunks.length,
      totalChars: prepared.dataUrl.length,
      savePath: plan.savePath,
    })

    for (let i = 0; i < chunks.length; i++) {
      emit({
        type: 'chunk',
        transferId: plan.transferId,
        index: i,
        data: chunks[i]!,
      })
    }

    emit({
      type: 'end',
      transferId: plan.transferId,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({
      type: 'error',
      transferId: plan.transferId,
      errorCode: 'WEBMCP_PLUGIN_DOWNLOAD_STREAM_FAILED',
      message,
    })
  }
}
