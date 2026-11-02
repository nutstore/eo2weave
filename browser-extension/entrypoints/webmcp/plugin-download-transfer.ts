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

/**
 * A plugin-download plan's URL originates from an UNTRUSTED page tool result.
 * The extension fetches it with background privileges, so a malicious site
 * could otherwise aim it at loopback / private-network endpoints (SSRF-style
 * probing of services on the user's machine or intranet). Validate before the
 * privileged fetch (#139 review round 6: untrusted URLs reach privileged
 * fetch): HTTPS only, public hosts only — no localhost names, no private /
 * loopback / link-local / CGNAT IP literals, no .internal / .local suffixes,
 * no credentials in the URL.
 */
export function assertPublicHttpsDownloadUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Invalid download URL')
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Download URL must use https (got ${url.protocol})`)
  }
  if (url.username || url.password) {
    throw new Error('Download URL must not embed credentials')
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.0.0.0.0')
  ) {
    throw new Error(`Download URL host is not allowed: ${hostname}`)
  }
  // Bracketed IPv6 literal (URL.hostname keeps the brackets).
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const ipv6 = hostname.slice(1, -1)
    const compressed = ipv6.split(':').filter(Boolean).length
    const lowered = ipv6.toLowerCase()
    if (
      lowered === '::1' ||
      lowered === '::' ||
      lowered.startsWith('fe80') ||
      lowered.startsWith('fc') || lowered.startsWith('fd') ||
      lowered.startsWith('::ffff:127.') || lowered.startsWith('::ffff:10.') ||
      lowered.startsWith('::ffff:192.168.') || lowered.startsWith('::ffff:169.254.') ||
      lowered.startsWith('::ffff:172.') ||
      (compressed < 8 && (lowered.startsWith('64:ff9b') || lowered.startsWith('::ffff')))
    ) {
      throw new Error(`Download URL host is not allowed: ${hostname}`)
    }
    // Numeric-form IPv6 in private ranges is hard to enumerate exhaustively;
    // the explicit prefixes above cover loopback, link-local, unique-local,
    // and IPv4-mapped private forms.
    return url
  }
  if (!hostname.includes(':') && /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    const parts = hostname.split('.').map((p) => Number.parseInt(p, 10))
    const [a, b] = parts as [number, number]
    const octet = (v: number) => Number.isInteger(v) && v >= 0 && v <= 255
    if (parts.length !== 4 || !parts.every(octet)) {
      throw new Error(`Download URL host is not allowed: ${hostname}`)
    }
    const isPrivate =
      a === 0 || a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0 && parts[2] === 0)
    if (isPrivate) {
      throw new Error(`Download URL host is not allowed: ${hostname}`)
    }
  }
  return url
}

async function prepareDownload(plan: WebMCPPluginDownloadPlan, abortSignal?: AbortSignal): Promise<PreparedDownload> {
  assertPublicHttpsDownloadUrl(plan.downloadUrl)
  const response = await fetch(plan.downloadUrl, { signal: abortSignal })
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
  emit: (frame: WebMCPPluginDownloadFrame) => void,
  abortSignal?: AbortSignal
): Promise<void> {
  try {
    const prepared = await prepareDownload(plan, abortSignal)
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
