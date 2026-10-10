/**
 * register.ts — registers the app-tools onto this page's WebMCP model context
 * (`document.modelContext`), making EO2Weave operable by agents as an ordinary
 * set of WebMCP tools.
 *
 * - Explicitly initializes document.modelContext before loading registration
 *   dependencies, preserving the browser's native API when available.
 * - Idempotent: safe to call multiple times (tracks registration state).
 * - Wires the real store/service dependencies into handlers once.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// document.modelContext is a runtime-injected API (native Chrome 140+ or the
// @mcp-b polyfill) — its shape can't be imported statically, hence the casts.
import { installWebMCP } from '@mcp-b/webmcp-polyfill'
import { APP_TOOLS } from './schemas'
import { buildToolExecutors, initAppToolDeps } from './handlers'

let registered = false
let registerPromise: Promise<void> | null = null

export function isAppToolsRegistered(): boolean {
  return registered
}

export async function registerAppTools(): Promise<void> {
  if (registered) return
  if (registerPromise) return registerPromise

  registerPromise = (async () => {
    // Browser-only guard (SSR / non-browser test envs)
    if (typeof document === 'undefined' || typeof window === 'undefined') return

    // Initialize before asynchronous dependency loading or tool registration.
    installWebMCP()

    const { useConversationStore } = await import('@/store/conversation.store')
    const { useSettingsStore } = await import('@/store/settings.store')
    const { useAgentStore } = await import('@/store/agent.store')
    const { getWorkspaceManager } = await import('@/opfs')
    const { getProjectRepository } = await import('@/sqlite/repositories/project.repository')
    const { getMessageRepository } = await import('@/sqlite/repositories/message.repository')
    const { searchConversationsExecutor } = await import('@/agent/tools/search-conversations.tool')

    const { useConversationRuntimeStore } = await import('@/store/conversation-runtime.store')
    const { getFSOverlayRepository } = await import('@/sqlite/repositories/fs-overlay.repository')
    const { validatePathImpl } = await import('@/opfs/workspace/workspace-file-ops')

    initAppToolDeps({
      getConversationStore: () => useConversationStore.getState(),
      getRuntimeStore: () => useConversationRuntimeStore.getState(),
      getSettingsStore: () => useSettingsStore.getState(),
      getAgentStore: () => useAgentStore.getState(),
      getFSOverlayRepository: () => getFSOverlayRepository(),
      validatePath: (path: string) => {
        // validatePathImpl is a pure path normalizer over the runtime bridge —
        // call it with a minimal stub since it only reads rt for project roots.
        return validatePathImpl({} as any, path)
      },
      getWorkspaceManager: async () => {
        const manager = await getWorkspaceManager()
        return manager
      },
      getProjectRepository: () => getProjectRepository(),
      getMessageRepository: () => getMessageRepository(),
      searchConversations: async (args) => {
        const result = await searchConversationsExecutor(args, {
          directoryHandle: null,
        } as any)
        return result
      },
      wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    })

    const executors = buildToolExecutors()
    const modelContext = (document as any)?.modelContext
    if (!modelContext?.registerTool) {
      console.warn('[app-tools] document.modelContext unavailable — app tools not registered')
      return
    }

    for (const def of APP_TOOLS) {
      const execute = executors.get(def.name)!
      try {
        await modelContext.registerTool(
          {
            name: def.name,
            description: def.description,
            inputSchema: def.inputSchema,
            annotations: def.annotations,
            execute: async (args: Record<string, any>) => {
              try {
                const out = await execute(args ?? {})
                return out.content
              } catch (e) {
                return JSON.stringify({ error: e instanceof Error ? e.message : String(e) })
              }
            },
          },
          // Re-registering the same name throws in the polyfill — tolerate that
          // on hot-reload by ignoring the specific error.
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!msg.includes('already registered')) throw e
      }
    }

    // The polyfill's getTools() projection drops `annotations` (upstream gap,
    // M-4). Publish them on a well-known global so the browser extension's
    // injected agent can merge them back into its tool snapshot. Native
    // modelContext (Chrome 140+) forwards annotations itself; this global is
    // then simply redundant.
    (window as any).__eo2weaveToolAnnotations = Object.fromEntries(
      APP_TOOLS.map((t) => [t.name, t.annotations ?? {}]),
    )

    registered = true
    console.info(`[app-tools] registered ${APP_TOOLS.length} WebMCP tools on this page`)
  })()

  try {
    await registerPromise
  } finally {
    registerPromise = null
  }
}
