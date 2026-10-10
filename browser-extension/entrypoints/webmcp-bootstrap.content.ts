import { installWebMCP } from '@mcp-b/webmcp-polyfill'
import { defineContentScript } from 'wxt/sandbox'

/** Establish the current page API before site scripts register their tools. */
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    installWebMCP()
  },
})
