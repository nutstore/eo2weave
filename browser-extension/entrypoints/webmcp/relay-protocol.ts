// ============================================================
// WebMCP agent relay protocol — shared between:
//   - webmcp-injected.content.ts (MAIN world page agent)
//   - webmcp.content.ts (ISOLATED world relay)
//   - registry.ts (background tab registry)
//
// Modeled after @mcp-b's Tab transport handshake (see
// docs.mcp-b.ai/packages/transports): a MAIN-world "server"
// broadcasts readiness + tool snapshots, an isolated "client"
// relays them to the extension, and the extension can push
// commands (ping / invoke) back into the page. We implement a
// minimal subset (no JSON-RPC envelope, no protocol negotiation)
// because our per-page surface is just "list tools / call tool".
//
// This module must stay dependency-free (types/constants only)
// so both content-script bundles can import it cheaply.
// ============================================================

import type { WebMCPApiMode } from './types'

/** Envelope marker. `window.postMessage` events carrying this flag belong to us. */
export const CW_WEBMCP_AGENT_MARKER = '__cwWebmcpAgent'

export const WEBMCP_INVOKE_RELAY_TIMEOUT_MS = 60_000
export const WEBMCP_PING_RELAY_TIMEOUT_MS = 1_500

export interface WebMCPAgentToolMeta {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: {
    readOnlyHint?: boolean
    untrustedContentHint?: boolean
  }
}

// ── MAIN → ISOLATED (page → relay) ──

/** Fired at agent boot (document_idle) with the first tool snapshot. */
export interface WebMCPAgentReadyEvent {
  kind: 'ready'
  tools: WebMCPAgentToolMeta[]
  apiMode?: WebMCPApiMode
}

/** Fired whenever the page's toolset changes (toolchange event or poll diff). */
export interface WebMCPAgentSnapshotEvent {
  kind: 'snapshot'
  tools: WebMCPAgentToolMeta[]
  apiMode?: WebMCPApiMode
}

/** Reply to an invoke-request. */
export interface WebMCPAgentInvokeResponseEvent {
  kind: 'invoke-response'
  requestId: string
  ok: boolean
  result?: unknown
  apiMode?: WebMCPApiMode
  errorCode?: string
  error?: string
}

export type WebMCPAgentEventToRelay =
  | WebMCPAgentReadyEvent
  | WebMCPAgentSnapshotEvent
  | WebMCPAgentInvokeResponseEvent

// ── ISOLATED → MAIN (relay → page) ──

/** Ask the agent to re-probe and emit a fresh snapshot. */
export interface WebMCPRelayPingCommand {
  kind: 'ping'
}

/** Ask the page to execute one tool. */
export interface WebMCPRelayInvokeCommand {
  kind: 'invoke-request'
  requestId: string
  toolName: string
  args: Record<string, unknown>
}

// ── recipe commands (ISOLATED → MAIN, consent-gated) ──
// Sent by the ISOLATED bridge only after storage.local shows
// the user enabled the recipe for this hostname. The MAIN-world
// recipe injector validates the recipe id against its own list.

/** Enable + register a recipe's tools on this page. */
export interface WebMCPRelayRecipeActivateCommand {
  kind: 'recipe-activate'
  recipeId: string
}

/** Unregister the current recipe's tools. */
export interface WebMCPRelayRecipeDeactivateCommand {
  kind: 'recipe-deactivate'
}

export type WebMCPRelayCommandToAgent =
  | { kind: 'adapters-sync'; adapters: unknown[] }
  | WebMCPRelayPingCommand
  | WebMCPRelayInvokeCommand
  | WebMCPRelayRecipeActivateCommand
  | WebMCPRelayRecipeDeactivateCommand

// ── runtime message types (ISOLATED ↔ background) ──

/** Relay → background: this tab currently exposes these tools. */
export const WEBMCP_TAB_REPORT_TYPE = 'webmcp_tab_report'

/** Background → relay: execute a tool in this tab (async sendResponse). */
export const WEBMCP_INVOKE_IN_TAB_TYPE = 'webmcp_invoke_in_tab'

/** Background → relay: ask the page agent for a fresh snapshot. */
export const WEBMCP_PING_IN_TAB_TYPE = 'webmcp_ping_in_tab'

/** Background → popup: registry changed, re-read the snapshot. */
export const WEBMCP_REGISTRY_UPDATED_TYPE = 'webmcp_registry_updated'

// ── guards ──

function isAgentToolMeta(value: unknown): value is WebMCPAgentToolMeta {
  if (!value || typeof value !== 'object') return false
  const tool = value as Record<string, unknown>
  return typeof tool.name === 'string' && tool.name.trim().length > 0
}

/** Structural validation for events the relay accepts from the page. */
const MAX_TOOLS_PER_EVENT = 100
const MAX_TOOL_DESCRIPTION_CHARS = 2_000

function clampToolMeta(tool: WebMCPAgentToolMeta): WebMCPAgentToolMeta {
  const description =
    typeof tool.description === 'string' && tool.description.length > MAX_TOOL_DESCRIPTION_CHARS
      ? tool.description.slice(0, MAX_TOOL_DESCRIPTION_CHARS)
      : tool.description
  return { ...tool, description }
}

export function parseAgentEvent(data: unknown): WebMCPAgentEventToRelay | null {
  if (!data || typeof data !== 'object') return null
  const event = data as Record<string, unknown>
  if (event[CW_WEBMCP_AGENT_MARKER] !== true) return null

  if (event.kind === 'ready' || event.kind === 'snapshot') {
    if (!Array.isArray(event.tools)) return null
    const tools = event.tools.filter(isAgentToolMeta).slice(0, MAX_TOOLS_PER_EVENT).map(clampToolMeta)
    return {
      kind: event.kind,
      tools,
      apiMode: typeof event.apiMode === 'string' ? (event.apiMode as WebMCPApiMode) : undefined,
    }
  }

  if (event.kind === 'invoke-response') {
    if (typeof event.requestId !== 'string' || event.requestId.length === 0) return null
    return {
      kind: 'invoke-response',
      requestId: event.requestId,
      ok: event.ok === true,
      result: event.result,
      apiMode: typeof event.apiMode === 'string' ? (event.apiMode as WebMCPApiMode) : undefined,
      errorCode: typeof event.errorCode === 'string' ? event.errorCode : undefined,
      error: typeof event.error === 'string' ? event.error : undefined,
    }
  }

  return null
}

/** Structural validation for commands the page agent accepts from the relay. */
export function parseRelayCommand(data: unknown): WebMCPRelayCommandToAgent | null {
  if (!data || typeof data !== 'object') return null
  const command = data as Record<string, unknown>
  if (command[CW_WEBMCP_AGENT_MARKER] !== true) return null

  if (command.kind === 'adapters-sync' && Array.isArray(command.adapters)) return { kind: 'adapters-sync', adapters: command.adapters }

  if (command.kind === 'ping') return { kind: 'ping' }

  if (command.kind === 'recipe-activate') {
    if (typeof command.recipeId !== 'string' || command.recipeId.length === 0) return null
    return { kind: 'recipe-activate', recipeId: command.recipeId }
  }

  if (command.kind === 'recipe-deactivate') return { kind: 'recipe-deactivate' }

  if (command.kind === 'invoke-request') {
    if (typeof command.requestId !== 'string' || command.requestId.length === 0) return null
    if (typeof command.toolName !== 'string' || command.toolName.length === 0) return null
    const args =
      command.args && typeof command.args === 'object' && !Array.isArray(command.args)
        ? (command.args as Record<string, unknown>)
        : {}
    return { kind: 'invoke-request', requestId: command.requestId, toolName: command.toolName, args }
  }

  return null
}

/** Attach the envelope marker before window.postMessage. */
export function buildAgentEnvelope(
  event: WebMCPAgentEventToRelay
): Record<string, unknown> & { [CW_WEBMCP_AGENT_MARKER]: true } {
  return { [CW_WEBMCP_AGENT_MARKER]: true, ...event }
}

export function buildRelayEnvelope(
  command: WebMCPRelayCommandToAgent
): Record<string, unknown> & { [CW_WEBMCP_AGENT_MARKER]: true } {
  return { [CW_WEBMCP_AGENT_MARKER]: true, ...command }
}
