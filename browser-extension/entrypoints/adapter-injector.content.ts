// MAIN-world forwarding proxies; workflow callbacks execute in the service worker.
import { invokeAdapterFromPage } from './webmcp/adapter-page-client'
import { createAdapterInjector } from './webmcp/adapter-injector'
import { CW_WEBMCP_AGENT_MARKER, parseRelayCommand } from './webmcp/relay-protocol'

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  world: 'MAIN',
  main() {
    const syncAdapters = createAdapterInjector(() => location.href, invokeAdapterFromPage)
    window.addEventListener('message', event => {
      if (event.source !== window || event.data?.[CW_WEBMCP_AGENT_MARKER] !== true) return
      const command = parseRelayCommand(event.data)
      if (command?.kind === 'adapters-sync') {
        void syncAdapters(command.tools).catch(error => console.warn('[WebMCP adapters] Injection failed:', error))
      }
    })
  },
})
