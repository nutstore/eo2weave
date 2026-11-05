import type {
  WebMCPPluginDownloadFrame,
  WebMCPPluginDownloadPlan,
} from './types'
import { assertPublicUrl, fetchPublicUrl, isForbiddenIpLiteral } from './public-http-guard'
import { fetchWithMirrorFallback } from './registry-client'

export { isForbiddenIpLiteral }

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
 * Validate a URL aimed at a remote MCP server by the CreatorWeave app's
 * mcp-client.service via the extension's proxy bridge (mcp_proxy_fetch /
 * mcp_proxy_fetch_stream). Unlike plugin downloads, MCP servers legitimately
 * run on the user's machine (http://localhost dev servers are a documented
 * preset in web/mcp/preset-providers.ts), so http + loopback are ALLOWED —
 * but everything else that could aim the privileged fetch at an intranet or
 * adjacent-host endpoint is still refused: private / link-local / CGNAT /
 * reserved IP literals (IPv4 and IPv6, incl. IPv4-mapped and NAT64 forms),
 * .local / .internal / single-label hosts, and embedded credentials.
 * (Same text-only DNS-rebinding limitation as assertPublicHttpsDownloadUrl.)
 */
export function assertValidMcpEndpointUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Invalid MCP endpoint URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`MCP endpoint URL must use http or https (got ${url.protocol})`)
  }
  if (url.username || url.password) {
    throw new Error('MCP endpoint URL must not embed credentials')
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
  const isLoopbackName = hostname === 'localhost' || hostname.endsWith('.localhost')
  if (
    !isLoopbackName &&
    (hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.home.arpa') ||
      // Single-label hostname (no dot): on the public internet these do not
      // resolve globally; a bare name would resolve via local search domains.
      (!hostname.includes('.') && !hostname.includes(':')))
  ) {
    throw new Error(`MCP endpoint host is not allowed: ${hostname}`)
  }
  if (isForbiddenIpLiteral(hostname, { allowLoopback: true })) {
    throw new Error(`MCP endpoint host is not allowed: ${hostname}`)
  }
  return url
}

/**
 * Fetch an already-validated MCP endpoint URL WITHOUT following redirects.
 *
 * Thin wrapper over the shared guarded fetch (public-http-guard): every 3xx
 * hop is re-validated with assertValidMcpEndpointUrl before the next
 * privileged request, capped at 5 hops, and an opaque-redirect is refused.
 * Without this, fetch's default redirect-following would bounce the privileged
 * background request onto ANY target an attacker-controlled (or compromised)
 * MCP endpoint names in its Location header — including the
 * intranet/loopback-adjacent hosts assertValidMcpEndpointUrl refuses
 * (#148 review round 7 / round 8, same class as the download path).
 */
export async function fetchMcpEndpointNoRedirects(
  rawUrl: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetchPublicUrl(rawUrl, {
    validate: assertValidMcpEndpointUrl,
    init,
    label: 'MCP endpoint',
    opaqueRedirectError: 'MCP endpoint URL redirected; redirects are not followed by the MCP proxy',
  })
}

/** Hosts a plugin download may ever be fetched from. Browser fetch cannot pin
 * the connected IP, so privileged downloads are limited to hosts whose DNS the
 * download plan's author cannot control. */
const DOWNLOAD_HOST_ALLOWLIST = ['raw.githubusercontent.com', 'cdn.jsdelivr.net'] as const

/**
 * A plugin-download plan's URL originates from an UNTRUSTED page tool result.
 * The extension fetches it with background privileges, so a malicious site
 * could otherwise aim it at loopback / private-network endpoints (SSRF-style
 * probing of services on the user's machine or intranet). Validate before the
 * privileged fetch (#139 review round 6: untrusted URLs reach privileged
 * fetch; #148 review round 7: IPv6 literals beyond a few textual prefixes and
 * redirect targets slipped through): HTTPS only, public hosts only — no
 * localhost names, no single-label hosts, no .local / .internal / .home.arpa
 * suffixes, no private / loopback / link-local / CGNAT / reserved IP literals
 * (IPv4 and IPv6, including IPv4-mapped and NAT64 forms), no credentials in
 * the URL — then the 2-host download allowlist above.
 *
 * The generic half lives in public-http-guard (shared with the web-fetch path,
 * #157); this wrapper only adds the download-specific host allowlist.
 *
 * Known limitation: this checks URL TEXT only. A public hostname that resolves
 * to a private address (DNS rebinding) cannot be detected from MV3 JS — there
 * is no DNS API and the browser resolves internally. Resolution-time
 * enforcement is the native host's responsibility; the extension layer is
 * defense-in-depth.
 */
export function assertPublicHttpsDownloadUrl(rawUrl: string): URL {
  return assertPublicUrl(rawUrl, {
    protocols: ['https:'],
    hostAllowlist: DOWNLOAD_HOST_ALLOWLIST,
    label: 'Download URL',
  })
}

/**
 * Fetch an already-validated public download URL WITHOUT following redirects.
 *
 * Thin wrapper over the shared guarded fetch (public-http-guard): every 3xx
 * hop is re-validated with assertPublicHttpsDownloadUrl before the next
 * privileged request, capped at 5 hops, opaque-redirect refused (#148 review
 * round 7: redirects reach private endpoints; round 8: opaque-redirect
 * filtering makes the Location header unreadable in Chrome, so the refusing
 * fallback is the live path there).
 */
async function fetchPublicDownload(
  rawUrl: string,
  abortSignal?: AbortSignal
): Promise<Response> {
  return fetchPublicUrl(rawUrl, {
    validate: assertPublicHttpsDownloadUrl,
    abortSignal,
    label: 'Download',
    opaqueRedirectError: 'Download URL redirected; redirects are not followed for plugin downloads',
  })
}

/** Per-candidate download deadline: headers AND body must arrive within it. */
const DOWNLOAD_TIMEOUT_MS = 30_000

/**
 * Fetch one download candidate, consuming its body INSIDE the attempt, so the
 * mirror fallback sees a body failure/stall the same way it sees a header
 * failure (#143 mirror fallback; the deadline covers the WHOLE download).
 *
 * Security discipline is inherited from fetchPublicDownload: every candidate
 * (canonical AND mirror) is validated with assertPublicHttpsDownloadUrl before
 * the privileged fetch, redirects are never followed (opaque-redirect is
 * refused), and the caller's abort signal is threaded through so client
 * disconnect/cancel aborts the in-flight upstream request.
 */
async function fetchDownload(
  candidate: string,
  abortSignal?: AbortSignal
): Promise<{ buffer: ArrayBuffer; contentType: string | null }> {
  abortSignal?.throwIfAborted()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  const onOuterAbort = () => controller.abort(abortSignal?.reason)
  abortSignal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    const response = await fetchPublicDownload(candidate, controller.signal)
    if (!response.ok) {
      const error = new Error(`Download failed with status ${response.status}`) as Error & { status?: number }
      error.status = response.status
      throw error
    }
    // The body is consumed while the deadline is still armed: a host that
    // answers headers then stalls the stream aborts here, and the fallback
    // loop moves on to the next candidate.
    const buffer = await response.arrayBuffer()
    abortSignal?.throwIfAborted()
    return { buffer, contentType: response.headers.get('content-type') }
  } catch (error) {
    if (controller.signal.aborted && !abortSignal?.aborted) {
      throw new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s: ${candidate}`)
    }
    throw error
  } finally {
    clearTimeout(timer)
    abortSignal?.removeEventListener('abort', onOuterAbort)
  }
}

async function prepareDownload(
  plan: WebMCPPluginDownloadPlan,
  abortSignal?: AbortSignal
): Promise<PreparedDownload> {
  const result = await fetchWithMirrorFallback(
    plan.downloadUrl,
    candidate => fetchDownload(candidate, abortSignal),
    { signal: abortSignal },
  )
  abortSignal?.throwIfAborted()
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
  emit: (frame: WebMCPPluginDownloadFrame) => void,
  abortSignal?: AbortSignal
): Promise<void> {
  try {
    const prepared = await prepareDownload(plan, abortSignal)
    const chunks = chunkData(prepared.dataUrl)
    abortSignal?.throwIfAborted()

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
      abortSignal?.throwIfAborted()
      emit({
        type: 'chunk',
        transferId: plan.transferId,
        index: i,
        data: chunks[i]!,
      })
    }

    abortSignal?.throwIfAborted()
    emit({
      type: 'end',
      transferId: plan.transferId,
    })
  } catch (error) {
    if (abortSignal?.aborted) return
    const message = error instanceof Error ? error.message : String(error)
    emit({
      type: 'error',
      transferId: plan.transferId,
      errorCode: 'WEBMCP_PLUGIN_DOWNLOAD_STREAM_FAILED',
      message,
    })
  }
}
