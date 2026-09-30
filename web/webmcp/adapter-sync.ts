import { WebMcpBackend } from '@/agent/tools/backends/webmcp-backend'
import { useSettingsStore } from '@/store/settings.store'
import { readAdapterCatalog } from './adapters'
import type { WebMCPAdapter } from '@creatorweave/shared/webmcp-adapter'

type AdapterBridge = {
  ready: boolean
  webMCPSetAdapters(adapters: WebMCPAdapter[]): Promise<{ ok: boolean; error: string }>
}

/** Injection has its own lifecycle and never calls or changes discovery. */
export function startWebMCPAdapterSync(): () => void {
  const backend = new WebMcpBackend()
  let stopped = false
  let previous = ''
  let previousErrors = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const sync = async () => {
    try {
      const bridge = (window as unknown as { __agentWeb: AdapterBridge }).__agentWeb
      if (!bridge?.ready || typeof bridge.webMCPSetAdapters !== 'function') return
      const catalog = useSettingsStore.getState().enableWebMCP
        ? await readAdapterCatalog({
          async directories() {
            return (await backend.listDir('')).filter(entry => entry.kind === 'directory').map(entry => entry.name)
          },
          async readFile(path) {
            const result = await backend.readFile(path, { encoding: 'text' })
            if (typeof result.content !== 'string') throw new Error(`Expected text: ${path}`)
            return result.content
          },
        })
        : { adapters: [], errors: [] }
      if (stopped) return
      const errors = catalog.errors.join('\n')
      if (errors !== previousErrors && errors) console.warn('[WebMCP adapters]', errors)
      previousErrors = errors
      const snapshot = JSON.stringify(catalog.adapters)
      if (snapshot === previous) return
      const response = await bridge.webMCPSetAdapters(catalog.adapters)
      if (!response.ok) throw new Error(response.error)
      previous = snapshot
    } catch (error) {
      console.warn('[WebMCP adapters] Sync failed:', error)
    } finally {
      if (!stopped) timer = setTimeout(() => { void sync() }, 3000)
    }
  }
  void sync()
  return () => { stopped = true; if (timer !== null) clearTimeout(timer) }
}
