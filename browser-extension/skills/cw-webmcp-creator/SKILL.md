---
name: cw-webmcp-creator
description: Create and debug WebMCP packages that expose website actions as tools through behavior-tree workflows. Use when a website needs reusable WebMCP tools or an existing package needs repair.
version: 1.0.0
---

# WebMCP creator

## Package files

Create packages under `vfs://external/webmcp` (Bash path: `/external/webmcp`):

```text
com.example.tools/
  manifest.json
  config.json
  read-page.js
  search.js
```

The directory name must equal the manifest id. Built-in examples at `vfs://external/builtin-webmcp` are read-only; copy them with a new id to edit. Duplicate ids across mounts prevent registration.

`config.json` accepts only `activation: "enabled" | "disabled"`; missing configuration means disabled. Validate before writing `{"activation":"enabled"}`. Enable built-in packages from the extension's WebMCP Packages page.

## Manifest

All fields shown are required:

```json
{
  "id": "com.example.tools",
  "version": "1.0.0",
  "description": "Example website tools",
  "tools": [
    {
      "name": "read-page",
      "description": "Read a snapshot of an article page.",
      "urlRegex": "^https://example\\.com/articles(?:/[^?#]*)?(?:\\?[^#]*)?(?:#.*)?$",
      "path": "./read-page.js"
    }
  ]
}
```

- `id`: reverse-domain namespace using lowercase letters, digits and hyphens in dot-separated segments.
- `version`: semantic version.
- Tool `name`: starts with a letter; up to 64 letters, digits, underscores or hyphens; unique within the package. Registered as `<package-id>.<name>`, at most 128 characters.
- `path`: relative `.js` file inside the package; subdirectories allowed.
- `urlRegex`: flag-less regex anchored with `^` and `$`, matching the complete normalized HTTP(S) URL including query and hash. Escape hostname dots and JSON backslashes. Test accepted URLs and similar URLs that must not match. URL changes update registration.

## Workflow

Each file contains one `export default` literal object with `inputSchema`, `outputSchema`, `tree` and `result`. No imports, named exports or top-level helpers. Declare helpers inside callbacks.

Schemas use JSON literals and JSON Schema Draft-07; local `$ref` is supported. `inputSchema.type` must be `object`. `outputSchema` describes the value returned by `result`.

Example `read-page.js`:

```js
export default {
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false
  },
  tree: {
    type: 'action',
    async run({ state, target }) {
      const snapshot = await browser.snapshot(undefined, { tab: target.tabId });
      state.text = snapshot.tree;
      return 'success';
    }
  },
  result({ state }) { return { text: state.text }; }
};
```

Callbacks receive `{ input, state, target: { tabId, url } }`. `state` persists within an invocation; `target.url` is the initiating URL. Input is validated before execution. After root success, `result(context)` runs once and its output is validated; undefined becomes null. Adapter outcomes are `{status:'success', result:...}` or `{status:'failure', diagnostics:{node, logs}}`. Failure diagnostics identify the node path, type, optional description, elapsed milliseconds, reason, and an optional truncated last browser observation. `result` is not called on failure. Exceptions carry diagnostics in the invocation error instead.

| Node | Definition and behavior |
|---|---|
| `sequence` | `children: [...]`; advance on success, stop on failure. |
| `selector` | `children: [...]`; try the next child on failure, stop on success. |
| `condition` | `inspect(context)` returns boolean; false fails the branch. |
| `wait` | `inspect(context)` returns boolean; false keeps waiting. Optional `intervalMs` and `timeoutMs` default to zero interval and no timeout. |
| `action` | `run(context)` returns exactly `success`, `failure` or `running`; running repeats the callback on a later tick. |

Composites retain progress and do not rerun completed children: these are one-shot workflows, not reactive trees. Every node accepts an optional nonempty `description`. Exceptions fail the invocation; they do not trigger selector fallback. A wait that reaches its deadline between inspections returns failure and can select a fallback. Positive deadlines also bound in-flight inspections and cancel their browser calls; an interrupted inspection ends the entire invocation with `JS_WAIT_TIMEOUT`, because the shared VM cannot safely resume after interruption. Zero timeout allows one immediate inspection but no asynchronous waiting. Late successful inspections do not override a positive deadline.

Keep `inspect` observational. Perform one-shot effects in `run`, then poll completion with `wait`. Use `selector(condition, sequence(action, wait))` for “already there, otherwise navigate and wait.”

Returning `running` reruns the entire action callback on the next tick. An action
that clicks “Load more” and then returns `running` while loading will click again.
Use a sequence with an action that awaits the click and returns `success`, followed
by a wait that only observes loading. A still-pending action Promise is awaited;
it is not called again while pending. Use `running` only when repeated callbacks
are intentional and any one-shot effects are explicitly guarded.

## Browser API

Callbacks run in QuickJS with `browser` and `console`. There is no package/file access, Bash, DOM, `window`, `URL`, `fetch`, timers or Chrome API. Run page code through `browser.eval` and return JSON data.

`console.log/info/warn/error` use an independent synchronous event channel and do
not consume total or concurrent browser-call quotas. Each message is truncated to
2048 characters. The first 100 messages are printed in the extension service worker
console; failure diagnostics retain the most recent 100. Logging still uses guest
CPU and memory, so avoid logging entire snapshots in polling loops.

Pass `{ tab: target.tabId, timeout: ... }` explicitly. Browser calls return results directly and reject on errors. Await every call.

```js
const page = await browser.eval('() => document.title', { tab: target.tabId });
// page: { tabId, logs, result }
await browser.goto('https://example.com/search', {
  tab: target.tabId, 'wait-until': 'domcontentloaded', timeout: 15000
});
await browser.fill('#query', input.query, { tab: target.tabId });
await browser.press('Enter', { tab: target.tabId });
await browser.click('#result', undefined, { tab: target.tabId, activate: true });
const snapshot = await browser.snapshot(undefined, { tab: target.tabId });
```

Other methods: `open`, `close`, `tab.list/new/select/close`, `goBack`, `goForward`, `reload`, `evalElement`, `dblclick`, `type`, `keydown`, `keyup`, `hover`, `select`, `check`, `uncheck`, `drag`, `mouse.move/down/up/wheel`, `dialog.accept/dismiss`, `screenshot`, `detach`. `browser.exec(command, positionals, options)` calls any browser CLI command.

`browser.click` requires its target tab to be active and throws otherwise. Pass `activate: true` to make the click bring a background tab to the foreground first.

Expose shared extraction as a read-only WebMCP tool. Readers observe once; callers poll them from `wait`. Register readers on destination URLs where needed and avoid circular calls.

```js
const catalog = await browser.webmcp.list({ tab: target.tabId });
const response = await browser.webmcp.exec(exactName, args, {
  tab: target.tabId, timeout: 15000
});
// response: { tabId, url, name, source, result }
// Adapter tools return their workflow outcome in response.result:
if (response.result.status !== 'success') throw new Error('Nested workflow failed');
const value = response.result.result;
```

Use exact `tools[].name` values from discovery. Native page tools define their own result contracts. Nested calls retain exact-tab routing and support multiple levels.

Workflows survive navigation; wait for destination data after the navigation lifecycle event. Limits: 55 seconds wall time, 1 second guest CPU. Cancellation, timeout and package withdrawal abort pending calls; completed effects remain.

## Verify

1. Inspect the actual page before choosing selectors; check login, hydration and loading states.
2. Write the manifest and tool files, then run:

   ```bash
   webmcp validate /external/webmcp/com.example.tools
   ```

   Exit codes: 0 valid, 1 invalid/unreadable package, 2 incorrect usage. Validation does not execute workflows.
3. Test success, waiting, empty results and failure on the intended pages. Verify results belong to the requested URL/query/item. Perform mutations only within the user's scope.
4. Enable the package after validation. File/config changes refresh registration; an invalid or missing referenced file withdraws the package.

For built-in source changes, rebuild/reload the extension and refresh existing target tabs. Browser operations require the extension's `debugger` permission. Check the extension service worker console for registration and execution errors.
