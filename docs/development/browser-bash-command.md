# Browser Bash command

The extension registers `browser` through the open Bash provider API on trusted
workspace pages. Its implementation is in
`browser-extension/lib/bash-commands/browser/`. The provider owns its transport;
Web checks extension liveness through a real round-trip.

`browser` uses familiar browser automation verbs but is its own JSON API, not
Playwright CLI. `browser help` returns the manual as JSON. The same manual is
included in the Agent's Bash tool description. No `man` or `--json` is needed.

## Output and composition

Each non-empty stdout/stderr contains one JSON value followed by a newline.
Success writes a result to stdout and exits 0. Failure writes
`{error: {name, message, details?}}` to stderr and exits 1. The other stream is
empty. Screenshots return `{tabId, mimeType, encoding: "base64", data}`.

Filtering, searching, saving, and sequences belong to Bash and jq:

```bash
browser tab-new https://example.com --background
browser tab-list | jq '.tabs[] | select(.url | contains("example.com")) | .tabId'
browser snapshot | jq '.nodes[] | select(.role == "button")'
ref=$(browser snapshot | jq -er '.nodes[] | select(.role == "button" and .name == "Save") | .ref')
browser click "$ref" && browser snapshot
printf 'hello world' | browser fill e20
browser press Enter
browser eval '() => document.body.innerText' | jq -r '.result'
browser screenshot --full-page | jq -r '.data' | base64 -d > screenshot.png
```

There are no `find`, `text-content`, `cdp`, `--submit`, output file, or automatic
post-action snapshot features. Use snapshot/jq, page eval, and Bash composition.

## Primitives

| Capability | Commands |
| --- | --- |
| Tabs | `tab-list`, `tab-new [url] [--background]` (alias `open`), `tab-select <id>`, `tab-close [id]`, `close` |
| Navigation | `goto <url>`, `reload`, `go-back`, `go-forward`; `--wait-until=load\|domcontentloaded\|commit` |
| Observation | `snapshot [ref\|css] [--boxes]`, `eval [function] [ref\|css]` |
| WebMCP | `webmcp list`, `webmcp exec <exact-name> [json-object]`; selected tab or `--tab=<id>` |
| Targeted input | `click`, `dblclick`, `hover`, `drag <start> <end>`, `fill <target> [text]`, `type <target> [text]`, `select <target> <value>...`, `check`, `uncheck` |
| Keyboard | `press <key>`, `keydown <key>`, `keyup <key>`; chords such as `ControlOrMeta+A` |
| Mouse | `mousemove <x> <y>`, `mousedown [button]`, `mouseup [button]`, `mousewheel <dx> <dy>` |
| Screenshots | `screenshot [ref\|css] [--full-page] [--format=png\|jpeg] [--quality=0..100]` |
| Dialogs and connection | `dialog-accept [prompt]`, `dialog-dismiss`, `detach` |

Tab selection uses stable Chrome IDs, never list indices. `--tab=<id>` overrides
selection for one call. Selection is stored per workspace document in Chrome
session storage. New background tabs become the command's selected tab without
activating the browser tab. There is no implicit choice of the user's active tab.

Snapshots retain the source accessibility/DOM collection and semantic locator
synthesis. Results contain `{tabId,url,title,snapshotId,tree,nodes}`; nodes expose
refs, semantic properties, parent/child relationships and optional boxes. CSS
selectors search open shadow roots and must match one element. Refs resolve the
exact backend DOM node, with no fallback to a similar element. Navigation,
removal, and debugger detachment invalidate cached snapshots. Detached refs fail;
capture again when the page changes.

Targeted actions share visibility and stability checks. Pointer actions also
wait for enabled state and an unobstructed hit target. Fill replaces text; type
appends to the specified element. Both use browser input events, and read stdin
when text is omitted. Empty stdin can clear an input. Keyboard modifiers and held
mouse buttons persist across calls; failed actions release tracked input state.

Eval accepts a function, including an async function, or reads its source from
stdin. The optional target is passed as an element argument. It runs in the page
with page globals and native fetch. It has no Node environment or nested tool
proxy. Success returns `{tabId,logs,result}`. `logs` is an ordered array of
`{level,args}` entries; each argument and the final `result` preserve JSON types
(objects, arrays, strings, numbers, booleans and null). Console arguments are
captured when logged, without joining strings or adding text prefixes.

```json
{"tabId":123,"logs":[{"level":"log","args":["hello",{"count":2}]}],"result":{"title":"Page title"}}
```

Use `jq -r '.result.title'` to read the title or
`jq '.logs[] | select(.level == "warn") | .args'` to filter warnings.
Undefined and non-finite numbers become null; bigint and symbols become strings,
functions become descriptive strings, and Error values become `{name,message,stack}`.
Circular references become `"[Circular]"`; values that cannot be serialized become
`"[UnserializableValue]"`. Repeated non-circular references preserve their values.
Thrown errors fail with `{tabId,logs,exception}` in `error.details`, retaining
prior console output separately from the serialized exception. No `buffer` field
is emitted. Consumers of the previous format must migrate to `.result` and `.logs`.
Reading DOM text and waiting on page conditions can be implemented in eval;
orchestration of browser commands belongs to Bash.

## Execution and lifecycle

`--timeout=<ms>` is one deadline covering queueing, locating, waiting, and
execution (default 10000, maximum 30000; `webmcp exec` defaults to and allows
60000). Primitive calls on the same tab are serialized; WebMCP orchestration and
dialog responses bypass the queue to unblock nested page operations. Navigation
waits on browser lifecycle events rather than a fixed delay.

Web emits `creatorweave:bash-cancel` when an execution ends or its worker stops.
The event's `detail.inputs` scopes cancellation to the original external-command
input objects for that execution. The provider cancels matching requests through
its own bridge, not a waiting outer shell's requests. A queued canceled
request cannot start an action; running CDP evaluations are terminated. Native
WebMCP tools may still finish after cancellation stops waiting. Actions
already dispatched cannot be undone. The provider also cancels pending work on
pagehide and when its bridge finishes or times out. Invocation still passes only
args/stdin; cancellation does not add tool context to the protocol.

Chrome's `debugger` permission is required. Chrome displays its debugger
indicator. `browser detach` releases the connection without closing the tab.
Restricted browser pages and competing debugger clients may reject attachment;
errors follow the same JSON contract.

## WebMCP workflows

Builtin and custom packages are executed directly by the WXT service worker.
They do not use Bash, a CreatorWeave workspace host or package/VFS access.
Workflow callbacks receive only `browser` and `console` as extension capability
globals, plus their normal input/state/target context.

`browser` is the typed equivalent of this `browser` command. Direct calls
resolve to command results and reject on failure; they do not return
`stdout`, `stderr`, `exitCode` or `truncated`. Pass
`{ tab: target.tabId }` to target-specific operations. `browser.eval` returns
`{ tabId, logs, result }` directly. Shared DOM helpers must be inlined into the
eval function because package reader files are not readable from the workflow
runtime.

Use `browser.webmcp.list({ tab })` and
`browser.webmcp.exec(exactName, args, { tab })` to discover or invoke a page or
adapter tool from another workflow. These use exact-tab routing and do not fall
back to another tab. Nested calls are re-entrant: no per-route or global
execution lock is held while an adapter waits for another adapter.

From Bash, use `browser webmcp list --tab=<id>` to discover exact names and
schemas from the live target page and the SW adapter catalog. `browser webmcp
exec <name> '{}' --tab=<id>` invokes one tool after exact-tab authorization,
without same-host tab fallback. Arguments may also come from stdin. `list` returns
`{tabId,url,hostname,groupKey,tools,pageProbeError?}`; `exec` returns
`{tabId,url,name,source,result}`. Check `pageProbeError` before interpreting an
empty catalog. See [WebMCP packages](webmcp-packages.md#exact-tab-discovery-and-execution).

Use native input/navigation commands for actions and observational waits for
application state. Never automatically repeat failed mutating operations.
Adapter invocations have independent QuickJS sessions and no global concurrency
cap. Individual CDP operations may queue on a tab, but `browser.webmcp.exec`
does not hold the queue open while a nested tool runs. Package withdrawal,
explicit cancellation and timeout abort in-flight work; target navigation does
not. Chrome supplies target URL/document identity; page code cannot select an
arbitrary workflow source or forge the target document.

The live E2E suite is `pnpm --dir web test:e2e:webmcp` after rebuilding the extension.
It loads the actual MV3 build without opening CreatorWeave, enables the built-in
and custom packages through the extension, and invokes every manifest workflow
on live Jmail/Douban pages through normal page discovery and WebMCP invocation.
It also exercises a custom package and a nested `browser.webmcp.exec` chain. It
never intercepts site responses or substitutes browser, extension or tool APIs.
Failed cases retain diagnostics/screenshots in
`output/playwright/webmcp-real/`. Site/network failures remain failures.
Set `WEBMCP_E2E_CHROMIUM` to a Chromium/Chrome-for-Testing executable if the installed
Playwright browser is unavailable; branded Chrome may refuse unpacked extension
flags. `WEBMCP_E2E_HEADLESS=1` enables headless Chromium where MV3 is supported.

## Verification

```bash
pnpm --dir web test:run agent
pnpm --dir web typecheck
pnpm --dir browser-extension typecheck
node browser-extension/scripts/test-browser-commands.mjs
pnpm --dir browser-extension build
```

The Chrome test uses an isolated profile, real page/CDP execution and adapted
extension APIs. It verifies the minified command runtime; it is not an end-to-end
test of the installed extension relay. It uses Chrome's native viewport without
Playwright device emulation.

Reload the built `browser-extension/dist/chrome-mv3/` extension and target tabs
after building. Development and production WXT output directories differ.
