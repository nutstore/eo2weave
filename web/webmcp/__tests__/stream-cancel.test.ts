import { describe, expect, it } from 'vitest'
import { supportsRemoteStreamCancel } from '../../../browser-extension/entrypoints/webmcp/stream-cancel'

// Contract: a cancelled page-side plugin-download stream must forward the
// cancel to the background so the upstream fetch is aborted instead of
// running on with nobody listening (#139 review round 6: cancelled downloads
// keep running).
describe('supportsRemoteStreamCancel', () => {
  it('allows the plugin-download stream and the Codex stream only', () => {
    expect(supportsRemoteStreamCancel('webmcp_plugin_download_stream')).toBe(true)
    expect(supportsRemoteStreamCancel('codex_proxy_fetch_stream')).toBe(true)
    // The MCP stream's background handler has no `cancel` control message.
    expect(supportsRemoteStreamCancel('mcp_proxy_fetch_stream')).toBe(false)
  })
})
