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
execution (default 10000, maximum 30000). Calls on the same tab are serialized;
dialog responses can bypass the queue to unblock page execution. Navigation
waits on browser lifecycle events rather than a fixed delay.

Web emits `creatorweave:bash-cancel` when an execution ends or its worker stops.
The provider cancels pending requests through its own bridge. A queued canceled
request cannot start an action; running page JavaScript is terminated. Actions
already dispatched cannot be undone. The provider also cancels pending work on
pagehide and when its bridge finishes or times out. Invocation still passes only
args/stdin; cancellation does not add tool context to the protocol.

Chrome's `debugger` permission is required. Chrome displays its debugger
indicator. `browser detach` releases the connection without closing the tab.
Restricted browser pages and competing debugger clients may reject attachment;
errors follow the same JSON contract.

## WebMCP workflows

Builtin and custom VFS packages invoke `tools.bash` directly. Every browser
command specifies the invocation's target tab; no selected-tab state or side-panel
binding is required. Check the returned exit code, preserve failure details, and
reject truncated output when parsing complete JSON. `browser eval` returns
`{tabId, logs, result}` so page logs are separate from business data.

The catalog provides `packageRoot` for both mounts. Shared pure DOM readers live
as ordinary files inside the package and are read through Bash/VFS; workflows
combine them with their page function explicitly. No QuickJS imports or injected
browser SDK is required. Missing resources fail instead of being ignored.

Use native input/navigation commands for actions and observational waits for
application state. Never automatically repeat failed mutating operations. The
Web Bash worker serializes concurrent executions, includes queue time in each
deadline, and cancels queued calls without interrupting another running command.
Workspace-initiated adapter invocations run directly in the SW after the normal
WebMCP authorization/routing gates, so target navigation does not lose the final
response. Chrome supplies target URL/document identity; page code cannot select
an arbitrary workflow source or forge the target document.

The live E2E suite is `pnpm --dir web test:e2e:webmcp` after rebuilding the extension.
It loads the actual MV3 build and Web workspace, creates a real isolated OPFS/SQLite
project, and invokes every manifest workflow on live Jmail/Douban pages through
normal discovery and WebMCP invocation. It never intercepts site responses or
substitutes browser, extension or tool APIs. Setup uses the development app's
own stores to create the workspace without an LLM account; it does not replace
the tool host. Failed cases retain diagnostics/screenshots in
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

Reload the built `browser-extension/dist/chrome-mv3/` extension and the workspace
page after building. Development and production WXT output directories differ.
