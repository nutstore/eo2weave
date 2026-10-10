import type { WebMCPApiMode } from './types'

type WebMCPToolMeta = {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: {
    readOnlyHint?: boolean
    untrustedContentHint?: boolean
  }
}

type DiscoverProbeResult = {
  ok: boolean
  mode?: WebMCPApiMode
  tools?: WebMCPToolMeta[]
  error?: string
}

type InvokeProbeResult = {
  ok: boolean
  apiMode?: WebMCPApiMode
  result?: unknown
  errorCode?: string
  error?: string
}

type PageProbeRequest =
  | {
      type: 'discover'
    }
  | {
      type: 'invoke'
      toolName: string
      args: Record<string, unknown>
    }

export function runWebMCPPageProbe(request: PageProbeRequest): Promise<DiscoverProbeResult | InvokeProbeResult> {
  const normalizeSchema = (inputSchema: unknown): Record<string, unknown> => {
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

  const normalizeTools = (tools: unknown): WebMCPToolMeta[] => {
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

  const resolveApi = (): {
    mode: WebMCPApiMode
    getTools: () => Promise<WebMCPToolMeta[]>
    executeToolByName: (toolName: string, args: Record<string, unknown>) => Promise<unknown>
  } | null => {
    const createImperativeApi = (
      modelContext: any,
      mode: WebMCPApiMode,
    ) => {
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
        getTools: async () => normalizeTools(await modelContext.getTools()),
        executeToolByName: async (toolName: string, args: Record<string, unknown>) => {
          const tools = await modelContext.getTools()
          const targetTool = Array.isArray(tools)
            ? tools.find((tool: any) => tool?.name === toolName)
            : null

          if (!targetTool) {
            throw new Error(`Tool not found in tab: ${toolName}`)
          }

          // Keep this dependency-free probe in sync with agent-core.ts.
          return modelContext.executeTool(targetTool, usesNativeInput ? JSON.stringify(args || {}) : args || {})
        },
      }
    }

    return createImperativeApi((document as any)?.modelContext, 'documentModelContext')
  }

  return (async () => {
    try {
      const api = resolveApi()
      if (!api) {
        if (request.type === 'discover') {
          return { ok: true, tools: [] }
        }
        return {
          ok: false,
          errorCode: 'WEBMCP_UNAVAILABLE',
          error: 'WebMCP APIs are not available in this tab',
        }
      }

      if (request.type === 'discover') {
        return {
          ok: true,
          mode: api.mode,
          tools: await api.getTools(),
        }
      }

      const result = await api.executeToolByName(request.toolName, request.args || {})
      return {
        ok: true,
        apiMode: api.mode,
        result:
          result === null || result === undefined || typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean'
            ? result
            : (() => {
                try {
                  return JSON.parse(JSON.stringify(result))
                } catch {
                  return String(result)
                }
              })(),
      }
    } catch (error: any) {
      const message = typeof error?.message === 'string' ? error.message : String(error)
      if (request.type === 'discover') {
        return { ok: false, error: message }
      }
      return {
        ok: false,
        errorCode: message.startsWith('Tool not found in tab:') ? 'TOOL_NOT_FOUND' : 'INVOKE_FAILED',
        error: message,
      }
    }
  })()
}
