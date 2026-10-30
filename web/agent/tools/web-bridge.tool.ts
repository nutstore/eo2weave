// ============================================================
// Web Bridge Tools — web_search & web_fetch
// Provides web capabilities via the Browser Extension bridge
// (window.__agentWeb).
//
// These tools are only registered when the Browser Extension
// is detected at runtime.
// ============================================================

import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'
import { toolOkJson, toolErrorJson } from './tool-envelope'

// ===========================================================================
// Secret template substitution
// ===========================================================================
//
// Allows web_fetch callers to reference Secret Manager values without exposing
// plaintext to the agent. Templates use the `${SECRET_NAME}` syntax, where
// SECRET_NAME must match the `/^[A-Z][A-Z0-9_]*$/` secret name rule.
//
// Example:
//   headers: { Authorization: `Bearer ${WEREAD_API_KEY}` }
//
// On execution, `${WEREAD_API_KEY}` is resolved against the active project's
// Secret Manager and replaced with the real value before the request is sent.
// Unresolved names are left untouched so the error from the remote endpoint is
// explicit (and never leaks a secret). Resolved secret values are redacted from
// the response returned to the agent.

const SECRET_TEMPLATE_RE = /\$\{([A-Z][A-Z0-9_]*)\}/g

/** Names that match the secret-name rule but are commonly used as plain template vars. */
const RESERVED_ENV_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LANG', 'SHELL', 'PWD', 'TMPDIR',
])

/**
 * Whether any `${NAME}` template referencing a Secret Manager entry appears in
 * the value. Pure check (no decryption) — used to decide whether we need to
 * hit the secret store at all.
 *
 * Exported for unit tests.
 */
export function referencesSecretTemplate(value: unknown): boolean {
  if (typeof value !== 'string') return false
  let m: RegExpExecArray | null
  SECRET_TEMPLATE_RE.lastIndex = 0
  while ((m = SECRET_TEMPLATE_RE.exec(value)) !== null) {
    const name = m[1]
    if (!RESERVED_ENV_NAMES.has(name)) return true
  }
  return false
}

/**
 * Collect every `${SECRET_NAME}` referenced across headers + body so we can
 * batch-decrypt them in one pass.
 *
 * Exported for unit tests.
 */
export function collectSecretNames(
  headers: Record<string, string> | undefined,
  body: string | undefined,
): string[] {
  const names = new Set<string>()
  const scan = (text: string) => {
    let m: RegExpExecArray | null
    SECRET_TEMPLATE_RE.lastIndex = 0
    while ((m = SECRET_TEMPLATE_RE.exec(text)) !== null) {
      const name = m[1]
      if (!RESERVED_ENV_NAMES.has(name)) names.add(name)
    }
  }
  if (headers) for (const v of Object.values(headers)) if (typeof v === 'string') scan(v)
  if (body) scan(body)
  return [...names]
}

/**
 * Resolve a set of secret names from the agent run's project's Secret Manager.
 * Returns a map of name -> plaintext value for the names that exist.
 */
async function resolveSecrets(
  projectId: string | null | undefined,
  names: string[],
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>()
  if (names.length === 0) return resolved
  try {
    const { loadSecret } = await import('@/security/secret-store')
    // loadSecret falls back to the global scope when the project-scoped key is
    // missing, so even without a project we can resolve global secrets.
    const pid = projectId || ''
    await Promise.all(
      names.map(async (name) => {
        const value = await loadSecret(pid, name)
        if (value) resolved.set(name, value)
      }),
    )
  } catch (error) {
    // Secret resolution must never break an otherwise valid request. Unresolved
    // templates stay literal so the error from the endpoint is explicit.
    console.warn('[web_fetch] Secret resolution failed; templates left literal:', error)
  }
  return resolved
}

/** Replace every `${NAME}` with its resolved value (or leave literal if missing). Exported for unit tests. */
export function applySecrets(
  text: string,
  secrets: Map<string, string>,
): { text: string; resolvedValues: string[] } {
  const resolvedValues: string[] = []
  const out = text.replace(SECRET_TEMPLATE_RE, (full, name: string) => {
    const val = secrets.get(name)
    if (val) {
      resolvedValues.push(val)
      return val
    }
    return full
  })
  return { text: out, resolvedValues }
}

/** Redact known secret values from a string so they never reach the agent. Exported for unit tests. */
export function redactSecrets(text: string, secretValues: string[]): string {
  return secretValues.reduce(
    (safe, s) => (s ? safe.split(s).join('[REDACTED]') : safe),
    text,
  )
}

/** Redact resolved secret values from response headers before returning them to the agent. */
export function redactSecretHeaders(
  headers: Record<string, string>,
  secretValues: string[],
): Record<string, string> {
  if (secretValues.length === 0) return headers
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, redactSecrets(value, secretValues)]),
  )
}

// ---------------------------------------------------------------------------
// Types for the browser extension bridge API
// ---------------------------------------------------------------------------

interface AgentWebSearchResult {
  title: string
  url: string
  snippet: string
}

interface AgentWebSearchResponse {
  ok: boolean
  results: AgentWebSearchResult[]
  provider?: string
  /** The provider the caller originally asked for (before any fallback). */
  requestedProvider?: string
  /** True iff `provider` differs from `requestedProvider` (i.e. a fallback occurred). */
  fallback?: boolean
  /** Only present when ok:false — per-provider trial log for diagnosis. */
  attempts?: Array<{ provider: string; ok: boolean; reason?: string; resultCount?: number }>
  /** Alternate provider callers may explicitly retry after a strict-provider failure. */
  suggestedProvider?: string
  /** Machine-readable failure reason supplied by the extension. */
  reason?: string
  error?: string
}

interface AgentWebFetchResponse {
  ok: boolean
  status: number
  headers: Record<string, string>
  body: string
  /** Final URL after redirects (the base used to resolve relative links). */
  finalUrl?: string
  truncated?: boolean
  readability?: {
    title: string
    excerpt: string
    byline: string
    siteName: string
    length: number
  }
  error?: string
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

function getAgentWeb() {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { __agentWeb?: { ready: boolean; search: unknown; fetch: unknown } }
  return w.__agentWeb?.ready ? w.__agentWeb as {
    search: (query: string, options?: { count?: number; provider?: string }) => Promise<AgentWebSearchResponse>
    fetch: (url: string, options?: {
      method?: string
      headers?: Record<string, string>
      body?: string | null
      render?: boolean
    }) => Promise<AgentWebFetchResponse>
  } : null
}

/** Check if the Browser Extension bridge is available */
export function isWebBridgeAvailable(): boolean {
  return getAgentWeb() !== null
}

// ===========================================================================
// web_search
// ===========================================================================

export const webSearchDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'web_search',
    description: [
      'Search the web. Returns a list of results with title, URL, and snippet.',
      'Use this tool to find information on the internet, look up documentation, research topics, or find specific URLs.',
      'The search engine is auto-selected based on your region (DuckDuckGo for overseas, Baidu for China).',
      '',
      'IMPORTANT — provider policy:',
      '  - `provider: "auto"` may fall back between engines when one fails or returns no results.',
      '  - An explicit `provider: "duckduckgo"` or `"baidu"` is strict and never falls back.',
      '    If unavailable, the error supplies `suggestedProvider`; retry explicitly only if appropriate.',
      'For automatic fallback, inspect `fallback`, `requestedProvider`, and `provider` and tell the',
      'user which engine actually produced the results.',
      '',
      'This tool requires the Browser Extension to be installed and active.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string',
        },
        count: {
          type: 'number',
          description: 'Number of results to return (default: 10, max: 20)',
        },
        provider: {
          type: 'string',
          description: [
            'Search engine to use. Default: auto (region-detected).',
            'Options: "auto" (recommended), "duckduckgo", "baidu".',
            'Set explicitly only when you need to override the auto-detected engine.',
          ].join('\n'),
          enum: ['auto', 'duckduckgo', 'baidu'],
        },
      },
      required: ['query'],
    },
  },
}

export const webSearchExecutor: ToolExecutor = async (args) => {
  const bridge = getAgentWeb()
  if (!bridge) {
    return toolErrorJson('web_search', 'BRIDGE_UNAVAILABLE', 'Browser Extension not detected. Please install and enable the extension to use web search.')
  }

  const query = args.query as string
  if (!query || typeof query !== 'string') {
    return toolErrorJson('web_search', 'INVALID_INPUT', 'query must be a non-empty string')
  }

  const count = typeof args.count === 'number' ? Math.min(args.count, 20) : 10
  const provider = typeof args.provider === 'string' ? args.provider : 'auto'

  try {
    const result = await bridge.search(query, { count, provider })

    if (!result.ok) {
      if (result.provider && result.suggestedProvider) {
        return toolErrorJson(
          'web_search',
          'SEARCH_PROVIDER_UNAVAILABLE',
          result.error || `${result.provider} is unavailable. Try ${result.suggestedProvider}.`,
          {
            retryable: true,
            details: {
              provider: result.provider,
              suggestedProvider: result.suggestedProvider,
              ...(result.reason ? { reason: result.reason } : {}),
            },
          }
        )
      }
      return toolErrorJson('web_search', 'SEARCH_FAILED', result.error || 'Search returned no results', { retryable: true })
    }

    return toolOkJson('web_search', {
      results: result.results,
      total: result.results.length,
      ...(result.provider ? { provider: result.provider } : {}),
      ...(result.requestedProvider ? { requestedProvider: result.requestedProvider } : {}),
      ...(typeof result.fallback === 'boolean' ? { fallback: result.fallback } : {}),
      ...(result.attempts ? { attempts: result.attempts } : {}),
    })
  } catch (err) {
    return toolErrorJson('web_search', 'SEARCH_ERROR', (err as Error).message, { retryable: true })
  }
}

// ===========================================================================
// web_fetch
// ===========================================================================

export const webFetchDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'web_fetch',
    description: [
      'Fetch a URL and return its content. Handles both web pages and API endpoints.',
      '',
      'For HTML pages: extracts the main article content (removes ads, navigation, sidebars, footers) using Mozilla Readability, then converts to clean Markdown. If the page is a JS-heavy SPA that returns an empty shell via HTTP, automatically retries with a hidden browser tab for full JavaScript rendering.',
      'For non-HTML responses (JSON, XML, plain text, images, etc.): returns the raw body verbatim with no transformation — this preserves structured data, so it is safe to use for API calls.',
      'The content-type header determines which mode is used; you do not need to specify it.',
      '',
      'You can set render=true to force JavaScript rendering (useful when you know the page is an SPA like a React/Vue app).',
      '',
      'Returns: body (Markdown for HTML, raw for everything else), HTTP status, headers, and readability metadata (title, excerpt, byline) for HTML pages.',
      '',
      'This tool requires the Browser Extension to be installed and active.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
        method: {
          type: 'string',
          description: 'HTTP method (default: GET)',
          enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'],
        },
        headers: {
          type: 'object',
          description: [
            'Request headers as key-value pairs.',
            '',
            'Secret template support: reference Secret Manager values with the `${SECRET_NAME}`',
            'syntax and they will be resolved from the active project\'s Secret Manager at',
            'execution time. The plaintext never needs to be (and never should be) typed into the',
            'conversation. Example:',
            '  headers: { Authorization: "Bearer ${WEREAD_API_KEY}" }',
            'Unresolved names are left literal so the remote endpoint\'s error is explicit. Resolved',
            'secret values are redacted from the response returned to the caller.',
          ].join('\n'),
          properties: {},
        },
        body: {
          type: 'string',
          description: [
            'Request body (for POST/PUT/PATCH).',
            'Also supports `${SECRET_NAME}` template substitution against Secret Manager.',
          ].join('\n'),
        },
        render: {
          type: 'boolean',
          description: [
            'Force full JavaScript rendering via a hidden browser tab.',
            'Set to true for JS-heavy SPA pages (e.g. React/Vue apps that return an empty HTML shell).',
            'Default: false (fast HTTP fetch). The tool also auto-detects SPA shells and retries with rendering automatically.',
          ].join('\n'),
        },
      },
      required: ['url'],
    },
  },
}

export const webFetchExecutor: ToolExecutor = async (args, context) => {
  const bridge = getAgentWeb()
  if (!bridge) {
    return toolErrorJson('web_fetch', 'BRIDGE_UNAVAILABLE', 'Browser Extension not detected. Please install and enable the extension to use web fetch.')
  }

  const url = args.url as string
  if (!url || typeof url !== 'string') {
    return toolErrorJson('web_fetch', 'INVALID_INPUT', 'url must be a non-empty string')
  }

  // Validate URL format
  try {
    new URL(url)
  } catch {
    return toolErrorJson('web_fetch', 'INVALID_URL', `Invalid URL format: ${url}`)
  }

  const options: {
    method?: string
    headers?: Record<string, string>
    body?: string | null
    render?: boolean
  } = {}

  if (args.method && typeof args.method === 'string') options.method = args.method
  // --- Secret template substitution ---
  // Resolve `${SECRET_NAME}` references in headers + body against the active
  // project's Secret Manager, so callers never have to paste plaintext secrets.
  const headers = (args.headers && typeof args.headers === 'object')
    ? { ...(args.headers as Record<string, string>) }
    : undefined
  let body = (args.body !== undefined && args.body !== null) ? String(args.body) : undefined

  let resolvedSecretValues: string[] = []
  const needsSecrets =
    (headers && Object.values(headers).some((v) => referencesSecretTemplate(v))) ||
    (body !== undefined && referencesSecretTemplate(body))
  // Standalone chats (directMode) run under the hidden host project's id, so
  // resolving secrets against context.projectId would leak the HOST project's
  // secrets into an outbound request the host user never authored. In
  // directMode we skip resolution entirely: templates stay literal and the
  // endpoint's error makes the unresolved reference explicit (never a leak).
  if (needsSecrets && !context.directMode) {
    const names = collectSecretNames(headers, body)
    const secrets = await resolveSecrets(context.projectId, names)
    const collected: string[] = []
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        const { text, resolvedValues } = applySecrets(v, secrets)
        headers[k] = text
        collected.push(...resolvedValues)
      }
    }
    if (body !== undefined) {
      const { text, resolvedValues } = applySecrets(body, secrets)
      body = text
      collected.push(...resolvedValues)
    }
    resolvedSecretValues = collected
  }

  if (headers) options.headers = headers
  if (body !== undefined) options.body = body
  if (typeof args.render === 'boolean') options.render = args.render

  try {
    const result = await bridge.fetch(url, options)

    if (!result.ok && result.status === 0) {
      return toolErrorJson('web_fetch', 'FETCH_ERROR', result.error || 'Failed to fetch URL', { retryable: true })
    }

    // Redact resolved secret values from the response so plaintext never reaches
    // the agent (defense-in-depth: remote endpoints occasionally echo tokens).
    const safeBody = resolvedSecretValues.length
      ? redactSecrets(result.body, resolvedSecretValues)
      : result.body

    return toolOkJson('web_fetch', {
      status: result.status,
      headers: redactSecretHeaders(result.headers, resolvedSecretValues),
      body: safeBody,
      ...(result.finalUrl ? { finalUrl: result.finalUrl } : {}),
      ...(result.truncated ? { truncated: true } : {}),
      ...(result.readability ? { readability: result.readability } : {}),
      ...(resolvedSecretValues.length ? { secretsResolved: resolvedSecretValues.length } : {}),
    })
  } catch (err) {
    return toolErrorJson('web_fetch', 'FETCH_ERROR', (err as Error).message, { retryable: true })
  }
}

export const webBridgePromptDoc: ToolPromptDoc = {
  category: 'web',
  section: '### Web Tools (requires Browser Extension)',
  lines: [
    '- `web_search(query, count?, provider?)` - Search the web (auto-selects DuckDuckGo or Baidu based on region)',
    '- `web_fetch(url, ...)` - Fetch the content of a web page by URL',
  ],
}
