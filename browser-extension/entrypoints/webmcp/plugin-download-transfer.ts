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

/** Reject the private/reserved IPv4 ranges a download host must never be. */
function isForbiddenIPv4(parts: [number, number, number, number]): boolean {
  const [a, b, c] = parts
  return (
    a === 0 ||                                      // "this network" 0.0.0.0/8
    a === 10 ||                                     // RFC1918 private
    (a === 100 && b >= 64 && b <= 127) ||           // CGNAT 100.64/10
    a === 127 ||                                    // loopback 127/8
    (a === 169 && b === 254) ||                     // link-local 169.254/16 (metadata)
    (a === 172 && b >= 16 && b <= 31) ||            // RFC1918 private
    (a === 192 && b === 168) ||                     // RFC1918 private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0/24 + TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) ||        // benchmarking 198.18/15
    (a === 198 && b === 51 && c === 100) ||         // TEST-NET-2
    (a === 203 && b === 0 && c === 113) ||          // TEST-NET-3
    a >= 224                                        // multicast 224/4 + reserved 240/4
  )
}

/**
 * Parse a literal IPv6 address (no brackets) into its 8 16-bit groups.
 * Returns null for anything that is not a valid IPv6 literal.
 */
function parseIPv6Groups(host: string): number[] | null {
  if (!host.includes(':')) return null
  const doubleColons = host.match(/::/g)?.length ?? 0
  if (doubleColons > 1) return null
  const [leftRaw, rightRaw] = doubleColons === 1 ? host.split('::') : [host, '']
  const parseGroups = (part: string): number[] | null => {
    if (!part) return []
    const groups: number[] = []
    for (const piece of part.split(':')) {
      if (piece.includes('.')) {
        // Trailing IPv4-embedded form (e.g. ::ffff:127.0.0.1).
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(piece)) return null
        const octets = piece.split('.').map(Number)
        if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
        groups.push(octets[0]! * 256 + octets[1]!, octets[2]! * 256 + octets[3]!)
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(piece)) return null
        groups.push(parseInt(piece, 16))
      }
    }
    return groups
  }
  const head = parseGroups(leftRaw)
  const tail = parseGroups(rightRaw)
  if (!head || !tail) return null
  if (doubleColons === 0) {
    return head.length === 8 ? head : null
  }
  const fill = 8 - head.length - tail.length
  if (fill < 1) return null
  return [...head, ...new Array<number>(fill).fill(0), ...tail]
}

/** Reject the private/reserved IPv6 ranges a download host must never be. */
function isForbiddenIPv6(groups: number[]): boolean {
  const isZero = (g: number) => g === 0
  // Unspecified :: and loopback ::1.
  if (groups.every(isZero)) return true
  if (groups.slice(0, 7).every(isZero) && groups[7] === 1) return true
  // Link-local fe80::/10 and unique-local fc00::/7.
  const first = groups[0]!
  if ((first & 0xffc0) === 0xfe80) return true
  if ((first & 0xfe00) === 0xfc00) return true
  // IPv4-mapped ::ffff:0:0/96: groups[0..4] are zero, groups[5] is 0xffff —
  // apply the IPv4 rules to the embedded address. Also the deprecated
  // IPv4-compatible ::/96 form (all six leading groups zero).
  if (
    (groups.slice(0, 5).every(isZero) && groups[5] === 0xffff) ||
    groups.slice(0, 6).every(isZero)
  ) {
    const hi = groups[6]!
    const lo = groups[7]!
    return isForbiddenIPv4([Math.floor(hi / 256), hi % 256, Math.floor(lo / 256), lo % 256])
  }
  // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 target — same rules.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(isZero)) {
    const hi = groups[6]!
    const lo = groups[7]!
    return isForbiddenIPv4([Math.floor(hi / 256), hi % 256, Math.floor(lo / 256), lo % 256])
  }
  return false
}

function isForbiddenIpLiteral(hostname: string): boolean {
  // hostname: URL.hostname lowercased, trailing dot stripped, NO brackets.
  if (hostname.includes(':')) {
    const groups = parseIPv6Groups(hostname)
    // An IPv6-looking host that does not parse is refused outright.
    return groups === null || isForbiddenIPv6(groups)
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    const octets = hostname.split('.').map(Number) as [number, number, number, number]
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
    return isForbiddenIPv4(octets)
  }
  return false
}

/**
 * A plugin-download plan's URL originates from an UNTRUSTED page tool result.
 * The extension fetches it with background privileges, so a malicious site
 * could otherwise aim it at loopback / private-network endpoints (SSRF-style
 * probing of services on the user's machine or intranet). Validate before the
 * privileged fetch (#139 review round 6: untrusted URLs reach privileged
 * fetch; #148 review round 7: IPv6 literals beyond a few textual prefixes and
 * redirect targets slipped through): HTTPS only, public hosts only — no
 * localhost names, no single-label hosts, no .local / .internal suffixes, no
 * private / loopback / link-local / CGNAT / reserved IP literals (IPv4 and
 * IPv6, including IPv4-mapped IPv6), no credentials in the URL.
 *
 * Known limitation: this checks URL TEXT only. A public hostname that resolves
 * to a private address (DNS rebinding) cannot be detected from MV3 JS — there
 * is no DNS API and the browser resolves internally. Resolution-time
 * enforcement is the native host's responsibility; the extension layer is
 * defense-in-depth.
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
  const hostname = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    // Single-label hostname (no dot): on the public internet these do not
    // resolve globally; a bare name would resolve via local search domains.
    (!hostname.includes('.') && !hostname.includes(':'))
  ) {
    throw new Error(`Download URL host is not allowed: ${hostname}`)
  }
  if (isForbiddenIpLiteral(hostname)) {
    throw new Error(`Download URL host is not allowed: ${hostname}`)
  }
  return url
}

/**
 * Fetch an already-validated public URL WITHOUT following redirects
 * automatically: every 3xx Location target is re-validated with
 * assertPublicHttpsDownloadUrl before the next privileged request, so a
 * redirect cannot bounce the privileged fetch onto a private endpoint
 * (#148 review round 7: redirects reach private endpoints). Capped at 5 hops.
 * `response.url` of the returned (final) response is the validated URL.
 */
async function fetchPublicDownload(
  rawUrl: string,
  abortSignal?: AbortSignal
): Promise<Response> {
  const MAX_REDIRECTS = 5
  let currentUrl = rawUrl
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    const validated = assertPublicHttpsDownloadUrl(currentUrl)
    const response = await fetch(validated.href, {
      redirect: 'manual',
      signal: abortSignal,
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) {
        throw new Error(`Download redirect (${response.status}) missing Location header`)
      }
      if (hops === MAX_REDIRECTS) {
        throw new Error(`Download exceeded ${MAX_REDIRECTS} redirects`)
      }
      // Resolve relative Location values against the current URL, then the
      // loop head re-validates the absolute target before it is fetched.
      currentUrl = new URL(location, validated).href
      continue
    }
    return response
  }
  // Unreachable: the loop either returns or throws on hop MAX_REDIRECTS.
  throw new Error('Download redirect loop')
}

async function prepareDownload(plan: WebMCPPluginDownloadPlan, abortSignal?: AbortSignal): Promise<PreparedDownload> {
  const response = await fetchPublicDownload(plan.downloadUrl, abortSignal)
  if (!response.ok) {
    throw new Error(`Download failed with status ${response.status}`)
  }
  // Belt-and-braces: after the final hop the response URL must still be the
  // URL we validated for that hop (browser normalization cannot smuggle a
  // non-validated destination past redirect: 'manual').
  assertPublicHttpsDownloadUrl(response.url)

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
