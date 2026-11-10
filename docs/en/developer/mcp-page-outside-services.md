---
title: Integrating Out-of-Page MCP Services
order: 140
---

# Integrating Out-of-Page MCP Services

This guide explains how to connect **out-of-page MCP services** to EO2Weave, including:

- Figma Remote MCP
- OpenPencil local MCP
- Other MCP servers outside the current page context that must be accessed via the browser extension bridge

## 1. Understand the Boundary First

There are two kinds of capability sources on the platform — keep them separate:

### 1.1 WebMCP

WebMCP refers to MCP capabilities **exposed directly by the current page context**.

Characteristics:

- Tool discovery and invocation happen inside the page context
- Suited to capabilities exposed by the current site itself
- Not for connecting to independently running remote or local MCP servers

### 1.2 Out-of-page MCP services

Out-of-page MCP services are MCP servers that **do not belong to the current page context** and run independently.

For example:

- Figma Remote MCP: `https://mcp.figma.com/mcp`
- OpenPencil local MCP (a local service started by the desktop app)
- Other local/remote standalone MCP servers

Characteristics:

- The page cannot rely on in-browser `fetch` to reach them
- Requests must be proxied through the **browser extension bridge**
- This uniformly handles:
  - CORS restrictions
  - Local address access
  - Header / token forwarding
  - SSE / streamable HTTP streaming responses

---

## 2. Platform Integration Principle

The current implementation is settled as:

> **All out-of-page MCP services must be accessed through the browser extension bridge.**

That means:

- The web page does **not** fetch out-of-page MCP services directly
- `mcp-client.service.ts` uniformly issues requests through the `window.__agentWeb` bridge
- The extension performs the actual network access and stream forwarding

This principle applies to:

- Figma Remote
- OpenPencil local MCP
- Any future out-of-page MCP service

---

## 3. Relevant Code Locations

> All paths are relative to the repository root `eo2weave/`.

### Web side

- `web/services/mcp-client.service.ts`
  - The production MCP client
  - Handles initialize / tools/list / tools/call / task polling
  - Bridge only, never direct page connections

- `web/mcp/`
  - MCP domain module directory
  - Key files related to out-of-page MCP integration:
    - `web/mcp/mcp-manager.ts`
    - `web/mcp/preset-providers.ts`
    - `web/mcp/mcp-types.ts`

- `web/components/mcp/MCPSettings.tsx`
  - MCP settings UI
  - Add servers, edit config, connect, view status

### Browser extension side

- `browser-extension/entrypoints/injected.content.ts`
  - Injects `window.__agentWeb` into the page
  - Exposes:
    - `mcpNetworkFetch(...)` (SDK byte-stream interface)
    - `mcpProxyFetch(...)` (legacy page compatibility)
    - `mcpProxyFetchStream(...)`

- `browser-extension/entrypoints/content.ts`
  - Relay between the page and the background

- `browser-extension/entrypoints/background.ts`
  - Performs the actual network requests
  - Handles:
    - `mcp_network_v2`
    - `mcp_proxy_fetch`
    - `mcp_proxy_fetch_stream`

---

## 4. Request Chain

The call chain for out-of-page MCP services:

```text
MCPSettings / MCPManager / MCPClientService
  -> SDK Transport -> window.__agentWeb.mcpNetworkFetch(...)
  -> injected.content.ts
  -> content.ts relay
  -> background.ts
  -> target MCP server
```

### 4.1 Streamable HTTP

For Streamable HTTP, including JSON and POST SSE responses.

In the current implementation:

- `server.transport === 'streamable_http'`
- SDK Streamable HTTP Transport uses `mcpNetworkFetch(...)` through the extension proxy

### 4.2 SSE

For traditional GET SSE connections with separate POST requests.

In the current implementation:

- `server.transport === 'legacy_sse'`
- SDK SSE Transport uses `mcpNetworkFetch(...)` through the extension byte-stream proxy
- The extension sends `response_start`, Base64 byte chunks, completion or an error; cancellation aborts the upstream fetch

---

## 5. Why the Extension Bridge Is Mandatory

### 5.1 CORS

Take OpenPencil as an example:

- The MCP HTTP service is launched automatically by the desktop app
- The service usually exposes a local address such as `127.0.0.1:7601`
- Direct browser access to such local addresses easily hits CORS / local loopback restrictions

This is the core reason OpenPencil is not suitable for direct page integration in the browser.

### 5.2 Page capability boundaries

Even if a remote service is directly reachable, the page should not take on:

- Token management
- SSE compatibility details
- Local address probing
- Timeout / streaming forwarding

All of these are better handled uniformly by the extension bridge.

### 5.3 Platform architectural consistency

With everything going through the bridge:

- The boundary between WebMCP and out-of-page MCP services stays clear
- The web-side MCP client implementation stays stable
- The extension can evolve proxy capabilities independently
- New service integrations become more repeatable

---

## 6. Figma Remote Setup

Figma Remote is the most directly integrable out-of-page MCP service today.

### 6.1 Service info

- Endpoint: `https://mcp.figma.com/mcp`
- Recommended transport: `streamable_http`
- Requires a Figma token / official MCP authorization

### 6.2 How the platform integrates it

The project already ships a Figma preset:

- Config location: `web/mcp/preset-providers.ts`
- UI entry: `web/components/mcp/MCPSettings.tsx`

### 6.3 Configuration steps

1. Open MCP Settings
2. Use **Quick add Figma preset**, or add a server manually
3. Fill in:
   - ID: `figma`
   - URL: `https://mcp.figma.com/mcp`
   - Transport: `streamable_http`
   - Auth Token: your Figma token
4. Save
5. Click Connect
6. initialize / tools/list complete through the extension bridge

### 6.4 Common failure causes

- The browser extension is not installed
- The extension is too old to support out-of-page MCP proxying
- Figma token missing, expired, or insufficient permissions
- Transport mistakenly set to `legacy_sse`
- Network failure or request timeout

`MCPSettings.tsx` now shows friendlier connection-failure hints for Figma.

---

## 7. Mail MCP Setup

Mail MCP is a EO2Weave-built streamable_http MCP server providing email drafting / sending / draft management. Typical flow: the agent drafts an email for the user → review → confirm → send.

### 7.1 Service info

- Shared endpoint: `https://mail-mcp.jianguoyun.net.cn/mcp`
- Shared setup page: `https://mail-mcp.jianguoyun.net.cn/setup`
- Local dev endpoint: `http://127.0.0.1:3011/mcp`
- Local setup page: `http://127.0.0.1:3011/setup`
- Deploy commands: `pnpm -C mcp-servers/mail-mcp-server dev` / `build` / `start`
- Recommended transport: `streamable_http`

Provides 9 tools: `get_mail_account_status` / `get_mail_setup_link` / `verify_smtp_connection` / `draft_email` / `get_email_draft` / `list_email_drafts` / `delete_email_draft` / `send_email_draft` / `send_email`.

### 7.2 Multi-user mode (recommended)

In the shared deployment, each user isolates their mailbox with a **Personal Mail Token**:

1. The user visits `/setup` → clicks "Generate token" → saves the token
2. The user fills in SMTP credentials on the setup page (host / port / user / authorization code) → verifies → saves
3. The user adds the Mail MCP preset in EO2Weave MCP Settings → pastes the same token into Auth Token
4. The agent calls `tools/call` → the server identifies the user by token → sends via that user's SMTP credentials

**Key point**: EO2Weave does **not** store SMTP credentials — only the Personal Mail Token (generated by mail-mcp itself). The server looks up account config by token and decrypts the SMTP password. The EO2Weave frontend never needs to know SMTP details.

> The legacy "single-account mode" configured via `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` environment variables is kept for backward compatibility and is not recommended for multi-user shared deployments.

### 7.3 How the platform integrates it

The project already ships a Mail preset:

- Config location: `web/mcp/preset-providers.ts` (id: `mail`, category: `communication`, icon: `mail`)
- UI entry: `web/components/mcp/MCPSettings.tsx`

### 7.4 Configuration steps

1. Open MCP Settings
2. Use **Quick add Mail MCP preset**, or add a server manually
3. Fill in:
   - ID: `mail`
   - URL: `https://mail-mcp.jianguoyun.net.cn/mcp` (or local `http://127.0.0.1:3011/mcp`)
   - Transport: `streamable_http`
   - Auth Token: the Personal Mail Token you generated on the `/setup` page
4. Save
5. Click Connect (goes through the browser extension bridge)

### 7.5 Common failure causes

- Browser extension missing / too old for out-of-page MCP proxying
- Mail MCP server not running, or blocked by an intranet firewall
- Personal Mail Token not generated / copied wrong / SMTP credentials not saved on the setup page
- Wrong SMTP credentials (QQ Mail requires the SMTP **authorization code**, not the login password; host: `smtp.qq.com`, port: `465` SSL or `587` STARTTLS)
- Transport mistakenly set to `legacy_sse`

### 7.6 Automated vs not yet automated

**Automated**:

- Preset provider (`id: mail`)
- Setup guidance copy (covering the `/setup` flow + QQ Mail config example)
- Default URL pointing at the intranet shared deployment, with a local dev alternative documented

**Not yet automated (future work)**:

- No "go to setup page" shortcut button (users must remember the `/setup` URL)
- No confirmation dialog before sending (`send_email` / `send_email_draft` execute directly, relying on agent discipline)
- `mail-mcp` already reserves `draft_response.preview.text/html` fields (in draft tool JSON responses) for a future confirmation dialog, but EO2Weave does not consume them yet

---

## 8. OpenPencil Setup

OpenPencil fits the **local desktop app + extension proxy** scenario.

### 8.1 Known premises

- OpenPencil is an open-source AI-native design editor
- Can open `.fig` files
- Built-in MCP server (90+ tools)
- Supports `stdio` and `HTTP`
- The HTTP MCP is spawned automatically by the desktop app
- Collaborates with the running app locally via WebSocket / a local port
- Automatically generates:
  - `OPENPENCIL_MCP_AUTH_TOKEN`
  - `OPENPENCIL_MCP_CORS_ORIGIN`

### 8.2 Why direct page connection is discouraged

Although OpenPencil exposes a local HTTP MCP interface, connecting to local addresses from the browser runs into:

- CORS
- Browser restrictions on local address access
- Desktop app runtime dependencies

So on this platform the recommendation remains:

> **Proxy OpenPencil's local MCP through the browser extension bridge.**

### 8.3 Recommended integration shape

Add a user server in MCP Settings, for example:

- `id`: `openpencil`
- `name`: `OpenPencil MCP`
- `url`: determined by the actual local HTTP MCP address OpenPencil exposes
- `transport`: follow the actual OpenPencil HTTP MCP protocol
  - Standard SSE → `legacy_sse`
  - Standard streamable HTTP → `streamable_http`
- `token`: the auth token provided by OpenPencil

### 8.4 Pre-integration checklist

1. The OpenPencil desktop app is running
2. Its built-in MCP service started with the app
3. The actual MCP URL is confirmed
4. The auth token is obtained
5. Connection goes through the extension bridge, not a direct page fetch

### 8.5 Not yet automated

There is **no** OpenPencil preset in the project yet, so manual configuration is needed:

- Preset provider
- Setup guidance copy
- Finer error hints

For a productized integration later, follow the Figma approach and add an OpenPencil preset.

---

## 9. Standard Steps for Adding a New Out-of-Page MCP Service

When integrating a new out-of-page MCP service, follow this flow:

### Step 1: Confirm the protocol shape

Determine whether the service offers:

- `streamable_http`
- `legacy_sse`
- or `stdio` only

> Note: the web platform mainly supports HTTP shapes; pure `stdio` services cannot be integrated by a web page directly — a desktop layer or proxy must convert them first.

### Step 2: Confirm the auth model

Clarify:

- Whether a Bearer token is needed
- Where the token comes from
- Whether extra headers are required
- Whether there is a session header (e.g. `mcp-session-id`)

### Step 3: Confirm it is an out-of-page service

As long as the service is outside the current page context, treat it as out-of-page:

- Don't put it under the WebMCP concept
- Don't let the page `fetch` directly
- Always go through the extension bridge

### Step 4: Add the config entry in the UI

At minimum the user must be able to configure:

- id
- name
- url
- transport
- token
- timeout

To lower the barrier, also add:

- Preset provider
- Setup checklist
- Common error hints

### Step 5: Verify the full chain

At minimum verify:

1. `server/discover`, or legacy `initialize`
2. `tools/list`
3. A real `tools/call` on one tool
4. If tasks are supported, also verify:
   - `tasks/get`
   - `tasks/result` (2025 Tasks); modern task results arrive in `tasks/get`
   - `tasks/cancel`, and modern `tasks/update` (JSON-RPC methods on the MCP endpoint)

---

## 10. Current Implementation Status

### Done

- `mcp-client.service.ts` production client goes through the extension bridge uniformly
- SDK requests use `mcpNetworkFetch`; `mcpProxyFetch` and `mcpProxyFetchStream` remain for legacy pages
- Supports timeout forwarding
- Supports capturing `mcp-session-id` from response headers
- Task polling also goes through the bridge
- MCP Settings integrates the Figma preset and Mail MCP preset
- Enhanced failure hints for Figma / Mail MCP connections
- Docs cover: Figma Remote, Mail MCP (both shared intranet and local dev deployments)

### Not done

- OpenPencil preset
- OpenPencil-specific setup copy
- OpenPencil-specific error hints
- Mail MCP pre-send confirmation dialog (`draft_response.preview` fields pending consumption)
- More complete productized docs/test matrix for out-of-page MCP services

---

## 11. Suggested Next Steps

If productization continues, prioritize:

### P1

- Add an OpenPencil preset
- Add a setup checklist for OpenPencil
- Write a test checklist for out-of-page MCP services

### P2

- Distinguish in MCP Settings between:
  - WebMCP
  - Out-of-page MCP services
- Make it clearer to users which kind of capability they are configuring

### P3

- A more standard preset catalog for common services
- Unified error classification:
  - Extension unavailable

## Official SDK and background Tasks

The browser client uses `@modelcontextprotocol/client@2.4.0` and
`@modelcontextprotocol/ext-tasks@0.2.2`. Each service has an independent SDK
Client, Transport and Tasks session. Automatic negotiation supports legacy
initialization and modern discovery. The advanced **Legacy initialize** setting
skips discovery when a legacy endpoint cannot handle the probe. Authentication
and network failures are surfaced instead of triggering a compatibility fallback.

Transport configuration is normalized on load, import and export:

| Configuration | Meaning |
| --- | --- |
| `streamable_http` | SDK Streamable HTTP; JSON and POST SSE responses |
| `legacy_sse` | SDK traditional GET SSE connection with separate POST messages |
| old `sse` | Migrated to `streamable_http`; the old label meant POST streaming |

`protocolMode` defaults to `auto`. Old stored connection session IDs are cleared;
only a saved task's own legacy session snapshot can be used for task recovery.
Bearer Token settings continue to work. There is no new OAuth login flow, Node
backend, browser stdio transport or Native Host protocol migration.

The extension's `mcp_network_v2` port sends response headers followed by Base64
byte chunks, completion or an error. Cancellation and port disconnection abort the
upstream fetch. A timeout bounds response headers; the SDK/task layer owns each
request's deadline. A live event stream has no five-minute lifetime limit. The
old bridge remains available for older clients. New pages connected to an older
extension can make ordinary HTTP calls, but must upgrade for durable Tasks,
traditional SSE and reliable stream cancellation.

### Calling and controlling tasks

`call_tool` accepts MCP-only `execution_mode: "background" | "wait"`. Background
is the default when the call has a project and conversation. A synchronous tool
still returns its original content immediately. A standard task returns
`submitted: true`, `completed: false`, `local_task_id`, `remote_task_id` and its
status, so the Agent can continue other work. Calls without an owner wait for the
final result. Explicit background mode is rejected for WebMCP tools.

After receiving a background task ID, the Agent reports it as pending and continues
independent work or ends its turn. It must not automatically loop over
`wait/status/result`; waiting or retrieving results requires an explicit user
request, including Send to AI from the task card. System instructions, tool
descriptions and submission receipts guide this behavior; it is not an authorization
gate. The outer tool deadline for `mcp_tasks.wait` leaves at least five seconds beyond
the local wait so a 30-second wait does not race the general tool timeout.

`mcp_tasks` operates only on the current project's known records:

| Action | Behavior |
| --- | --- |
| `list` | List known tasks, optionally filtered by `conversation_id` |
| `status` | Read current remote and local observation states |
| `result` | Return original final protocol content, or current state |
| `wait` | Wait locally for 10 seconds by default, at most 30 seconds |
| `cancel` | Request remote cancellation after Agent authorization |
| `resume` | Resume observation of an existing reference after authorization |

Neither `resume` nor recovery replays `tools/call`. Private REST task endpoints,
`arguments.task` injection and JSON task IDs embedded in text content are not
recognized. A user argument named `task` remains an ordinary tool argument.

SQLite v19 adds `mcp_tasks` and `mcp_task_inputs`. Submissions are recorded before
sending. The durable handoff boundary is a saved task reference owned by the
page-level manager. Stopping the Agent after handoff leaves the remote task
running. Before handoff a known task is cancelled on a best-effort basis. A lost
creation response becomes **Submission outcome unknown** and is never replayed
automatically. Transport/authorization failures pause local observation without
inventing a remote failed state. Transient observation failures use 2, 5, 10 and
30 second backoff; authentication and protocol errors pause for intervention.

Web Locks coordinate one observer per endpoint/generation/remote task. Other
same-origin tabs receive updates and input requests over BroadcastChannel. The
page releases local ownership on unload; no extension worker polls tasks while
the page is closed. Recovery requires the same endpoint and authentication
identity, an enabled service, and a still-valid remote task. Legacy HTTP tasks
also require their original session and capability snapshot. Expired/missing
sessions are reported without creating a replacement task.

Final protocol content is preserved, including images, embedded resources and
structured content. Results over 256,000 serialized characters use the existing
asset I/O under the owning project's `assets/mcp-tasks` directory, independently
of the originating conversation's lifetime. Task records contain references and
capability/session snapshots, never copied bearer tokens or model API keys.

### Temporary task cards and standard input

MCP task cards appear above the original conversation input only when needed. Running
rows show service, tool, status and elapsed time. Polling updates the row without
adding messages or stealing focus. Completed results can be inspected inline or sent
using **Send to AI**. **Later** collapses the area into one row; completion does not
force it open. Two entries are shown initially, with more available on expansion.
Pause, resume, cancellation and input handling remain in the expanded card. The old
corner trigger and task dialog have been removed.

New tasks and previously unfinished tasks are eligible. Older completed records do
not produce cards; records remain in the database and can be queried with `mcp_tasks`.
Result inspection does not call a model. Failed, cancelled or unknown submissions can
be acknowledged without deleting their record or resubmitting the tool.

Completion produces one deduplicated notification and never starts a model call.
**Send to AI** creates an ordinary user message referencing the local task ID in the
original conversation without changing the input draft or historical tool calls.
The card disappears once the message is persisted, without waiting for model completion.
Busy conversations use **Add to message queue** and the existing queue UI. Removing,
clearing or losing that queue on refresh restores the card without automatic requeueing.
Sent and acknowledged states survive refresh. Missing conversations, unavailable results
and delivery failures keep the card visible with an explanation.

Ordinary SDK input requests and Tasks inputs share one application handler bound
to the original project/conversation. Forms validate their schema and support
accept/decline/cancel. Password-like values stay in memory and are requested
again after refresh. URL elicitation shows the service URL and requires a user
click; the application does not fetch it or enter credentials. Sampling previews
the supplied messages, configured model and bounded output budget, then waits
for explicit approval. Only server-supplied messages enter the model request;
unsupported modalities, forced tool choices and providers that cannot enforce
the budget are rejected. Sampling tool calls are returned as data and never
executed. Roots always return `{ roots: [] }`. The separate binary-upload
business flow is unchanged.

### Verification commands

```sh
cd web
pnpm test:run mcp
pnpm test:run agent
pnpm test:run components
pnpm test:run store sqlite services
pnpm typecheck
MCP_LONG_TASK=1 pnpm test:run mcp/__tests__/long-task.integration.test.ts
```

The last command runs a real-time 305-second SDK/relay fixture without launching
a browser. It does not substitute for testing an installed extension against a
real service. The optional `playwright.mcp.config.ts` harness covers installed
MV3 extension behavior, two Tasks generations, reload recovery, cross-tab input
and cancellation; run it only when browser testing is requested. Its repository
adapter is deliberately browser-local, while SQLite schema/DDL are tested
separately. `MCP_E2E_EXTENSION` selects the exact built extension directory and
`MCP_LONG_TASK=1` enables its long task case. Normal extension output remains
`browser-extension/dist/chrome-mv3`; development output remains separate.
