import type {
  WebMCPPluginDownloadFrame,
  WebMCPPluginDownloadPlan,
} from './types'
import { fetchWithMirrorFallback } from './registry-client'

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

/**
 * Fetch the download URL, falling back to the jsDelivr mirror when the
 * canonical host does not answer (issue #143).
 *
 * The plugin download URL frequently points at `raw.githubusercontent.com`
 * (package assets published from a repo), which is unreachable from
 * mainland-China networks. The same mirror candidate list the registry
 * client uses applies here: the canonical URL stays the identity of the
 * resource, the mirror is only a transport fallback.
 */
/** Per-candidate download deadline: headers AND body must arrive within it. */
const DOWNLOAD_TIMEOUT_MS = 30_000

/**
 * Fetch one download candidate and consume its body INSIDE the attempt, so
 * the mirror fallback sees a body failure/stall the same way it sees a
 * header failure. An AbortController deadline covers the WHOLE download —
 * fetchDownload used to wait on `fetch(candidate)` with no deadline, so a
 * host that accepted the connection and stalled blocked the fallback
 * forever, and a body read after the fallback loop bypassed the remaining
 * hosts (findings: "Stalled downloads block mirror fallback", "Failed
 * bodies skip mirror fallback").
 */
async function fetchDownload(candidate: string): Promise<{ buffer: ArrayBuffer; contentType: string | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(candidate, { signal: controller.signal })
    if (!response.ok) {
      const error = new Error(`Download failed with status ${response.status}`) as Error & { status?: number }
      error.status = response.status
      throw error
    }
    // The body is consumed while the deadline is still armed: a host that
    // answers headers then stalls the stream aborts here, and the fallback
    // loop moves on to the next candidate.
    const buffer = await response.arrayBuffer()
    return { buffer, contentType: response.headers.get('content-type') }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s: ${candidate}`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function prepareDownload(plan: WebMCPPluginDownloadPlan): Promise<PreparedDownload> {
  const result = await fetchWithMirrorFallback(plan.downloadUrl, fetchDownload)
  const fileName = sanitizeFileName(plan.fileName || `download_${Date.now()}`)

  const mimeType =
    result.value.contentType?.split(';')[0]?.trim() || guessMimeType(fileName)

  const base64 = arrayBufferToBase64(result.value.buffer)
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
