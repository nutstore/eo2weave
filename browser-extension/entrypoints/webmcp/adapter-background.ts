import { getExtensionSkillStorage } from './skill-resources'
import { readEnabledWebMCPPackages } from './package-repository'
import { getBuiltinStorage, BUILTIN_CONFIG_STORAGE_KEY } from './builtin-storage'
import { createPackageManagement } from './package-management'
import { getAdapterStorage } from './provider-storage'
import { createProviderHandler } from './provider-handler'
import { createAdapterService } from './adapter-service'
import { isRecord } from '@creatorweave/shared/webmcp-adapter-protocol'
import type { BrowserRequest } from '../../lib/bash-commands/browser/command'

interface AdapterBackgroundOptions {
  runBrowser(owner: string, request: BrowserRequest, signal: AbortSignal): Promise<unknown>
}

export function installAdapterBackground({ runBrowser }: AdapterBackgroundOptions) {
  let wasm: Promise<WebAssembly.Module> | undefined
  const service = createAdapterService({
    readPackages: readEnabledWebMCPPackages,
    runBrowser,
    loadWasm: () => wasm ??= fetch(chrome.runtime.getURL('/assets/quickjs/quickjs.wasm'))
      .then(async response => {
        if (!response.ok) throw new Error(`QuickJS WASM unavailable: ${response.status}`)
        return WebAssembly.compile(await response.arrayBuffer())
      }).catch(error => { wasm = undefined; throw error }),
    changed: () => {
      void chrome.tabs.query({}).then(tabs => Promise.allSettled(tabs.filter(tab => tab.id !== undefined)
        .map(tab => chrome.tabs.sendMessage(tab.id!, { type: 'webmcp_adapter_changed' })))).catch(() => {})
    },
  })
  const notifyManagement = () => {
    void chrome.runtime.sendMessage({ type: 'webmcp_packages_changed' }).catch(() => {})
  }
  const refresh = async () => {
    try { await service.refresh() } finally { notifyManagement() }
  }
  void refresh().catch(error => console.warn('[WebMCP adapters] Catalog refresh failed:', error))
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[BUILTIN_CONFIG_STORAGE_KEY]) {
      void refresh().catch(error => console.warn('[WebMCP adapters] Catalog refresh failed:', error))
    }
  })
  const providerCall = createProviderHandler(getAdapterStorage, refresh)
  const builtinCall = createProviderHandler(getBuiltinStorage, refresh)
  const skillCall = createProviderHandler(getExtensionSkillStorage, async () => {})
  const manage = createPackageManagement(providerCall, refresh)
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!isRecord(message) || typeof message.type !== 'string') return false
    if (message.type === 'webmcp_provider_call') {
      if (sender.id !== chrome.runtime.id) { respond({ ok: false, code: 'EACCES', error: 'Untrusted storage caller' }); return false }
      if (message.mount !== undefined && !['webmcp', 'builtin-webmcp', 'extension-skills'].includes(String(message.mount))) { respond({ ok: false, code: 'EINVAL', error: 'Unknown mount' }); return false }
      void (message.mount === 'extension-skills' ? skillCall : message.mount === 'builtin-webmcp' ? builtinCall : providerCall)(message).then(respond)
      return true
    }
    if (message.type.startsWith('webmcp_packages_')) {
      if (message.type === 'webmcp_packages_changed') return false
      const allowed = [chrome.runtime.getURL('/recipes.html'), chrome.runtime.getURL('/popup.html')]
      const senderUrl = (sender.url || '').split(/[?#]/)[0]
      if (sender.id !== chrome.runtime.id || !allowed.includes(senderUrl) ||
        (message.type === 'webmcp_packages_set_config' && senderUrl !== allowed[0])) {
        respond({ ok: false, code: 'EACCES', error: 'Package management requires the extension management page' })
        return false
      }
      void manage(message).then(respond)
      return true
    }
    if (!message.type.startsWith('webmcp_adapter_')) return false
    if (sender.id !== chrome.runtime.id) return false
    if (message.type === 'webmcp_adapter_invoke') {
      void service.invoke(sender, message).then(respond)
      return true
    }
    try {
      if (message.type === 'webmcp_adapter_catalog') respond({ ok: true, tools: service.catalog(sender) })
      else if (message.type === 'webmcp_adapter_cancel') { service.cancel(sender, message.requestId); respond({ ok: true }) }
      else respond({ ok: false })
    } catch (error) { respond({ ok: false, error: String(error) }) }
    return false
  })
  return service
}
