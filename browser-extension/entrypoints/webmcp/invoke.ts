import {
  currentAdapterCatalogForTab,
  discoverToolsInTab,
  parseHostname,
  parseOrigin,
} from './discovery'
import { getRegistryEntries } from './registry'
import { isHostEnabled, hostDisabledError } from './authorization'
import type {
  WebMCPApiMode,
  WebMCPInvokeRequest,
  WebMCPInvokeResponse,
  WebMCPPluginDownloadPlan,
} from './types'
import { runWebMCPPageProbe } from './page-api'
import { WEBMCP_INVOKE_IN_TAB_TYPE } from './relay-protocol'
import type { ExecutionResult } from '@creatorweave/quickjs-runtime'

let invokeAdapter: ((tabId: number, name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<ExecutionResult | null>) | undefined
export function installAdapterInvoker(invoke: NonNullable<typeof invokeAdapter>) {
  invokeAdapter = invoke
}

// Relay-channel invoke timeout. Longer than the old executeScript path
// (which serialized the whole probe func) because tools may legitimately
// take a while (navigation-triggering tools, downloads, …).
const INVOKE_RELAY_TIMEOUT_MS = 60_000

// runId → tabId affinity (M-3): run-scoped tools (get_run_status /
// get_run_progress / cancel_run) must land on the SAME tab whose page holds
// the in-memory run registry, even with multiple tabs of the same app open.
const RUN_TAB_AFFINITY = new Map<string, { tabId: number; at: number }>()
const RUN_TAB_AFFINITY_MAX = 200
function rememberRunTab(runId: unknown, tabId: number): void {
  if (typeof runId !== 'string' || runId.length === 0) return
  if (RUN_TAB_AFFINITY.size >= RUN_TAB_AFFINITY_MAX) {
    // drop oldest
    let oldest: string | null = null
    let oldestAt = Infinity
    for (const [k, v] of RUN_TAB_AFFINITY) {
      if (v.at < oldestAt) {
        oldestAt = v.at
        oldest = k
      }
    }
    if (oldest) RUN_TAB_AFFINITY.delete(oldest)
  }
  RUN_TAB_AFFINITY.set(runId, { tabId, at: Date.now() })
}
function getRunTab(runId: unknown): number | null {
  if (typeof runId !== 'string') return null
  const hit = RUN_TAB_AFFINITY.get(runId)
  return hit ? hit.tabId : null
}

/**
 * Invoke via the static content-script relay (mcp-b style):
 * background → tabs.sendMessage(webmcp_invoke_in_tab) → ISOLATED relay
 * → window.postMessage → MAIN agent → executeToolByName → response.
 * Only tabs WITHOUT the static scripts (opened before extension load)
 * fall back to the legacy chrome.scripting.executeScript probe.
 */
async function invokeViaRelay(
  tabId: number,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  result?: unknown
  apiMode?: WebMCPApiMode
  errorCode?: string
  error?: string
}> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason ?? new Error('WebMCP invocation canceled'))
    }
    const finish = (value: {
      ok: boolean
      result?: unknown
      apiMode?: WebMCPApiMode
      errorCode?: string
      error?: string
    }) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      resolve(value)
    }

    const timeout = setTimeout(() => {
      finish({
        ok: false,
        errorCode: 'RELAY_TIMEOUT',
        error: `WebMCP relay invoke timed out after ${INVOKE_RELAY_TIMEOUT_MS}ms`,
      })
    }, INVOKE_RELAY_TIMEOUT_MS)

    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    try {
      chrome.tabs.sendMessage(
        tabId,
        { type: WEBMCP_INVOKE_IN_TAB_TYPE, toolName, args },
        (response: any) => {
          clearTimeout(timeout)
          if (chrome.runtime.lastError) {
            // No receiver (tab without our content scripts) or channel closed.
            finish({
              ok: false,
              errorCode: /receiving end does not exist/i.test(chrome.runtime.lastError.message || '') ? 'RELAY_UNREACHABLE' : 'RELAY_DISCONNECTED',
              error: chrome.runtime.lastError.message || 'relay unreachable',
            })
            return
          }
          if (!response) {
            finish({ ok: false, errorCode: 'RELAY_NO_RESPONSE', error: 'Empty relay response' })
            return
          }
          finish({
            ok: response.ok === true,
            result: response.result,
            apiMode: response.apiMode,
            errorCode: response.errorCode,
            error: response.error,
          })
        },
      )
    } catch (error: any) {
      clearTimeout(timeout)
      finish({
        ok: false,
        errorCode: 'RELAY_ERROR',
        error: typeof error?.message === 'string' ? error.message : String(error),
      })
    }
  })
}

/** Exact-tab execution shared by routed calls and the browser command API.
 * Cancellation stops waiting for native page tools; their side effects may finish.
 */
export async function executeWebMCPToolInTab(
  tabId: number,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  adapterOnly = false,
) {
  signal?.throwIfAborted()
  // Relay channel first (static content scripts, mcp-b style). The legacy
  // executeScript probe only runs when the tab has no relay receiver
  // (opened before the extension (re)loaded).
  let result: {
    ok: boolean
    result?: unknown
    apiMode?: WebMCPApiMode
    errorCode?: string
    error?: string
  }
  const adapter = await invokeAdapter?.(tabId, toolName, args, signal)
  if (adapter) {
    result = adapter.ok
      ? { ok: true, result: adapter.value, apiMode: 'documentModelContext' }
      : { ok: false, errorCode: adapter.error.code, error: adapter.error.message }
  } else {
    signal?.throwIfAborted()
    if (adapterOnly) return { ok: false, errorCode: 'ADAPTER_UNAVAILABLE', error: 'Adapter registration is no longer available for this tab' }
    result = await invokeViaRelay(tabId, toolName, args, signal)
  }

  if (
    !result.ok &&
    result.errorCode === 'RELAY_UNREACHABLE'
  ) {
    signal?.throwIfAborted()
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [{ type: 'invoke', toolName, args }],
      func: runWebMCPPageProbe,
    })
    result = (results?.[0]?.result as any) || { ok: false, errorCode: 'INVOKE_FAILED', error: 'Tool execution failed' }
  }

  signal?.throwIfAborted()
  return result
}

function randomTransferId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `tr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function unwrapPluginDownloadPayload(result: unknown): Record<string, unknown> | null {
  if (!result) return null

  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return null
    }
    return null
  }

  if (typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>
  }

  return null
}

function parsePluginDownloadPlan(result: unknown): WebMCPPluginDownloadPlan | null {
  const obj = unwrapPluginDownloadPayload(result)
  if (!obj) {
    return null
  }

  const pluginDownload = obj.plugin_download
  const downloadUrl = obj.download_url
  const savePath = obj.save_path
  const fileNameRaw = obj.fileName ?? obj.file_name
  if (pluginDownload !== true) return null
  if (typeof downloadUrl !== 'string' || downloadUrl.trim().length === 0) return null
  if (typeof fileNameRaw !== 'string' || fileNameRaw.trim().length === 0) return null

  const normalizedSavePath =
    typeof savePath === 'string' && savePath.trim().length > 0 ? savePath.trim() : '/'

  return {
    transferId: randomTransferId(),
    downloadUrl: downloadUrl.trim(),
    savePath: normalizedSavePath,
    fileName: fileNameRaw.trim(),
    originalResult: { ...obj },
  }
}

export async function invokeWebMCPTool(
  request: WebMCPInvokeRequest
): Promise<WebMCPInvokeResponse> {
  const targetTabId = request.targetTabId
  const requestedOrigin = typeof request.origin === 'string' ? request.origin.trim() : ''
  const toolName = typeof request.toolName === 'string' ? request.toolName.trim() : ''

  if (!Number.isSafeInteger(targetTabId) || targetTabId <= 0) {
    return {
      ok: false,
      origin: requestedOrigin,
      hostname: '',
      toolName: '',
      errorCode: 'INVALID_TAB',
      error: 'WebMCP invocation requires a positive exact targetTabId',
    }
  }
  if (!requestedOrigin || !toolName) {
    return {
      ok: false,
      origin: requestedOrigin,
      hostname: '',
      toolName,
      errorCode: !requestedOrigin ? 'INVALID_ORIGIN' : 'INVALID_TOOL_NAME',
      error: !requestedOrigin
        ? 'WebMCP invocation requires the expected page origin'
        : 'WebMCP invocation requires an exact raw tool name',
      tabId: targetTabId,
    }
  }

  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(targetTabId)
  } catch {
    return {
      ok: false,
      origin: requestedOrigin,
      hostname: '',
      toolName,
      tabId: targetTabId,
      errorCode: 'TARGET_TAB_NOT_FOUND',
      error: `Target tab ${targetTabId} is no longer open`,
    }
  }
  const liveOrigin = parseOrigin(tab.url || '')
  const hostname = parseHostname(tab.url || '')
  if (!liveOrigin || !hostname) {
    return {
      ok: false,
      origin: requestedOrigin,
      hostname: '',
      toolName,
      tabId: targetTabId,
      errorCode: 'UNSUPPORTED_URL',
      error: 'WebMCP requires an HTTP(S) target tab',
    }
  }
  if (liveOrigin !== requestedOrigin) {
    return {
      ok: false,
      origin: requestedOrigin,
      hostname,
      toolName,
      tabId: targetTabId,
      errorCode: 'TARGET_ORIGIN_MISMATCH',
      error: `Target tab ${targetTabId} is now on ${liveOrigin}, not ${requestedOrigin}`,
    }
  }

  if (!(await isHostEnabled(hostname))) {
    return {
      origin: liveOrigin,
      hostname,
      toolName,
      tabId: targetTabId,
      ...hostDisabledError(hostname),
    }
  }

  const entries = await getRegistryEntries()
  const entry = entries.find((candidate) => candidate.tabId === targetTabId)
  const registeredTool = entry?.origin === liveOrigin
    ? entry.tools.find((tool) => tool.name === toolName)
    : undefined
  let registered = !!registeredTool

  // Registry-silent tabs opened before the extension reload are probed only
  // on their exact target tab. A failure never expands to another tab.
  if (!registered) {
    const probe = await discoverToolsInTab(targetTabId)
    registered = probe.ok === true && (probe.tools || []).some((tool) => String(tool.name) === toolName)
  }
  if (!registered) {
    return {
      ok: false,
      origin: liveOrigin,
      hostname,
      toolName,
      tabId: targetTabId,
      errorCode: 'TOOL_NOT_FOUND',
      error: `Tool "${toolName}" is not currently exposed by tab ${targetTabId}`,
    }
  }

  // Stale adapter provenance guard (Sourcery round-5): a registry entry can
  // still carry a name marked adapter-owned after the catalog dropped the
  // route (reconciliation happens on the next adapter-merge discovery, not
  // on the drop itself). The authorization prompt for such a call was built
  // from the adapter's previously trusted description; letting
  // executeWebMCPToolInTab fall back to the page relay when invokeAdapter
  // returns null would run a colliding PAGE tool under that adapter copy.
  // Revalidate against the CURRENT catalog: when the route is gone, reject
  // the call outright — no page fallback for a stale adapter-served name.
  if (registeredTool?.adapterOwned) {
    const catalog = await currentAdapterCatalogForTab(targetTabId)
    if (!catalog?.some((tool) => tool.name === toolName)) {
      return {
        ok: false,
        origin: liveOrigin,
        hostname,
        toolName,
        tabId: targetTabId,
        errorCode: 'TOOL_NOT_FOUND',
        error: `Adapter route for "${toolName}" is no longer available on tab ${targetTabId}`,
      }
    }
  }

  const runId = (request.args as Record<string, unknown> | undefined)?.runId
  const affinityTabId = getRunTab(runId)
  if (affinityTabId !== null && affinityTabId !== targetTabId) {
    return {
      ok: false,
      origin: liveOrigin,
      hostname,
      toolName,
      tabId: targetTabId,
      errorCode: 'RUN_TARGET_MISMATCH',
      error: `Run "${String(runId)}" belongs to tab ${affinityTabId}, not tab ${targetTabId}`,
    }
  }

  try {
    const result = await executeWebMCPToolInTab(targetTabId, toolName, request.args || {})

    if (!result.ok) {
      return {
        ok: false,
        origin: liveOrigin,
        hostname,
        toolName,
        tabId: targetTabId,
        apiMode: result.apiMode,
        errorCode: result.errorCode || 'INVOKE_FAILED',
        error: result.error || 'Tool execution failed',
      }
    }

    // Record run affinity so run-scoped follow-ups reject a different tab
    // instead of silently switching page-memory contexts.
    try {
      const resultObj = typeof result.result === 'string' ? JSON.parse(result.result) : result.result as { runId?: string } | null
      rememberRunTab(resultObj?.runId, targetTabId)
    } catch {
      // non-JSON result — nothing to pin
    }

    const plan = parsePluginDownloadPlan(result.result)
    return {
      ok: true,
      origin: liveOrigin,
      hostname,
      toolName,
      tabId: targetTabId,
      apiMode: result.apiMode,
      result: result.result,
      ...(plan ? { pluginDownloadPlan: plan } : {}),
    }
  } catch (error: any) {
    return {
      ok: false,
      origin: liveOrigin,
      hostname,
      toolName,
      tabId: targetTabId,
      errorCode: 'INVOKE_FAILED',
      error: typeof error?.message === 'string' ? error.message : String(error),
    }
  }
}
