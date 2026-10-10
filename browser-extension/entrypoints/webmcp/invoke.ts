import {
  discoverToolsInTab,
  getRecentRoute,
  getRecentTabsForGroup,
  getTabGroupInfo,
  parseHostname,
  rememberSuccessfulInvocation,
} from './discovery'
import { getRegistryEntries } from './registry'
import { buildSafeFullName } from './tool-name'
import { isHostEnabled, isGroupEnabled, hostDisabledError, groupDisabledError } from './authorization'
import type {
  WebMCPApiMode,
  WebMCPInvokeRequest,
  WebMCPInvokeResponse,
  WebMCPPluginDownloadPlan,
} from './types'
import { runWebMCPPageProbe } from './page-api'
import { WEBMCP_INVOKE_IN_TAB_TYPE } from './relay-protocol'
import { prepareRemoteXiaohongshuImage } from './xiaohongshu-image-transfer'
import { getXhsCdpInput } from './xiaohongshu-cdp-input'
import { isXhsPreparationTool, isXhsInputTool, xhsInputTimeout } from './xiaohongshu-input-protocol'

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
): Promise<{
  ok: boolean
  result?: unknown
  apiMode?: WebMCPApiMode
  errorCode?: string
  error?: string
}> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: {
      ok: boolean
      result?: unknown
      apiMode?: WebMCPApiMode
      errorCode?: string
      error?: string
    }) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const timeoutMs = isXhsInputTool(toolName) ? xhsInputTimeout(toolName) + INVOKE_RELAY_TIMEOUT_MS : INVOKE_RELAY_TIMEOUT_MS
    const timeout = setTimeout(() => {
      finish({
        ok: false,
        errorCode: 'RELAY_TIMEOUT',
        error: `WebMCP relay invoke timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)

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
              errorCode: 'RELAY_UNREACHABLE',
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

async function tabMatchesGroup(tabId: number, groupKey: string, hostname: string): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab.url) return false
    if (parseHostname(tab.url) !== hostname) return false
    const info = await getTabGroupInfo(tabId)
    return info?.groupKey === groupKey
  } catch {
    return false
  }
}

async function pickTargetTabId(
  groupKey: string,
  hostname: string,
  request: WebMCPInvokeRequest,
): Promise<number | null> {
  if (typeof request.requiredTabId === 'number') {
    return (await tabMatchesGroup(request.requiredTabId, groupKey, hostname))
      ? request.requiredTabId
      : null
  }
  if (
    typeof request.preferredTabId === 'number' &&
    (await tabMatchesGroup(request.preferredTabId, groupKey, hostname))
  ) {
    return request.preferredTabId
  }

  // Run-scoped tools stick to the tab that started the run (M-3): the run
  // registry lives in that page's memory, other tabs return Unknown runId.
  const runTab = getRunTab((request.args as any)?.runId)
  if (runTab !== null && (await tabMatchesGroup(runTab, groupKey, hostname))) {
    return runTab
  }

  const recentByTool = getRecentRoute(groupKey, request.fullToolName)
  if (recentByTool && (await tabMatchesGroup(recentByTool.tabId, groupKey, hostname))) {
    return recentByTool.tabId
  }

  for (const recentTab of getRecentTabsForGroup(groupKey)) {
    if (await tabMatchesGroup(recentTab.tabId, groupKey, hostname)) {
      return recentTab.tabId
    }
  }

  const tabs = await chrome.tabs.query({})
  const matched = tabs
    .filter((tab): tab is chrome.tabs.Tab & { id: number; url: string } => {
      return typeof tab.id === 'number' && typeof tab.url === 'string'
    })
    .filter((tab) => parseHostname(tab.url) === hostname)

  if (matched.length === 0) return null

  const sorted = matched.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
  for (const tab of sorted) {
    if (await tabMatchesGroup(tab.id, groupKey, hostname)) return tab.id
  }

  return null
}

async function resolveRouteFromTabs(
  request: WebMCPInvokeRequest,
): Promise<{
  tabId: number
  hostname: string
  groupKey: string
  toolName: string
  fullToolName: string
  toolsetSignature: string
} | null> {
  const candidateTabIds = [
    ...getRecentTabsForGroup(request.groupKey).map((entry) => entry.tabId),
  ]

  if (typeof request.preferredTabId === 'number' && !candidateTabIds.includes(request.preferredTabId)) {
    candidateTabIds.unshift(request.preferredTabId)
  }

  const allTabs = await chrome.tabs.query({})
  const additionalTabIds = allTabs
    .filter((tab): tab is chrome.tabs.Tab & { id: number; url: string } => {
      return typeof tab.id === 'number' && typeof tab.url === 'string'
    })
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .map((tab) => tab.id)

  for (const tabId of additionalTabIds) {
    if (!candidateTabIds.includes(tabId)) candidateTabIds.push(tabId)
  }

  for (const tabId of candidateTabIds) {
    const groupInfo = await getTabGroupInfo(tabId)
    if (!groupInfo || groupInfo.groupKey !== request.groupKey) continue
    const result = await discoverToolsInTab(tabId)
    if (!result.ok || !result.tools) continue
    const matched = result.tools.find((tool) => {
      return buildSafeFullName(groupInfo.hostname, String(tool.name)) === request.fullToolName
    })
    if (!matched) continue
    return {
      tabId,
      hostname: groupInfo.hostname,
      groupKey: groupInfo.groupKey,
      toolName: String(matched.name),
      fullToolName: request.fullToolName,
      toolsetSignature: groupInfo.toolsetSignature,
    }
  }

  return null
}

export async function invokeWebMCPTool(
  request: WebMCPInvokeRequest
): Promise<WebMCPInvokeResponse> {
  // Route via the registry first: the background's tab registry is the
  // authoritative snapshot of which tabs expose which tools. The legacy
  // resolveRouteFromTabs (probe-based) remains as a fallback for tabs the
  // registry hasn't seen (pre-extension-load tabs probed via fallbackScan).
  let route = getRecentRoute(request.groupKey || '', request.fullToolName || '')
  if (!route) {
    const registryEntries = await getRegistryEntries()
    const registryMatch = registryEntries.find(
      (entry) =>
        entry.groupKey === request.groupKey &&
        entry.tools.some((tool) => buildSafeFullName(entry.hostname, tool.name) === request.fullToolName),
    )
    if (registryMatch) {
      const matchedTool = registryMatch.tools.find(
        (tool) => buildSafeFullName(registryMatch.hostname, tool.name) === request.fullToolName,
      )!
      route = {
        tabId: registryMatch.tabId,
        hostname: registryMatch.hostname,
        groupKey: registryMatch.groupKey,
        toolName: matchedTool.name,
        fullToolName: request.fullToolName,
        toolsetSignature: registryMatch.toolsetSignature,
        seenAt: registryMatch.updatedAt,
      }
    }
  }
  if (!route) {
    const resolved = await resolveRouteFromTabs(request)
    if (resolved) {
      rememberSuccessfulInvocation(resolved)
      route = { ...resolved, seenAt: Date.now() }
    }
  }

  if (!route) {
    return {
      ok: false,
      hostname: '',
      toolName: '',
      fullToolName: request.fullToolName || '',
      errorCode: 'INVALID_TOOL_NAME',
      error: 'No route cache entry for tool and group — try re-discovering WebMCP tools',
    }
  }

  const { hostname, toolName, groupKey } = route

  // Authorization gate: per-host opt-out is enforced here, in the extension
  // layer, not just as a UI filter on the web side. Disabled host → refuse
  // before any script is executed in a tab (privacy policy: per-site
  // authorization, revocable at any time).
  if (!(await isHostEnabled(hostname))) {
    return {
      hostname,
      toolName,
      fullToolName: request.fullToolName,
      ...hostDisabledError(hostname),
    }
  }

  // Group gate: same enforcement for per-group opt-out (mirrors the web
  // app's enabledByGroup switches in WebMCPHostList).
  if (groupKey && !(await isGroupEnabled(groupKey))) {
    return {
      hostname,
      toolName,
      fullToolName: request.fullToolName,
      ...groupDisabledError(groupKey),
    }
  }

  const tabId = await pickTargetTabId(groupKey, hostname, request)
  if (tabId === null) {
    return {
      ok: false,
      hostname,
      toolName,
      fullToolName: request.fullToolName,
      errorCode: typeof request.requiredTabId === 'number' ? 'BOUND_TAB_UNAVAILABLE' : 'TOOL_TARGET_NOT_FOUND',
      error: typeof request.requiredTabId === 'number'
        ? 'The bound tab no longer exposes this WebMCP tool group'
        : `No open tab found for WebMCP group: ${groupKey}`,
    }
  }

  let inputSession: string | undefined
  try {
    // Relay channel first (static content scripts, mcp-b style). The legacy
    const isXhsPublish = hostname === 'creator.xiaohongshu.com' && isXhsPreparationTool(toolName)
    const isXhsComment = hostname === 'www.xiaohongshu.com' && toolName === 'xhs_post_comment_to_feed'
    const invokeArgs = isXhsPublish ? { ...await prepareRemoteXiaohongshuImage(request.args || {}) } : { ...request.args || {} }
    // The existing invocation gates and bound-tab routing have already passed.
    // Attach only for the authorized actions that use browser input.
    if (isXhsComment || (isXhsPublish && ['prepare', 'configure'].includes(String(invokeArgs.action)))) {
      inputSession = isXhsComment
        ? await getXhsCdpInput().open(tabId, { hostname, timeoutMs: xhsInputTimeout(toolName) })
        : await getXhsCdpInput().open(tabId)
      invokeArgs._eo2_input_session = inputSession
    }
    if (isXhsPublish && new TextEncoder().encode(JSON.stringify({ type: WEBMCP_INVOKE_IN_TAB_TYPE, toolName, args: invokeArgs })).length >= 64 * 1024 * 1024) {
      return { ok: false, hostname, toolName, fullToolName: request.fullToolName, tabId, errorCode: toolName === 'xhs_publish_video' ? 'VIDEO_MESSAGE_TOO_LARGE' : 'IMAGE_TRANSFER_TOO_LARGE', error: 'File transfer message exceeds Chrome 64 MiB message capacity.' }
    }
    // executeScript probe only runs when the tab has no relay receiver
    // (opened before the extension (re)loaded).
    let result: {
      ok: boolean
      result?: unknown
      apiMode?: WebMCPApiMode
      errorCode?: string
      error?: string
    } = await invokeViaRelay(tabId, toolName, invokeArgs)

    if (
      !isXhsPublish && !isXhsComment && !result.ok &&
      (result.errorCode === 'RELAY_UNREACHABLE' || result.errorCode === 'RELAY_NO_RESPONSE')
    ) {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [{ type: 'invoke', toolName, args: request.args || {} }],
        func: runWebMCPPageProbe,
      })
      result = (results?.[0]?.result as any) || { ok: false, errorCode: 'INVOKE_FAILED', error: 'Tool execution failed' }
    }

    if (!result.ok) {
      return {
        ok: false,
        hostname,
        toolName,
        fullToolName: request.fullToolName,
        tabId,
        apiMode: result.apiMode,
        errorCode: result.errorCode || 'INVOKE_FAILED',
        error: result.error || 'Tool execution failed',
      }
    }

    rememberSuccessfulInvocation({
      tabId,
      hostname,
      groupKey,
      toolName,
      fullToolName: request.fullToolName,
      toolsetSignature: route.toolsetSignature,
    })

    // Record run affinity so run-scoped follow-ups route back to this tab (M-3).
    try {
      const resultObj = JSON.parse(result.result)
      rememberRunTab(resultObj?.runId, tabId)
    } catch {
      // non-JSON result — nothing to pin
    }

    const plan = parsePluginDownloadPlan(result.result)
    return {
      ok: true,
      hostname,
      toolName,
      fullToolName: request.fullToolName,
      tabId,
      apiMode: result.apiMode,
      result: result.result,
      ...(plan ? { pluginDownloadPlan: plan } : {}),
    }
  } catch (error: any) {
    return {
      ok: false,
      hostname,
      toolName,
      fullToolName: request.fullToolName,
      tabId,
      errorCode: 'INVOKE_FAILED',
      error: typeof error?.message === 'string' ? error.message : String(error),
    }
  } finally {
    if (inputSession) await getXhsCdpInput().close(inputSession).catch(() => {})
  }
}
