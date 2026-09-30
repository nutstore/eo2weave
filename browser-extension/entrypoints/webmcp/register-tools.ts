import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill'

export interface PageTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<unknown>
}

/** Shared registration path for bundled recipes and OPFS adapters. */
export async function registerPageTools(tools: PageTool[], controller: AbortController): Promise<void> {
  if (!(document as unknown as { modelContext: unknown }).modelContext) initializeWebMCPPolyfill()
  const context = (document as unknown as {
    modelContext: { registerTool(tool: PageTool, options: { signal: AbortSignal }): Promise<void> }
  }).modelContext
  if (!context?.registerTool) throw new Error('WebMCP modelContext unavailable')
  try {
    for (const tool of tools) {
      controller.signal.throwIfAborted()
      await context.registerTool(tool, { signal: controller.signal })
    }
  } catch (error) {
    controller.abort()
    throw error
  }
}
