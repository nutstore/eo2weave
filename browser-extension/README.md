# Browser Extension (EO2Weave)

The browser extension powering EO2Weave: `web_search` / `web_fetch` for in-browser agents, **WebMCP tool discovery** (any website can expose agent-callable tools via the standard WebMCP API), Rust native-host disk/exec access, and an optional **Codex OAuth proxy**.

Built with [WXT](https://wxt.dev/).

## Distribution

| Variant | Codex OAuth | Manifest key | How to get |
|---------|-------------|--------------|------------|
| Chrome Web Store | ✅ included | omitted (CWS assigns its own ID) | `npm run build:store` / `npm run zip:store` |
| Self-distribution / dev | ✅ included | pinned (stable ID for native messaging) | `npm run build` / `npm run zip` / `npm run pack:release` |

Both variants keep Codex OAuth. The store variant only omits the pinned manifest `key` (CWS rejects manifests carrying one); set `CW_CODEX_OAUTH=0` on either if a Codex-free bundle is ever needed.

```bash
npm run build          # Self-distribution build (pinned manifest key, Codex OAuth included)
npm run zip            # Self-distribution .zip package
npm run build:store    # Store build (CW_STORE_BUILD=1, omits the manifest key for CWS)
npm run zip:store      # Store .zip (key omitted)
```

## Setup & Development

```bash
cd browser-extension
npm install
npm run watch
```

Then load the extension **once** in your own Chrome:

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `browser-extension/dist/chrome-mv3/`

After that, code changes trigger automatic extension reload — no need to reload manually.

Other commands:

```bash
npm run dev            # Auto-launch a new Chrome instance with extension loaded
```

## Features

### Web Search & Fetch

After installation, `window.__agentWeb` is injected into the page:

```javascript
if (window.__agentWeb?.ready) {
  // Search
  const results = await window.__agentWeb.search('svelte 5 runes');
  // { ok: true, results: [{ title, url, snippet }, ...] }

  // Fetch a webpage (returns clean Markdown via Readability + Turndown)
  const article = await window.__agentWeb.fetch('https://example.com/blog-post');
  // {
  //   ok: true, status: 200, body: '# Article title\n\nMarkdown content...',
  //   readability: { title, excerpt, byline, siteName, length }
  // }

  // SPAs and JS-heavy sites are detected automatically: when the initial
  // HTML body is too short, a second request is made with a document
  // parser to extract the rendered content.
}
```

### WebMCP Tool Discovery

Any website can expose tools (functions the AI agent can call) to EO2Weave by registering them via the **standard WebMCP API** (`document.modelContext`). No private protocol, no allowlist, no registration process — the extension discovers standard-conforming tools automatically, keeps a live per-tab registry, and lets users grant/revoke per-site and per-tool-group authorization from the popup.

→ Full integration guide for websites: [WebMCP Tools — Integration Guide](#webmcp-tools--integration-guide-for-websites)

## WebMCP Tools — Integration Guide for Websites

Any website can expose tools (functions the AI agent can call) to EO2Weave by registering them via the **standard WebMCP API** (`document.modelContext`). There is **no private protocol, no allowlist, no registration process** — the extension discovers standard-conforming tools automatically.

### How a website registers tools

**Option A — native API** (Chrome 140+ ships `document.modelContext`):

```javascript
await document.modelContext.registerTool({
  name: 'search_orders',
  description: 'Search the current user\'s orders',
  inputSchema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: 'Search term' },
    },
    required: ['keyword'],
  },
  execute: async (args) => {
    const results = await fetch(`/api/orders?q=${encodeURIComponent(args.keyword)}`).then(r => r.json());
    return JSON.stringify(results);
  },
});
```

**Option B — polyfill** (other browsers / older Chrome, one import):

```html
<script type="module">
  import 'https://esm.sh/@mcp-b/global'; // auto-installs document.modelContext
  // then registerTool exactly as above
</script>
```

That's all the site needs to do. Registration can happen at any time — SPA hydration, lazy routes, late script loads are all picked up (the extension re-resolves the page API on a 2s poll in addition to the standard `toolchange` event).

### How discovery works (site developers don't need to do anything)

```
page registers tools
  → webmcp-injected.content.ts (MAIN world, static)
      pushes ready/snapshot events on toolchange + diff-poll
  → webmcp.content.ts (ISOLATED world, static)
      validates and relays as webmcp_tab_report
  → background registry (storage.session-persisted)
      → popup lists sites/groups instantly (no tab scan)
      → EO2Weave web app discovers tools via window.__agentWeb.webmcpDiscoverTools()
  → agent invokes a tool via webmcpInvokeTool()
      → authorization gate (host + group) → relayed back into the source tab
```

The legacy scan-on-demand probe still exists as a fallback for tabs opened before the extension was (re)loaded; new tabs are pure push.

### How the agent host invokes a tool

Sites only **register** tools. **Calling** them is done by the agent host (the EO2Weave web app) through the same `window.__agentWeb` bridge:

```javascript
// 1. Discover (flat list; each entry carries its own routing identity)
const { tools } = await window.__agentWeb.webMCPDiscover();

// 2. Pick a tool (inputSchema describes the expected arguments)
const target = tools.find(
  (t) => t.hostname === 'workspace.jianguoyun.com' && t.name === 'fetch_ticket_messages'
);

// 3. Invoke
const resp = await window.__agentWeb.webMCPInvoke({
  groupKey: target.groupKey,        // hostname_toolsetSignature
  fullToolName: target.fullName,    // hostname__toolName (provider-safe)
  args: { public_id: '175157', count: 30 },  // per the tool's inputSchema
  preferredTabId: target.tabId,     // optional: pin execution to a specific tab
});
// → { ok, result, tabId, hostname, errorCode?, error? }
```

Under the hood: `webMCPInvoke` → background authorization gates (host + group; disabled tools are refused before any page script runs) → routing (`preferredTabId` → last successful route → any tab in the group) → relayed into the source tab → the page agent executes `executeTool(descriptor, JSON.stringify(args))` → result returns the same way.

**Error codes worth handling:**

| errorCode | Meaning | Recovery |
|-----------|---------|----------|
| `HOST_DISABLED` / `GROUP_DISABLED` | The user revoked authorization for this site/tool group | Ask the user to re-enable it in the extension popup |
| `TOOL_TARGET_NOT_FOUND` | No open tab provides this group anymore | Ask the user to reopen the page, then re-invoke |
| `TOOL_NOT_FOUND` | The page's toolset changed | Re-run `webMCPDiscover()` |

Why the discovery response is a **flat list** (not host→group→tools): every consumer folds it differently — the agent registry uses it as-is, the popup and settings page group by host/group, and per-tool authorization filtering happens at the flat-record level in the background before the response leaves the extension. Nesting would only serve one view and lose the rest.

### Authorization model

- **Default allow, opt-out per site and per tool group.** Users manage switches in the extension popup.
- Tools from disabled sites/groups are **removed from discovery responses entirely** — they simply don't exist for pages or agents.
- The invoke path independently enforces `HOST_DISABLED` / `GROUP_DISABLED` regardless of what any UI shows.
- Websites cannot detect or influence their authorization state.

### Constraints & known limits

| Item | Limit |
|------|-------|
| Tools per page entering the catalog | 100 (extra tools dropped) |
| Tool description length | 2000 chars (longer is truncated) |
| Tool full names | Provider-safe: `hostname__toolName`, `[a-zA-Z0-9_-]`, ≤ 64 chars (hash suffix on collision) |
| Declarative form tools (annotated HTML forms) | **Not discovered** — only JS-registered (imperative) tools are |
| `execute` return values | JSON-serializable; must survive `JSON.parse(JSON.stringify(v))` |

### Site-side auth & security

`execute` runs the site's own code in the site's own tab, with the site's own cookies/session. Sites should treat tool arguments as **untrusted input**: validate args, check login state, rate-limit, and throw on invalid input — the error message propagates back to the agent.

### Debugging tips

- Check discovery: open the extension popup — your site's hostname and tool groups should appear within ~2s of registration.
- Test shim: `navigator.modelContextTesting` is also detected (listTools/executeTool), useful for pages that can't install the real API.
- The registry is per-tab: navigate away or unregister tools and the tab disappears from the catalog automatically.

## Bridge API Reference

### `window.__agentWeb.search(query, options?)`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| query | string | - | Search query |
| options.count | number | 10 | Number of results (max 20) |

### `window.__agentWeb.fetch(url, options?)`

Returns the page rendered as **clean Markdown** (via [Mozilla Readability](https://github.com/mozilla/readability) + Turndown HTML-to-Markdown). SPA / JS-heavy pages are detected automatically and re-fetched with a DOM parser when the initial body is too short.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| url | string | - | Target URL |
| options.method | string | 'GET' | HTTP method |
| options.headers | object | {} | Request headers |
| options.body | string | null | Request body |

**Response shape:**

```javascript
{
  ok: true,
  status: 200,
  body: '# Article title\n\nMarkdown content...',
  readability: { title, excerpt, byline, siteName, length }
}
```

### `window.__agentWeb.codexGetStatus()` *(community version only)*

Returns the current Codex OAuth authorization status:

```javascript
const resp = await window.__agentWeb.codexGetStatus();
// { ok: true, data: { authorized: true, authState: 'authorized', models: [...] } }
```

### `window.__agentWeb.codexProxyFetchStream(body)` *(community version only)*

Proxies a Codex Responses API request through the extension with SSE streaming:

```javascript
const stream = window.__agentWeb.codexProxyFetchStream({
  model: 'gpt-5.4',
  instructions: 'You are a helpful assistant.',
  stream: true,
  input: [...],
});
for await (const chunk of stream) {
  // SSE text chunks
}
stream.cancel(); // Abort early if needed
```

## OPFS WebMCP adapters

Adapter source runs in a fresh QuickJS VM in the background service worker. A target page receives only tool metadata and an opaque registration ID; its registered WebMCP callback forwards arguments through the isolated content script and returns the SW result. It never compiles the workflow or receives its source.

`packages/quickjs-runtime` remains host-independent: it knows only JavaScript execution, JSON bindings and resource limits. The business-layer `packages/shared/src/code-tool-bindings.ts` defines the `tools` API shared with `run_code`. Extension modules own workflow orchestration, schema validation, target authorization and reverse RPC. The Web workspace host invokes the existing tool-invocation pipeline, retaining argument validation, mode checks and policy hooks.

The workspace publishes packages over a live bidirectional port. A workflow binds to that host session, workspace and target document. An explicitly bound side panel takes precedence; ambiguous unbound hosts are unavailable. Keep the workspace host open and WebMCP enabled. Page tools retain their side-panel requirement. Disconnect, workspace switch, package replacement, target navigation and cancellation abort in-flight work; already-started side effects are not rolled back. SW restarts reconnect through the next publication cycle without replaying executions.

Workflows currently have a 55-second deadline, a 1-second guest CPU budget and a global limit of eight executions. An already-running route rejects another invocation, preventing recursive adapter cycles. Different routes execute independently. Browser builds package the pinned QuickJS WASM through the WXT build hook; extension CSP permits WASM compilation without JavaScript `eval`.

## Agent Bridge (MCP) — WebMCP tools for Codex / Claude Code / Cursor

Expose the browser's discovered WebMCP tools to **out-of-browser MCP clients** (Codex CLI, Claude Code, Cursor, …) over standard **MCP stdio**. The extension popup has an **Agent bridge (MCP)** switch (default off); when on, it spawns the Rust native host as a loopback daemon, and the same `cw-native-host` binary doubles as the MCP stdio server your CLI spawns.

```
Codex CLI ──MCP stdio── cw-native-host --mcp-stdio ──TCP 127.0.0.1── daemon ──NM── extension background ── relay ── WebMCP page tools
```

**Setup (macOS):**

1. Install the native host (per-user, no sudo): unzip `EO2Weave-NativeHost-<ver>-macos.zip`, run `bash install.sh` — binary lands in `~/Library/Application Support/EO2Weave NativeHost/…`, manifests registered for Chrome/Edge, quarantine stripped
2. Restart the browser, open the EO2Weave popup, turn on **Agent bridge (MCP)**
3. Copy the ready-made command from the popup (or):

```bash
codex mcp add eo2weave-webmcp -- "$HOME/Library/Application Support/EO2Weave NativeHost/NativeMessagingHosts/cw-native-host" --mcp-stdio
claude mcp add eo2weave-webmcp -- "$HOME/Library/Application Support/EO2Weave NativeHost/NativeMessagingHosts/cw-native-host" --mcp-stdio
```

Tool names follow the provider-safe `host__tool` convention; the per-host/per-group authorization switches apply to external agents exactly as they do in-app (disabled sites simply don't exist in `tools/list`). Bridge state file: `~/.eo2weave/webmcp-bridge.json` (port + pid). Build the distribution zip with `native-host/installer/build-dist-mac.sh` (Windows: `cargo build --release` + `install.ps1`).

## Codex OAuth Proxy (Open-Source Community Version)

> **Distribution note:** this feature ships in **both** self-distribution and Chrome Web Store builds by default. The build-time strip flag `CW_CODEX_OAUTH=0` removes it entirely (popup box, background handlers, i18n keys) if a Codex-free variant is ever needed — it is orthogonal to the store/self-distribution split (`CW_STORE_BUILD`).

The extension enables using OpenAI Codex models directly from EO2Weave, without exposing OAuth tokens to the web app.

**Flow:**

1. Click the extension icon → **Start Device Code Login**
2. A new tab opens to `auth.openai.com` — complete authorization
3. The extension exchanges the device code for access/refresh tokens (stored in `chrome.storage.local`)
4. EO2Weave auto-detects the authorized extension and registers `codex-oauth` as an available LLM provider
5. All Codex API requests are proxied through the extension's background service worker

**Supported models:**

| Model ID | Name | Context Window |
|----------|------|----------------|
| `gpt-5.4` | GPT-5.4 | 200K |
| `gpt-5.4-mini` | GPT-5.4 Mini | 128K |
| `gpt-5.5` | GPT-5.5 | 200K |

**Usage display:** After the first request, the popup shows rate-limit usage windows with progress bars and reset times. Each window's label (e.g. `5h` / `Wk` / `Mo`) is derived from the duration reported by the server, and windows that the server does not return are hidden automatically.

**Security:** OAuth tokens never leave the extension boundary. The web app only communicates through the extension bridge (`window.__agentWeb`).

> **Roadmap:** the Codex OAuth proxy may migrate from the extension background into the Rust native host (`native-host/`). The extension would become a pure relay, and the store build would no longer need build-time feature stripping.

## Project Structure

```
browser-extension/
├── wxt.config.ts              # WXT config (manifest, permissions, Codex strip, stable extension key)
├── package.json
├── native-host/               # Rust native host (disk IO + exec, Chrome Native Messaging)
│   └── src/
│       ├── main.rs            # NM framing (4-byte length prefix, 1MB limit), stateless/streaming modes
│       ├── nm.rs              # Message read/write
│       ├── scope.rs           # Authorized directory scopes
│       ├── shell_env.rs       # Login-shell PATH/env inheritance
│       ├── process_registry.rs# Background processes (exec_start/status/stop/logs)
│       └── actions/           # read_file/write_file/exec_sync/execpolicy/... per action
├── entrypoints/
│   ├── background.ts          # Service worker (search, fetch, Codex OAuth, WebMCP registry, native host relay)
│   ├── content.ts             # Content script — message relay (ISOLATED world)
│   ├── injected.content.ts    # Content script — __agentWeb API + Readability (MAIN world)
│   ├── webmcp.content.ts      # Content script — WebMCP relay (ISOLATED world, static)
│   ├── webmcp-injected.content.ts # Content script — WebMCP page agent (MAIN world, static)
│   ├── page-action-runner.content.ts # Bound page actions (ACT ON PAGES)
│   ├── side-panel-button.content.ts  # Floating "唤起怡氧知知" button
│   ├── popup/
│   │   ├── index.html
│   │   └── main.ts            # Popup: injection status, WebMCP site/group switches, Codex box (community version)
│   └── webmcp/                # WebMCP background modules
│       ├── relay-protocol.ts  # Dual-world envelope + parsers (tool/desc clamps)
│       ├── agent-core.ts      # Page-API resolution ladder (document→navigator→testing)
│       ├── registry.ts        # Tab registry (storage.session, seen-set)
│       ├── discovery.ts       # Registry-first discover + legacy probe fallback
│       ├── invoke.ts          # Authorization gates + relay-first invoke
│       ├── authorization.ts   # Per-host / per-group opt-out store
│       └── ...
└── public/                    # Icons, _locales, static assets
```

## Architecture

```
EO2Weave Web App
  │
  ├── pi-ai library → fetch() → codex-bridge-fetch.ts (globalThis.fetch wrapper)
  │       │
  │       └──→ window.__agentWeb.codexProxyFetchStream(body)
  │               │
  │               └──→ [SSE streaming via port-based messaging]
  │
  └── window.__agentWeb (injected by injected.content.ts, MAIN world)
          │                                 │
          │  search / fetch / codexStatus   │  readability extraction
          │                                 │
          │         ┌───────────────────────┘
          │         │  Readability (DOMParser, runs in page context)
          │         │
          └──→ window.postMessage (bridge)
                  │
                  └──→ content.ts (ISOLATED world, relay)
                          │
                          ├── chrome.runtime.sendMessage (request/response)
                          └── chrome.runtime.connect (streaming)
                                  │
                                  └──→ background.ts (Service Worker)
                                          ├── web_search → DuckDuckGo (falls back to Baidu on bot-challenge/rate limit)
                                          ├── web_fetch → Direct URL fetch
                                          ├── codex_auth → Device Code OAuth
                                          ├── codex_proxy_fetch_stream → chatgpt.com/codex
                                          ├── webmcp_tab_report → tab registry (storage.session)
                                          ├── webmcp_discover_tools → registry + fallback probe
                                          ├── webmcp_invoke_tool → auth gates → tabs.sendMessage relay
                                          └── native_host_call → Rust host (disk IO, exec_sync)
```

### WebMCP Discovery Flow (per tab)

```
website page (standard WebMCP registration)
  → webmcp-injected.content.ts (MAIN world, document_idle)
      resolveAgentApi() → ready snapshot → toolchange events + 2s diff-poll
  → window.postMessage (relay envelope, validated)
  → webmcp.content.ts (ISOLATED world)
  → chrome.runtime.sendMessage('webmcp_tab_report')
  → background: registry.ts (identity from browser-verified sender.tab)
  → popup (instant list + live refresh) / web app (webmcpDiscoverTools)

invoke: web app → webmcpInvokeTool → invoke.ts
  → host/group authorization gates → tabs.sendMessage('webmcp_invoke_in_tab')
  → relay → page agent → executeTool → response
  (legacy executeScript probe only for tabs predating extension load)
```

### Codex Request Flow *(community version)*

```
Web App → fetch(chatgpt.com/...)
  → codex-bridge-fetch.ts intercepts
    → window.__agentWeb.codexProxyFetchStream(body)
      → injected.content.ts → postMessage
        → content.ts → chrome.runtime.connect('codex_stream')
          → background.ts → fetch(chatgpt.com, { stream: true })
            → extract x-codex-* rate-limit headers → save to storage
            → SSE chunks → port.postMessage → ... → ReadableStream → Response
```
