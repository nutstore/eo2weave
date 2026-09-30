---
name: cw-webmcp-creator
description: Create and debug WebMCP adapters that expose website actions as tools through inspect/run workflows. Use when a website needs reusable WebMCP tools or an existing adapter needs repair.
version: 1.0.0
---

# WebMCP creator

Create adapters in the origin-wide OPFS WebMCP directory. The app automatically reads this directory and syncs valid adapters to the browser extension. The extension registers them in every tab with an exactly matching origin, including newly opened tabs. Existing WebMCP discovery and authorization apply to these tools.

## Files

Each tool occupies one immediate subdirectory:

```text
/webmcp/read-page-title/
  tool.json
  index.js
```

These are bash paths. File tools use `vfs://webmcp/read-page-title/tool.json` and `vfs://webmcp/read-page-title/index.js`.

`tool.json` has exactly four required fields:

```json
{
  "origin": "https://example.com",
  "name": "read-page-title",
  "description": "Read the title of the current page.",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  }
}
```

Use the actual page origin, including scheme and non-default port, without a path or trailing slash. Wildcards and subdomain expansion are unavailable. Tool names start with a letter and contain up to 64 letters, digits, underscores or hyphens. Names must be unique within an origin; use a site-specific prefix where native or bundled tools could collide. Write a precise description of the action and its effects. Use a valid JSON Schema object for arguments.

`index.js` contains one default export of a nonempty literal array. Every step has exactly `description`, `inspect`, and `run`. There are no imports, SDK modules, named exports, or top-level helper declarations. Helpers may be declared inside step functions.

```js
export default [
  {
    description: 'Read the page title',
    inspect({ args, state, signal }) {
      if (!document.title.trim()) {
        return { status: 'blocked', message: 'This page has no title yet. Wait for it to load and invoke the tool again.' };
      }
      return { status: 'ready' };
    },
    run({ args, state, signal }) {
      return { title: document.title, url: location.href };
    }
  }
];
```

## Workflow behavior

Each invocation starts at the first step with `{ args, state: {}, signal }`. `args` contains the tool arguments. `state` is shared between that invocation's steps; store intermediate values there. Concurrent calls have separate state. Functions can be async and execute in the target page, with access to its DOM and browser APIs.

For each step the runner awaits `inspect(context)`:

- `{ status: 'blocked', message: '...' }` ends the whole workflow immediately. The WebMCP result contains `status: 'blocked'`, the one-based step number, its description and the message. The message should identify what prevented execution and a concrete next action.
- `{ status: 'ready' }` causes the runner to await `run(context)` and advance to the next step.

The final result is `{ status: 'completed', result: <last run return value> }`; an undefined return becomes null. Other inspect states and exceptions fail the call. There is no implicit retry, recovery agent, skip, resume or backtracking. A later invocation starts from step one, so avoid repeating irreversible actions after a subsequent step blocks.

Keep inspect observational. Put actions in run. Check route, login state, required elements and prerequisites before each action. For route-specific tools, return blocked on other paths within the same origin. After a DOM action, await a bounded condition for the expected change before returning. Full page navigation destroys the workflow; return a useful navigation result and use a later call on the destination page. Do not assume state survives navigation. Respect `signal` in long asynchronous operations; it is aborted when the adapter is replaced or removed.

## Create and validate

Inspect the actual target page using the available page tools before choosing selectors. Build the smallest workflow that implements the requested action. Use stable labels, attributes and visible content; inspect should detect missing or changed UI instead of guessing.

Write both files, then validate with the built-in bash command:

```bash
webmcp validate /webmcp/read-page-title
```

Relative directories resolve from the bash working directory. Exit code 0 means the metadata and workflow structure passed, 1 reports an invalid or unreadable adapter, and 2 indicates incorrect command usage. Fix the diagnostic and rerun. Validation parses JavaScript without executing it: it cannot prove selectors, site behavior, inspection return values or permissions. It checks that inputSchema is an object schema; verify its full JSON Schema semantics when authoring it.

While the app is open and WebMCP is enabled, valid changes are synced approximately every three seconds. The existing discovery loop then observes registrations. The extension must support adapter sync; reload the updated extension and refresh already-open target tabs if they predate that version. The extension retains the latest snapshot for future tab loads. Invalid, incomplete, deleted or conflicting adapters are withdrawn on the next sync. To remove a tool, delete its adapter directory while the app is open. Disabling WebMCP in the app syncs an empty adapter snapshot.

Verify the tool on the intended page, including a blocked case. Invoke mutating tools only within the user's requested scope. The target page's Content Security Policy may prohibit dynamic JavaScript compilation; format validation cannot detect that. Inspect the target page console for `[WebMCP adapters] Injection failed` and the app console for sync/validation errors. Do not disable a site's CSP to make an adapter work.
