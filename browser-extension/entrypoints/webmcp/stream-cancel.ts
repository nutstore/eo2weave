/**
 * Which page-side bridge streams support a REMOTE cancel.
 *
 * The page-side bridge relays a stream request to the background over a
 * runtime port. When the page cancels the stream, the relay posts a
 * `{ type: 'cancel' }` control message on that port so the background can
 * abort the in-flight upstream work instead of letting it run to completion
 * with nobody listening (#139 review round 6: cancelled downloads keep
 * running).
 *
 * Only the background handlers that actually implement the `cancel` control
 * message may be listed here:
 *   - `codex_proxy_fetch_stream` — the Codex stream handler aborts on cancel.
 *   - `webmcp_plugin_download_stream` — the plugin-download handler aborts
 *     the fetch and drops the transfer record on cancel.
 *   - `mcp_network_v2` — the MCP relay aborts its fetch and response reader.
 */
const REMOTE_CANCELLABLE_STREAM_TYPES = new Set([
  'codex_proxy_fetch_stream',
  'codex_image_generate',
  'webmcp_plugin_download_stream',
  'mcp_network_v2',
])

/** True when a cancel for this stream type must be forwarded to the background. */
export function supportsRemoteStreamCancel(type: string): boolean {
  return REMOTE_CANCELLABLE_STREAM_TYPES.has(type)
}
