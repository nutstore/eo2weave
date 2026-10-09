import { createAdapterService } from './adapter-service'
import { isHostEnabled, isGroupEnabled } from './authorization'
import { getTabGroupInfo } from './discovery'
import { WEBMCP_PING_IN_TAB_TYPE } from './relay-protocol'
import { isRecord } from '@creatorweave/shared/webmcp-adapter-protocol'

export function installAdapterBackground(
  trusted: (sender: chrome.runtime.MessageSender) => boolean,
  resolveBinding: (senderUrl: string, binding: unknown) => Promise<number | null>,
) {
  let wasm: Promise<WebAssembly.Module> | undefined
  const service = createAdapterService({
    trusted, resolveBinding,
    loadWasm: () => wasm ??= fetch(chrome.runtime.getURL('/assets/quickjs/quickjs.wasm'))
      .then(async response => {
        if (!response.ok) throw new Error(`QuickJS WASM unavailable: ${response.status}`)
        return WebAssembly.compile(await response.arrayBuffer())
      }).catch(error => { wasm = undefined; throw error }),
    authorize: async sender => {
      const tab = await chrome.tabs.get(sender.tab!.id!)
      if (tab.url !== sender.url) throw new Error('Adapter target navigated')
      // Address the exact document, never a replacement document with the same URL.
      const probe = await chrome.tabs.sendMessage(tab.id!, { type: WEBMCP_PING_IN_TAB_TYPE }, { documentId: sender.documentId! })
      if (!probe?.ok) throw new Error('Adapter document unavailable')
      const hostname = new URL(sender.url!).hostname
      if (!(await isHostEnabled(hostname))) throw new Error('WebMCP host is disabled')
      const group = await getTabGroupInfo(tab.id!)
      if (!group || !(await isGroupEnabled(group.groupKey))) throw new Error('WebMCP group is unavailable or disabled')
    },
    changed: () => {
      void chrome.tabs.query({}).then(tabs => Promise.allSettled(tabs.filter(tab => tab.id !== undefined)
        .map(tab => chrome.tabs.sendMessage(tab.id!, { type: 'webmcp_adapter_changed' })))).catch(() => {})
    },
  })
  chrome.runtime.onConnect.addListener(port => service.connect(port))
  chrome.tabs.onRemoved.addListener(tabId => service.cancelTab(tabId))
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url || change.status === 'loading') service.cancelTab(tabId)
  })
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!isRecord(message) || typeof message.type !== 'string' || !message.type.startsWith('webmcp_adapter_')) return false
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
}
