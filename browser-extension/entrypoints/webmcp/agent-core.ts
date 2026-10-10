// ============================================================
// WebMCP page-agent core — shared page-API resolution logic.
//
// Single source of truth for "how do we read tools off THIS page":
//   1. webmcp-injected.content.ts (static MAIN-world content
//      script, mcp-b style) — uses resolveAgentApi() below.
//   2. page-api.ts's runWebMCPPageProbe — the legacy one-shot
//      probe injected via chrome.scripting.executeScript for
//      tabs opened before the extension (re)loaded (no static
//      content script inside). It must remain DEPENDENCY-FREE:
//      executeScript serializes `func` into the page without
//      any module imports. Both call sites therefore keep
//      inlined copies of the document.modelContext access; keep them
//      semantically in sync.
//
// This module is only imported by the static content script.
// ============================================================

import type { WebMCPApiMode } from './types'
import type { WebMCPAgentToolMeta } from './relay-protocol'

export interface ResolvedAgentApi {
  mode: WebMCPApiMode
  /** Subscribe to toolset changes; returns an unsubscribe. */
  onToolsChanged: (listener: () => void) => () => void
  getTools: () => Promise<WebMCPAgentToolMeta[]>
  executeToolByName: (toolName: string, args: Record<string, unknown>) => Promise<unknown>
}

function normalizeSchema(inputSchema: unknown): Record<string, unknown> {
  if (typeof inputSchema === 'string') {
    try {
      const parsed = JSON.parse(inputSchema)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return { type: 'object', properties: {} }
    }
  }
  if (inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)) {
    return inputSchema as Record<string, unknown>
  }
  return { type: 'object', properties: {} }
}

export function normalizeAgentTools(tools: unknown): WebMCPAgentToolMeta[] {
  if (!Array.isArray(tools)) return []
  return tools
    .filter((tool) => typeof (tool as any)?.name === 'string' && (tool as any).name.trim().length > 0)
    .map((tool: any) => ({
      name: String(tool.name),
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchema: normalizeSchema(tool.inputSchema),
      annotations:
        tool.annotations && typeof tool.annotations === 'object'
          ? {
              readOnlyHint: !!tool.annotations.readOnlyHint,
              untrustedContentHint: !!tool.annotations.untrustedContentHint,
            }
          : undefined,
    }))
}

/** Resolve the current document.modelContext WebMCP API. */
export function resolveAgentApi(): ResolvedAgentApi | null {
  const createImperativeApi = (modelContext: any, mode: WebMCPApiMode) => {
    if (
      !modelContext?.getTools ||
      typeof modelContext.getTools !== 'function' ||
      !modelContext?.executeTool ||
      typeof modelContext.executeTool !== 'function'
    ) {
      return null
    }

    // The v6 polyfill accepts an object. Chromium's native ModelContext
    // currently accepts serialized JSON; select its boundary before execution.
    const ModelContext = (globalThis as any).ModelContext
    const usesNativeInput =
      typeof ModelContext === 'function' &&
      modelContext instanceof ModelContext &&
      Function.prototype.toString.call(ModelContext).includes('[native code]')

    return {
      mode,
      onToolsChanged: (listener: () => void) => {
        // 'toolchange' is the standard WebMCP change event name (spec draft);
        // when the page context lacks event support, the agent falls back
        // to its own diff-polling loop (see webmcp-injected.content.ts).
        const anyCtx = modelContext as any
        if (typeof anyCtx.addEventListener === 'function') {
          anyCtx.addEventListener('toolchange', listener)
          return () => {
            try {
              anyCtx.removeEventListener('toolchange', listener)
            } catch {
              // ignore
            }
          }
        }
        return () => {}
      },
      getTools: async () => normalizeAgentTools(await modelContext.getTools()),
      executeToolByName: async (toolName: string, args: Record<string, unknown>) => {
        const tools = await modelContext.getTools()
        const targetTool = Array.isArray(tools)
          ? tools.find((tool: any) => tool?.name === toolName)
          : null
        if (!targetTool) {
          throw new Error(`Tool not found in tab: ${toolName}`)
        }
        // Keep application arguments in the v6 object format.
        return modelContext.executeTool(targetTool, usesNativeInput ? JSON.stringify(args || {}) : args || {})
      },
    }
  }

  return createImperativeApi((document as any)?.modelContext, 'documentModelContext')
}
