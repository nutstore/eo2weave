/**
 * Address-space guard for URLs the extension fetches with background
 * privileges (#148, #157).
 *
 * Every privileged fetch of a URL that came from an untrusted page result —
 * plugin downloads, the web tool's web_fetch/web_fetch_render, MCP endpoint
 * proxies — must pass the same two gates:
 *
 *   1. `assertPublicUrl`: URL TEXT only — scheme, no credentials, no
 *      localhost / single-label / .local / .internal / .home.arpa hosts, no
 *      private / loopback / link-local / CGNAT / reserved IP literals (IPv4
 *      and IPv6, including IPv4-mapped, IPv4-compatible and NAT64 forms).
 *   2. `fetchPublicUrl`: the privileged fetch itself, with `redirect:
 *      'manual'` so EVERY 3xx hop is re-validated before the next request and
 *      an opaque-redirect (unfollowable in Chrome) is refused outright.
 *
 * Without gate 2 the default `redirect: 'follow'` turns any public URL into a
 * trampoline: a 302 to 169.254.169.254 or 127.0.0.1:port would be followed by
 * the background worker and its response handed back to the agent context.
 *
 * Known limitation: this checks URL TEXT only. A public hostname that resolves
 * to a private address (DNS rebinding) cannot be detected from MV3 JS — there
 * is no DNS API and the browser resolves internally. Resolution-time
 * enforcement is the native host's responsibility; the extension layer is
 * defense-in-depth.
 */

/** Reject the private/reserved IPv4 ranges a privileged fetch must never hit. */
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

/** Reject the private/reserved IPv6 ranges a privileged fetch must never hit. */
function isForbiddenIPv6(groups: number[]): boolean {
  const isZero = (g: number) => g === 0
  // Unspecified :: and loopback ::1.
  if (groups.every(isZero)) return true
  if (groups.slice(0, 7).every(isZero) && groups[7] === 1) return true
  // Link-local fe80::/10, unique-local fc00::/7 and the deprecated
  // site-local fec0::/10.
  const first = groups[0]!
  if ((first & 0xffc0) === 0xfe80) return true
  if ((first & 0xfe00) === 0xfc00) return true
  // fec0::/10 is deprecated (RFC 3879) but some stacks still route it
  // site-locally, so a literal here reaches intranet services exactly like
  // unique-local fc00::/7 (#148 review round 8).
  if ((first & 0xffc0) === 0xfec0) return true
  // 6to4 2002::/16: bits 16-47 carry the IPv4 address of the 6to4 gateway's
  // endpoint (RFC 3056), so 2002:0a00:0001:: routes to 10.0.0.1 on any host
  // with an active 6to4 route. Decode that embedded address and apply the same
  // IPv4 rules — the literal is indistinguishable from its IPv4 target to the
  // network, exactly like the IPv4-mapped and NAT64 forms below.
  if (first === 0x2002) {
    const hi = groups[1]!
    const lo = groups[2]!
    if (isForbiddenIPv4([Math.floor(hi / 256), hi % 256, Math.floor(lo / 256), lo % 256])) return true
  }
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
  // NAT64 well-known prefix 64:ff9b::/96 and the RFC 8215 local-use prefix
  // 64:ff9b:1::/96 both embed an IPv4 target — same rules. The local-use
  // variant routes through a LOCAL NAT64 gateway, so an attacker embedding a
  // private IPv4 there reaches intranet endpoints exactly like the
  // well-known prefix.
  //
  // Only the /96 embeddings are decoded. RFC 8215 assigns the local-use prefix
  // as a /48, and RFC 6052's /48 layout puts the IPv4 target in bits 48-79
  // (64:ff9b:1:a00:0:100:: for 10.0.0.1), which does not match the /96 shape
  // below. That stays a documented limitation: such a literal only routes when
  // the host itself runs a NAT64 gateway for the prefix — the same
  // host-local-routing class as the DNS-rebinding limitation in the file
  // header, and not detectable from URL text alone.
  if (
    (groups[0] === 0x64 && groups[1] === 0xff9b && (groups[2] === 0 || groups[2] === 1)) &&
    groups.slice(3, 6).every(isZero)
  ) {
    const hi = groups[6]!
    const lo = groups[7]!
    return isForbiddenIPv4([Math.floor(hi / 256), hi % 256, Math.floor(lo / 256), lo % 256])
  }
  return false
}

export function isForbiddenIpLiteral(hostname: string, opts: { allowLoopback: boolean } = { allowLoopback: false }): boolean {
  // hostname: URL.hostname lowercased, trailing dot stripped, NO brackets.
  if (hostname.includes(':')) {
    const groups = parseIPv6Groups(hostname)
    // An IPv6-looking host that does not parse is refused outright.
    if (groups === null) return true
    if (opts.allowLoopback) {
      // Loopback exemptions apply to the plain forms only; an IPv4-mapped or
      // NAT64-embedded loopback still routes as its embedded IPv4 address.
      // NOTE: the plain unspecified address :: is NOT exempted — it routes to
      // "this host" on many stacks just like a loopback, so only the true
      // loopback ::1 may pass (it is handled by isForbiddenIPv6 below).
      const isLoopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1
      if (isLoopback) return false
    }
    return isForbiddenIPv6(groups)
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    const octets = hostname.split('.').map(Number) as [number, number, number, number]
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
    if (opts.allowLoopback && octets[0] === 127) return false
    return isForbiddenIPv4(octets)
  }
  return false
}

/**
 * Thrown when a target is refused by the address-space guard. Callers map this
 * to a NON-retryable, user-visible tool error: retrying the same private /
 * loopback / opaque-redirect target can never succeed.
 */
export class PublicUrlRefusedError extends Error {
  readonly refused = true

  constructor(message: string) {
    super(message)
    this.name = 'PublicUrlRefusedError'
  }
}

/** URL-shape policy for `assertPublicUrl`. All fields are optional. */
export interface PublicUrlPolicy {
  /** Allowed protocols; defaults to https only. */
  protocols?: readonly string[]
  /**
   * When set, only these hostnames pass (plugin downloads). Omit for callers
   * that legitimately fetch any public host (the web tool).
   */
  hostAllowlist?: readonly string[]
  /** Leading noun for error messages, e.g. 'Download URL' → 'Download URL must use https'. */
  label?: string
}

/** Hostname as the guard derives it: lowercased, no brackets, no trailing dot. */
function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
}

/**
 * Gate 1: validate a URL a privileged fetch is about to hit. Throws with a
 * user-facing message on any scheme / credentials / host / IP-family violation.
 */
export function assertPublicUrl(rawUrl: string, policy: PublicUrlPolicy = {}): URL {
  const label = policy.label ?? 'URL'
  const protocols = policy.protocols ?? ['https:']
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new PublicUrlRefusedError(`Invalid ${label}`)
  }
  if (!protocols.includes(url.protocol)) {
    throw new PublicUrlRefusedError(
      `${label} must use ${protocols.map((p) => p.replace(':', '')).join(' or ')} (got ${url.protocol})`
    )
  }
  if (url.username || url.password) {
    throw new PublicUrlRefusedError(`${label} must not embed credentials`)
  }
  const hostname = normalizedHostname(url)
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa') ||
    // Single-label hostname (no dot): on the public internet these do not
    // resolve globally; a bare name would resolve via local search domains.
    (!hostname.includes('.') && !hostname.includes(':')) ||
    isForbiddenIpLiteral(hostname)
  ) {
    throw new PublicUrlRefusedError(`${label} host is not allowed: ${hostname}`)
  }
  // Browser fetch does not expose or pin the connected IP. Callers that know
  // which hosts they need can restrict the privileged fetch to hosts whose
  // DNS cannot be controlled by the URL's author.
  if (policy.hostAllowlist && !policy.hostAllowlist.includes(hostname)) {
    throw new PublicUrlRefusedError(`${label} host is not allowed: ${hostname}`)
  }
  return url
}

/** The web tool's policy: any public host, http or https, no allowlist. */
export function assertPublicWebUrl(rawUrl: string): URL {
  return assertPublicUrl(rawUrl, { protocols: ['http:', 'https:'], label: 'Web fetch URL' })
}

const DEFAULT_MAX_REDIRECTS = 5

/** Fetch's redirect statuses. Any other 3xx code (300, 304, 305, 306) is an
 * ordinary response, not a hop. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/**
 * Headers that carry a caller credential. They are never forwarded to a
 * DIFFERENT origin: the redirect target is chosen by the remote server, not by
 * the caller, so replaying a Secret Manager value there hands it to a host the
 * caller never meant to talk to.
 */
const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'cookie2',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-session-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-amz-security-token',
])

/**
 * Credential-shaped names beyond the well-known set (`x-service-secret`,
 * `x-goog-api-key`, …). Over-stripping on a cross-origin hop is the safe
 * direction; under-stripping leaks.
 */
const SENSITIVE_HEADER_PATTERN = /(?:^|[-_])(?:auth|authorization|token|secret|session|cookie|password|passwd|credential|key)(?:$|[-_])/i

/** Headers that describe a request body and must go when the body goes. */
const BODY_HEADER_NAMES = ['content-type', 'content-length', 'content-encoding', 'transfer-encoding'] as const

function isSensitiveHeaderName(name: string): boolean {
  const lowered = name.toLowerCase()
  return SENSITIVE_HEADER_NAMES.has(lowered) || SENSITIVE_HEADER_PATTERN.test(lowered)
}

/**
 * Compute the request for the NEXT hop. Two independent rule sets:
 *
 *  - Fetch's redirect method rules (Fetch §HTTP-redirect fetch): 301/302 turn a
 *    POST into a GET and drop its body; 303 turns any non-GET/HEAD method into
 *    a GET; 307/308 replay method and body unchanged. Replaying a POST through
 *    a 302 re-submits the caller's payload to whatever the server named.
 *  - Our cross-origin rule: when the hop changes origin the server picked the
 *    target, so caller credentials and the request payload are dropped (a
 *    method whose body was dropped becomes GET). This is deliberately stricter
 *    than the browser's own redirect handling, which keeps the body.
 */
function nextHopInit(init: RequestInit, status: number, from: URL, to: URL): RequestInit {
  const headers = new Headers(init.headers ?? undefined)
  const method = (init.method ?? 'GET').toUpperCase()
  const hadBody = init.body !== undefined && init.body !== null
  const crossOrigin = from.origin !== to.origin

  let nextMethod = method
  let dropBody = false

  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
    if (method !== 'GET' && method !== 'HEAD') {
      nextMethod = 'GET'
      dropBody = true
    }
  }

  if (crossOrigin) {
    for (const name of [...headers.keys()]) {
      if (isSensitiveHeaderName(name)) headers.delete(name)
    }
    if (hadBody) {
      dropBody = true
      if (nextMethod !== 'GET' && nextMethod !== 'HEAD') nextMethod = 'GET'
    }
  }

  let nextBody = init.body
  if (dropBody) {
    nextBody = undefined
    for (const name of BODY_HEADER_NAMES) headers.delete(name)
  }

  return { ...init, method: nextMethod, headers, body: nextBody }
}

export interface GuardedFetchOptions {
  /** Validate one hop's absolute URL; must throw to refuse. */
  validate?: (rawUrl: string) => URL
  /** Request init for the first hop; later hops get a recomputed init. */
  init?: RequestInit
  abortSignal?: AbortSignal
  /** Leading noun for redirect errors, e.g. 'Download' → 'Download exceeded 5 redirects'. */
  label?: string
  maxRedirects?: number
  /** Exact message for a refused opaque-redirect hop. */
  opaqueRedirectError?: string
}

/**
 * Gate 2: fetch `rawUrl` WITHOUT letting the browser follow redirects, so
 * every redirect target (301/302/303/307/308) is validated before the next
 * privileged request. Capped at 5 hops by default. Non-redirect 3xx responses
 * (304 Not Modified, 300 Multiple Choices, …) are ordinary responses and are
 * handed back to the caller.
 *
 * In Chrome a 3xx met with `redirect: 'manual'` arrives as an opaque-redirect
 * filtered response (status 0, empty header list), so the hop loop is
 * unreachable there and the fetch refuses instead — an unfollowed redirect can
 * never reach a non-validated target. Extensions with host permissions are NOT
 * exempt from this filtering, hence the explicit refusal rather than surfacing
 * a misleading "status 0".
 */
export async function fetchPublicUrl(rawUrl: string, opts: GuardedFetchOptions = {}): Promise<Response> {
  const label = opts.label ?? 'URL'
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const validate = opts.validate ?? ((raw: string) => assertPublicUrl(raw))
  let currentUrl = rawUrl
  // Per-hop request state: starts as the caller's init and is recomputed after
  // every redirect (see nextHopInit) instead of replayed unchanged — otherwise
  // the caller's headers (possibly Secret Manager values) and body follow the
  // server's Location header to a host the caller never addressed.
  let init: RequestInit = { ...(opts.init ?? {}) }
  for (let hops = 0; hops <= maxRedirects; hops++) {
    const validated = validate(currentUrl)
    const response = await fetch(validated.href, {
      ...init,
      redirect: 'manual',
      signal: opts.abortSignal ?? init.signal,
    })
    // Chrome filters a manual redirect into an opaque-redirect response:
    // status 0, no header list, no readable Location. There is nothing to
    // validate, so the hop is refused rather than followed blind. Checked
    // before the status branch because the filtered response reports status 0.
    if (response.type === 'opaqueredirect') {
      throw new PublicUrlRefusedError(opts.opaqueRedirectError ?? `${label} redirected; redirects are not followed`)
    }
    // Only Fetch's redirect statuses continue the loop. 304 Not Modified, 300
    // Multiple Choices and the rest of the 3xx class are ordinary responses —
    // the caller gets the server's answer instead of a bogus policy refusal.
    if (!REDIRECT_STATUSES.has(response.status)) return response
    const location = response.headers.get('location')
    // A redirect status without Location has no next hop to validate and no
    // next request to make, so it is returned as-is (Fetch: "if locationURL is
    // failure, return response").
    if (!location) return response
    if (hops === maxRedirects) {
      throw new PublicUrlRefusedError(`${label} exceeded ${maxRedirects} redirects`)
    }
    // Resolve relative Location values against the current URL, then the loop
    // head re-validates the absolute target before it is fetched.
    let nextUrl: URL
    try {
      nextUrl = new URL(location, validated)
    } catch {
      throw new PublicUrlRefusedError(`${label} redirect (${response.status}) has an invalid Location header`)
    }
    init = nextHopInit(init, response.status, validated, nextUrl)
    currentUrl = nextUrl.href
  }
  // Unreachable: the loop either returns or throws on hop maxRedirects.
  throw new PublicUrlRefusedError(`${label} redirect loop`)
}

/**
 * The web tool's fetch (web_fetch): gate 1 before the first request, gate 2
 * with per-hop revalidation for every redirect (#157).
 */
export async function fetchPublicWebUrl(
  rawUrl: string,
  init: RequestInit = {},
  abortSignal?: AbortSignal,
): Promise<Response> {
  return fetchPublicUrl(rawUrl, {
    validate: assertPublicWebUrl,
    init,
    abortSignal,
    label: 'Web fetch',
  })
}
