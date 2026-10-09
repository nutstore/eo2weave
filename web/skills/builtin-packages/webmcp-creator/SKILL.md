---
name: cw-webmcp-creator
description: Create and debug WebMCP packages that expose website actions as tools through inspect/run workflows. Use when a website needs reusable WebMCP tools or an existing package needs repair.
version: 1.1.0
---

# WebMCP creator

Create packages in the origin-wide OPFS WebMCP directory. The app reads package manifests and syncs valid packages to the extension. Tools register forwarding proxies on pages whose complete URL matches their urlRegex. The extension service worker runs each workflow in a fresh QuickJS VM; source code is never sent to the target page. Keep the CreatorWeave workspace host open: tool calls are routed back to that bound workspace through a bidirectional bridge. Existing discovery and authorization apply to these tools.

## Package files

```text
/webmcp/com.example.tools/
  manifest.json
  read-page.js
  search.js
```

These are bash paths. File tools use `vfs://webmcp/com.example.tools/manifest.json` and `vfs://webmcp/com.example.tools/read-page.js`. Each immediate directory is a package. Its directory name must equal its manifest id.

Every manifest field and every tool field below is required:

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

Use a reverse-domain package id, with lowercase letters, digits and hyphens in dot-separated segments. It is a stable namespace, independent of the URLs the package targets. Version uses semantic versioning. Give each tool a name starting with a letter and containing at most 64 letters, digits, underscores or hyphens. Names must be unique within a package. The registered name is `<package-id>.<tool-name>`, at most 128 characters, so different packages can use the same local tool names.

Tool paths are relative .js files inside the package; subdirectories are supported. Paths cannot escape the package directory. Descriptions explain each tool's action and effects. Input and output schemas belong to the tool's steps.

## URL matching

urlRegex is a JavaScript regular expression string without flags. It must start with ^ and end with $. Matching uses the browser's normalized, complete HTTP(S) URL.href, including query and hash, and requires a complete-string match. JSON requires double escaping for regex backslashes. Escape literal hostname dots and explicitly handle query/hash when those should be accepted. A rule can match multiple domains or routes.

Use actual page URLs to check positive and negative cases. Include a different path and a similar-looking hostname that should not match. Page URL changes trigger rematching and registration or withdrawal of the tool. Match only the pages the tool can handle; inspect still checks login, DOM readiness and action prerequisites.

## Tool source and steps

Each tool file contains one default export of a nonempty literal array. Every step has exactly five required fields: description, inputSchema, outputSchema, inspect and run. Schemas use JSON literals; expressions, variables and getters are unavailable in schemas. There are no imports, SDK modules, named exports or top-level helper declarations. Helpers can be declared inside step functions.

Example `read-page.js`:

```js
export default [
  {
    description: 'Read the article page',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    outputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, url: { type: 'string' } },
      required: ['text', 'url'],
      additionalProperties: false
    },
    async inspect({ state }) {
      // page_snapshot requires a side-panel host bound to this target tab.
      const snapshot = await tools.page_snapshot({ maxNodes: 1000 });
      state.text = snapshot.tree_text;
      return state.text
        ? { status: 'ready' }
        : { status: 'blocked', message: 'The article is not loaded yet. Wait and invoke the tool again.' };
    },
    run({ state, target }) {
      return { text: state.text, url: target.url };
    }
  }
];
```

Schemas use JSON Schema Draft-07. Local $ref references within a schema are supported; external schemas are not fetched. Recognized format keywords are validated. The first inputSchema must explicitly have type: object, because it supplies the WebMCP tool argument schema. Later schemas can describe any JSON value, including primitives, arrays and null; boolean schemas are also supported.

Every invocation starts with `{ input: <tool arguments>, state: {}, target: { tabId, url } }`. Each step's input is validated before inspect. Functions run in QuickJS in the extension service worker, so there is no direct DOM, `window`, `fetch`, timers, native AbortSignal or persistent global state. The `tools.*` calls are host capabilities routed back to the open CreatorWeave workspace; they are not APIs implemented inside QuickJS. Use `await tools.name(args)` or `await invokeTool(name, args)` with the same schemas and result values as `run_code`. A tool is available when the workspace host exposes it in the current agent mode. The host owns cancellation. State is shared across steps of one invocation. If `run_code` is available, it can be called like any other tool; its own nested tool list excludes `run_code` to prevent self-recursion.

inspect must return one of:

- `{ status: 'blocked', message: '...' }`: end the workflow immediately and return status, one-based step number, description and message. Give a concrete reason and next action. No run or later step executes; blocked results bypass the step's outputSchema.
- `{ status: 'ready' }`: await run, validate its output, and pass that output as the next step's input.

Undefined run returns become null before output validation. Invalid input/output, invalid inspect states and exceptions fail the call. Completion returns `{ status: 'completed', result: <last step output> }`. There is no implicit retry, skip, recovery, resume or backtracking. A later invocation starts from step one; avoid repeating irreversible actions after a subsequent step blocks.

Keep inspect observational and put actions in run. Use the injected tools to observe the result of page actions before returning. Full page navigation destroys the workflow: return a useful navigation result and invoke a tool on the destination page later. State does not survive navigation. Await every tool call: pending calls are canceled on completion, withdrawal, host disconnect, workspace switch or target navigation. Calls may already have side effects. Workflows have a 55-second wall-clock limit and a 1-second guest CPU budget; calls to an already-running adapter route are rejected to prevent recursion. Different routes can execute concurrently with independent state.

## Create, validate and verify

Inspect the actual target page using available page tools before choosing selectors. Build the smallest workflow that implements the requested action. Use stable labels, attributes and visible content; inspect should detect missing or changed UI.

Write the manifest and all referenced tool files, then run:

```bash
webmcp validate /webmcp/com.example.tools
```

Relative package directories resolve from the bash working directory. Exit code 0 means the entire package passed, 1 reports an invalid or unreadable package, and 2 indicates incorrect usage. Validation checks required fields, package identity, tool names, source paths, URL regexes, JS structure and every step schema without executing adapter functions. It cannot prove selectors, runtime data, regex intent or site behavior. Fix diagnostics and rerun; verify successful and blocked cases on the intended page. Invoke mutating tools only within the user's requested scope.

While the app is open and WebMCP is enabled, changes sync approximately every three seconds. Any invalid or missing referenced source withdraws the whole package. Deleting a tool from the manifest withdraws it; deleting a package directory withdraws all its tools. Unreferenced files are ignored. Disabling WebMCP syncs an empty package snapshot. The extension retains the latest snapshot for future tab loads.

Reload the updated extension and refresh both CreatorWeave and target tabs opened before that version. Page CSP does not compile workflow code. Keep a workspace selected and WebMCP enabled in the host. Page tools require a side panel bound to the target; other tools keep their normal prerequisites. An explicitly bound side-panel host takes priority; multiple otherwise matching hosts make a tool unavailable rather than selecting an arbitrary workspace. Inspect the target page console for `[WebMCP adapters] Injection failed` and the app console for sync/validation diagnostics.
