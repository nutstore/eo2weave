# WebMCP packages

A WebMCP package exposes website actions as tools. Each tool is a behavior-tree
workflow that the browser extension runs in a QuickJS session inside its service
worker. Target pages only receive tool metadata and a forwarding proxy; workflow
source never reaches the page. The extension owns discovery, registration,
execution and the browser capability, so tools continue to work with
CreatorWeave closed.

## Mounts

| Mount | Bash path | Access | Contents |
|---|---|---|---|
| `vfs://external/builtin-webmcp` | `/external/builtin-webmcp` | read-only | Packages shipped in `browser-extension/builtin-webmcp/` |
| `vfs://external/webmcp` | `/external/webmcp` | read/write (extension OPFS) | User and agent-authored packages |
| `vfs://external/extension-skills` | `/external/extension-skills` | read-only | Extension-owned skills (`browser-extension/skills/`), e.g. `cw-webmcp-creator` |

The mounts are fs providers (see `fs-providers.md`). Providers may advertise
`skillRoots`; `SKILL.md` files below those roots are discovered by the Web app
(`web/skills/provider-skills.ts`) and listed with ids `provider:<id>:<path>`.

## Package layout

```text
com.example.tools/
  manifest.json     # id, version, description, tools[]
  config.json       # optional: { "activation": "enabled" | "disabled" }
  workflows/*.js    # one file per tool (subdirectories allowed)
```

The directory name must equal the manifest `id` (reverse-domain, lowercase
letters/digits/hyphens in dot-separated segments). Registered tool names are
`<package-id>.<tool-name>` (max 128 chars). Every manifest and tool field is
required: `name`, `description`, `urlRegex`, `path`.

- `urlRegex` is a flag-less JavaScript regex anchored with `^...$`, matched
  against the complete normalized `URL.href` including query and hash. URL
  changes re-evaluate registration.
- A missing `config.json` or missing `activation` means disabled. Built-in
  packages are enabled from the extension's WebMCP Packages page only; their
  `config.json` is read-only.
- Duplicate package ids across mounts are conflicts; neither registers. An invalid
  or missing referenced source withdraws the whole package and shows a diagnostic.

## Workflow source

Each tool file has one `export default` literal object with `inputSchema`,
`outputSchema` (JSON Schema Draft-07, `inputSchema.type` must be `object`),
`tree` and `result`. Nodes: `sequence`, `selector`, `condition`, `wait`,
`action`. Callbacks receive `{ input, state, target: { tabId, url } }`.

Workflows expose only `browser` plus `console` as capability globals. `browser`
is the extension-owned equivalent of the `browser` command. Pass
`{ tab: target.tabId }` for target-specific operations:

```js
const page = await browser.eval('() => document.title', { tab: target.tabId })
await browser.goto(url, {
  tab: target.tabId,
  'wait-until': 'domcontentloaded',
  timeout: 15000,
})
```

Browser promises return the command result directly and reject on failure.
They do not return `{ stdout, stderr, exitCode, truncated }`. `browser.eval`
returns `{ tabId, logs, result }`. Use `browser.exec()` for generic CLI argument
composition and the direct methods for typed calls. Browser workflows require
the extension's `debugger` permission (see the extension README).

Package/VFS access, `tools`, `invokeTool`, `packageRoot`, Bash, DOM, `fetch`,
timers and Chrome APIs are absent. DOM extraction runs inside a self-contained
`browser.eval` page function. Put shared extraction in a registered read-only
tool and compose it with `browser.webmcp.exec`; do not load helper files or
copy a reader library into each workflow. Browser globals such as `URL` also
belong in the page function, not the QuickJS callback.

## Composing page readers

Each built-in package registers its own `read_page` tool, so packages remain
independently usable. It takes optional `limit` and `query` arguments and reads
one snapshot without navigating, clicking, filling fields or waiting. It returns
`{ ready: false }` while the document is loading. A ready snapshot includes
`kind`, `url` (absolute), `path`, `route` (path and query), `params`, and
`page_title`, followed by package-specific data:

| Package | Snapshot data |
|---|---|
| `com.douban.movie` | Movie lists, subject details/comments/reviews/TV metadata, celebrity profiles; search results on `search.douban.com` |
| `com.douban.search` | Current query, ordered search results and `results_ready` |
| `world.jmail.archive` | Email rows, thread content, people/topics, pager and date-filter controls |
| `world.jmail.messages` | Conversation list, search results, current conversation and visible messages |

`ready` describes the document, while `results_ready` describes list data. An
empty result array alone does not prove loading has finished. Supplying `query`
lets a search reader reject results for an old query; Douban also avoids reading
rate-limit text on an old query page. Use the URL, query or selected item id to
check that a snapshot belongs to the requested operation.

A business workflow performs an action once, then polls the reader in a `wait`
node. For example, after navigating to the Douban chart:

```js
{
  type: 'wait',
  description: 'Wait for chart rows',
  intervalMs: 250,
  timeoutMs: 15000,
  async inspect({ input, state, target }) {
    const response = await browser.webmcp.exec(
      'com.douban.movie.read_page',
      { limit: input.limit || 10 },
      { tab: target.tabId, timeout: 15000 }
    )
    if (response.result.status !== 'success') throw new Error('Page reader did not succeed')
    const page = response.result.result
    if (!page.ready || page.kind !== 'chart' || !page.results_ready) return false
    state.result = { count: page.results.length, results: page.results }
    return true
  }
}
```

The outer response is the browser command envelope. For an adapter tool,
`response.result` is its `{ status, result }` workflow outcome, so the snapshot
is `response.result.result`. A native page tool may have a different result
contract. Read tools must not call their business callers: dependencies flow
from business workflows to readers, ending at browser observations.

Readers are normal discoverable WebMCP tools with schemas and URL matching.
Their `urlRegex` must include destination URLs where callers use them after
navigation. They enforce the same host/group authorization and exact-tab routing
as other tools. Selectors returned in a snapshot are short-lived; callers should
use them immediately and observe the destination after the input operation.

Execution limits are 55 s wall time and 1 s guest CPU. Adapter invocations have
no global concurrency cap and no per-route execution lock. Package replacement,
explicit cancellation and timeout abort in-flight work; navigation does not.
Started side effects are not rolled back. Individual CDP browser primitives may
queue on a tab, but `browser.webmcp.exec` bypasses that queue while another
adapter is running, so re-entrant and multi-level WebMCP calls do not deadlock.

The authoritative authoring guide is the `cw-webmcp-creator` skill at
`browser-extension/skills/cw-webmcp-creator/SKILL.md`.

## Exact-tab discovery and execution

The extension's `createTabWebMCPApi` provides `listForTab(tabId, signal)` and
`invokeForTab(tabId, name, args, signal)`. Discovery probes the target page and
merges available adapters directly from the service worker catalog; adapter
metadata does not depend on page proxy injection or the web app's tool cache.
Native page-tool host and group authorization still applies at the exact-tab
API. Extension adapter execution has no workspace binding. Specifying a tab
never falls back to another same-host tab. The legacy routed invoke also treats
`preferredTabId` as a strict target when supplied.

The Bash browser command exposes the API:

```bash
browser webmcp list --tab=123 | jq '.tools[] | {name,source,inputSchema}'
browser webmcp exec com.example.tools.focus_search_box '{"query":"hello"}' --tab=123
printf '%s' '{"query":"hello"}' | browser webmcp exec com.example.tools.focus_search_box --tab=123
```

Without `--tab`, commands use the browser command's selected tab. Use exact
`tools[].name` values from `list`, not the web app's prefixed `call_tool` names.
Arguments must be a JSON object; omitted arguments read stdin or default to `{}`.
Results are JSON on stdout; command failures are JSON on stderr with exit code 1.
`list` includes `pageProbeError` when page discovery failed, so an incomplete
catalog must not be interpreted as proof that the page has no tools.
`exec` returns `{tabId,url,name,source,result}` and defaults to a 60-second
deadline (`--timeout` can shorten it). Adapter workflows retain their own
55-second deadline. Cancellation reaches adapter execution; native page tools
may still finish their side effects after the caller stops waiting. Lost
responses are not retried. A legacy page probe is only used when no relay
receiver exists.

Adapter calls inside a workflow use `browser.webmcp.list()` and
`browser.webmcp.exec()`. The outer WebMCP invocation does not hold the CDP tab
queue closed, so nested browser operations and adapters can complete without
waiting on their own caller. There is no execution lock or fixed concurrency
cap. Explicit cancellation and package withdrawal still abort in-flight calls.

## Validate

```bash
webmcp validate /external/webmcp/com.example.tools
```

Exit code 0 means the whole package is valid, 1 means invalid/unreadable, 2 means
incorrect usage. Writes and removals refresh the package catalog immediately.

Run live extension verification with `cd web && WEBMCP_E2E_HEADLESS=1 pnpm test:e2e:webmcp`.
The suite opens the extension management page and target sites without starting
CreatorWeave or selecting a workspace. Douban acceptance checks the expected URL
only; unloaded content and site rate limits are retained as diagnostics. jmail
cases assert business results, and a custom package verifies two nested
`browser.webmcp.exec` calls. A separate calling tab retains navigation results
while a target document unloads.

## Code map

| Area | Location |
|---|---|
| Catalog and config parsing | `packages/shared/src` |
| Package repository, management, provider handler | `browser-extension/entrypoints/webmcp/package-*.ts`, `provider*.ts` |
| Adapter runtime (behavior tree + QuickJS) | `browser-extension/entrypoints/webmcp/adapter-*.ts`, `packages/behavior-tree`, `packages/quickjs-runtime` |
| Exact-tab API / Bash entry | `browser-extension/entrypoints/webmcp/tab-api.ts`, `browser-extension/lib/bash-commands/browser/` |
| Extension transport / page proxy | `browser-extension/entrypoints/adapter-injector.content.ts`, `browser-extension/entrypoints/webmcp.content.ts` |
| Built-in packages | `browser-extension/builtin-webmcp/` |
| Live E2E | `web/tests/e2e/webmcp/real-workflows.spec.ts` (needs `WEBMCP_E2E_*` env and real sites) |
