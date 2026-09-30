import { WebMcpBackend } from '@/agent/tools/backends/webmcp-backend'
import { useSettingsStore } from '@/store/settings.store'
import { readPackageCatalog } from './adapters'
import type { WebMCPPackage } from '@creatorweave/shared/webmcp-adapter'

type AdapterBridge = {
  ready: boolean
  webMCPSetPackages(packages: WebMCPPackage[]): Promise<{ ok: boolean; error: string }>
}

/**
 * Polls OPFS webmcp/ every 3s and pushes the package snapshot to the extension
 * when it changes. Returns a stop function.
 */
export function startWebMCPAdapterSync(): () => void {
  const backend = new WebMcpBackend()
  let stopped = false
  let previous = ''
  let previousErrors = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const sync = async () => {
    try {
      const bridge = (window as unknown as { __agentWeb: AdapterBridge }).__agentWeb
      if (!bridge?.ready || typeof bridge.webMCPSetPackages !== 'function') return
      const catalog = useSettingsStore.getState().enableWebMCP
        ? await readPackageCatalog({
          async directories() {
            return (await backend.listDir('')).filter(entry => entry.kind === 'directory').map(entry => entry.name)
          },
          async readFile(path) {
            const result = await backend.readFile(path, { encoding: 'text' })
            if (typeof result.content !== 'string') throw new Error(`Expected text: ${path}`)
            return result.content
          },
        })
        : { packages: [], errors: [] }
      if (stopped) return
      const errors = catalog.errors.join('\n')
      if (errors !== previousErrors && errors) console.warn('[WebMCP adapters]', errors)
      previousErrors = errors
      const snapshot = JSON.stringify(catalog.packages)
      if (snapshot === previous) return
      const response = await bridge.webMCPSetPackages(catalog.packages)
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
