---
name: cw-webmcp-creator
description: Create and debug WebMCP packages that expose website actions as tools through behavior-tree workflows. Use when a website needs reusable WebMCP tools or an existing package needs repair.
version: 1.0.0
---

# WebMCP creator

Create packages in the extension-owned OPFS WebMCP directory, mounted as vfs://external/webmcp. The extension reads and validates package manifests locally; the app accesses files through the provider and supplies a connected workspace tool host. Tools register forwarding proxies on pages whose complete URL matches their urlRegex. The extension service worker schedules each behavior tree in TypeScript and runs its user callbacks in one fresh QuickJS session; source code is never sent to the target page. Keep the CreatorWeave workspace host open: tool calls are routed back to that bound workspace through a bidirectional bridge. URL matching controls page registration and triggering. Once triggered, condition/wait inspect functions decide readiness and action run functions report their outcome; the adapter runtime does not gate execution on the initiating page URL, document lifetime, host authorization or tool-group authorization. Host tools retain their own availability and permission rules.

## Package files

```text
/external/webmcp/com.example.tools/
  manifest.json
  config.json
  read-page.js
  search.js
```

These are bash paths. File tools use `vfs://external/webmcp/com.example.tools/manifest.json` and `vfs://external/webmcp/com.example.tools/read-page.js`. Each immediate directory is a package. Its directory name must equal its manifest id.

Built-in packages use the same package structure and parser at `vfs://external/builtin-webmcp`. This mount is read-only, including its `config.json`; enable built-in packages only from the extension's WebMCP Packages page. You may read their manifests and workflow sources as examples, or copy a package into the writable mount using a new package id. Duplicate namespaces across mounts are reported as conflicts and neither package registers.

Each package may have `config.json`. All fields are optional. The first supported field is `activation`, with enum values `"enabled"` and `"disabled"`; booleans and unknown fields are invalid. Missing config or missing activation resolves to disabled. To enable a custom package, write `{"activation":"enabled"}` to its config file after validation. The extension management page can also toggle custom packages. Invalid configuration withdraws the package and appears as a diagnostic in the management page. Source visibility is independent of activation. The legacy recipe switch store is ignored.

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

Tool paths are relative .js files inside the package; subdirectories are supported. Paths cannot escape the package directory. Descriptions explain each tool's action and effects. Input and output schemas belong to the whole workflow.

## URL matching

urlRegex is a JavaScript regular expression string without flags. It must start with ^ and end with $. Matching uses the browser's normalized, complete HTTP(S) URL.href, including query and hash, and requires a complete-string match. JSON requires double escaping for regex backslashes. Escape literal hostname dots and explicitly handle query/hash when those should be accepted. A rule can match multiple domains or routes.

Use actual page URLs to check positive and negative cases. Include a different path and a similar-looking hostname that should not match. Page URL changes trigger rematching and registration or withdrawal of the tool. Match only the pages the tool can handle; inspect still checks login, DOM readiness and action prerequisites.

## Tool source and behavior tree

Each tool file exports one literal object with `inputSchema`, `outputSchema`, `tree`, and `result`. The tree is a nested object structure; the old step-array format is not supported. Schemas use JSON literals. Callbacks are function expressions, arrow functions or object methods. There are no imports, named exports or top-level helper declarations; helpers can be declared inside callbacks or stored in invocation state.

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
    type: 'wait',
    description: 'Wait for readable page content',
    intervalMs: 200,
    timeoutMs: 10000,
    async inspect({ state, target }) {
      const output = await tools.bash({ command: `browser snapshot --tab=${target.tabId}` });
      if (output.exitCode !== 0) throw new Error(output.stderr);
      if (output.truncated) throw new Error('Browser output was truncated');
      const snapshot = JSON.parse(output.stdout);
      if (snapshot.tabId !== target.tabId) throw new Error('Browser returned another tab');
      state.text = snapshot.tree;
      return Boolean(state.text);
    }
  },
  result({ state }) { return { text: state.text }; }
};
```

Node definitions:

- `sequence`: `{ type: 'sequence', children: [...] }`. Advance after success, stop on failure, stay on the running child. Empty sequences succeed.
- `selector`: `{ type: 'selector', children: [...] }`. Try children in order; advance on failure, stop on success, stay on the running child. Empty selectors fail.
- `condition`: `{ type: 'condition', inspect(context) { return boolean; } }`. False means this branch fails, not “wait.”
- `wait`: `{ type: 'wait', inspect(context) { return boolean; }, intervalMs?, timeoutMs? }`. False remains running until true or the optional timeout. The default interval is zero and there is no node timeout unless supplied. Timeouts are checked between inspections; they do not interrupt an in-flight callback.
- `action`: `{ type: 'action', async run(context) { return 'success'; } }`. Return exactly `success`, `failure`, or `running`. A returned running status causes this callback to be invoked on a later tick. Await one-shot actions to completion before returning success; do not repeat irreversible effects while polling.

Every node may have a nonempty `description`. Both composites remember their position for the invocation. Completed siblings are not reevaluated. For “already at target, otherwise navigate and wait,” use a selector containing a condition and a sequence of action + wait. There is no automatic fallback on exceptions: a thrown error fails the invocation, while a returned failure activates normal BT branching.

Schemas use JSON Schema Draft-07. Local $ref references are supported; external schemas are not fetched. The workflow inputSchema must explicitly have type: object because it supplies WebMCP arguments. outputSchema describes the final business result and may be any JSON schema, including a boolean schema.

Every invocation starts with `{ input: <tool arguments>, state: {}, target: { tabId, url }, packageRoot }`. Input is validated before any user callback. Input is not automatically replaced by action results. Store intermediate values in state; `result(context)` runs once after root success, and its returned value is validated against outputSchema. Undefined final results become null. Success returns `{ status: 'success', result: ... }`; root failure returns `{ status: 'failure' }` without invoking result or validating output. Invalid statuses, invalid booleans, schema failures and exceptions fail the tool call.

User callbacks run in a persistent QuickJS session for one invocation; SW holds BT progress. The context, closures and other business state remain inside the VM between callbacks and may include Map or functions. Only callback return values, host tool arguments/results, and the final result cross the boundary as JSON. There is no direct DOM, window, fetch, timer or native AbortSignal. The SW schedules another tick after 25 ms when the tree returns running; an async callback is awaited without reinvoking it. A new invocation starts a new tree and VM. This is in-memory execution, not recovery after the SW process is terminated.

The `tools.*` calls are capabilities routed to the open CreatorWeave workspace. Use `await tools.name(args)` or `await invokeTool(name, args)` with the same schemas and result values as `run_code`. Available tools depend on the workspace host's current agent mode. If run_code is exposed, it can be called like any other tool; its own nested tool list excludes run_code to prevent self-recursion.

For browser operations call `tools.bash` directly with the extension's `browser` command, specifying `--tab=${target.tabId}` on every call. Both builtin and custom VFS packages use this same path; it requires an available Bash tool, a connected extension and a mode permitting external Bash commands. Check `exitCode` explicitly and propagate command failures; there is no automatic retry of mutating operations. Shell-quote page-derived URLs and user text as positional data, and use `--` before positionals that can begin with `--`. Use `&&` for dependent actions and `set -o pipefail` when a pipeline must preserve failures.

`browser eval` returns JSON `{tabId, logs, result}`. Parse `stdout`, check the response tab, and read `result` for business data. `logs` preserves console output separately. Use eval for DOM extraction and observational checks, commands such as `fill`, `press`, `click` for native input, and `goto --wait-until=domcontentloaded` for navigation. Put one-shot changes in actions; observational waits may retry a destroyed navigation context, but other errors must propagate. A running action may track a submitted flag or paging position in state to avoid repeating effects; state holds invocation data, not script libraries. Preserve each operation's ordering, limits, fallback branches and return fields when simplifying DOM extraction.

`packageRoot` is the Bash/VFS directory of the invocation's package, for example `/external/webmcp/com.example.tools/`. The catalog supplies it uniformly for builtin and custom packages. Reuse genuinely shared, site-specific pure DOM readers as ordinary package files, such as `readers/dom.js`. Read them with `cat` through Bash and combine their source with the operation's page function before calling `browser eval`. This is explicit file composition; QuickJS has no module loader and workflow imports remain forbidden. Keep actions, branching and output assembly in workflows. Missing reader files must fail the Bash script; do not continue after a failed `cat`. Resource edits refresh the catalog, but unreferenced resources are not statically compiled by `webmcp validate`; verify their execution on the live site.

Workspace capabilities are explicit. Agent questions, mode switching, delegation, subagent management and conversation search are private and unavailable through this host, including inside run_code.

run_code returns JSON `{ok:true,value,output}` or `{ok:false,error,output}`. `image()`, `text()` and console output only populate this execution's output array. They never change the external caller's context or implicitly change the workflow return. Select `result.value` for the business result, checking `result.ok` first. If you return the whole execution result, your outputSchema must allow its output array and both success/failure shapes. read_image returns `{type:'image',data,mimeType,path,width,height}` without automatic OCR. `browser screenshot --tab=<id>` returns JSON `{tabId,mimeType,encoding:'base64',data}`; returning image data does not automatically display it. Awaited nested outputs stay local unless deliberately returned as part of the workflow JSON.

Keep inspect observational and put actions in run. Observe the result of browser actions before returning. Workflows run in the service worker and survive target navigation and refresh, preserving tree progress and guest state across nodes. Navigation commands wait for the requested lifecycle event; use a destination wait for application data that loads afterward. The target in the workflow context records the initiating tab and URL, not the live URL. Use inspect to assess the current page through browser commands; the runtime does not recheck the initiating URL or document before host calls. A page-local proxy loses its response listener on full navigation. Workspace-originated invocations wait in the service worker and return their final result across navigation. Keep the workspace host open. Await every tool call: pending calls are canceled on completion, package withdrawal, host disconnect, workspace switch, explicit cancellation or timeout. Target tab closure does not automatically cancel a workflow; browser commands report the missing tab as an error. Calls may already have side effects. Workflows have a 55-second wall-clock limit and a 1-second guest CPU budget. Invocations of the same or different routes can execute concurrently with independent state, within the runtime concurrency limit. Their Bash calls are serialized by the workspace worker, including queue time in each deadline.

## Create, validate and verify

Inspect the actual target page using the Bash browser command before choosing selectors. Build the smallest workflow that implements the requested action. Use stable labels, attributes and visible content; inspect should detect missing or changed UI.

Write the manifest and all referenced tool files, then run:

```bash
webmcp validate /external/webmcp/com.example.tools
```

Relative package directories resolve from the bash working directory. Exit code 0 means the entire package passed, 1 reports an invalid or unreadable package, and 2 indicates incorrect usage. Validation checks required fields, package identity, tool names, source paths, URL regexes, JS structure and workflow schemas and tree nodes without executing adapter functions. It cannot prove selectors, runtime data, regex intent or site behavior. Fix diagnostics and rerun; verify success, fallback, waiting and failure cases on the intended page. Invoke mutating tools only within the user's requested scope.

Successful writes and removals, including config edits, refresh the shared mounted-package catalog immediately. Any invalid or missing referenced source withdraws the whole package. Deleting a tool from the manifest withdraws it; deleting a package directory withdraws all its tools. Unreferenced files are ignored. Disabling WebMCP disconnects the workspace host and withdraws its routes. Package files remain in extension storage for the next connection.

Reload the updated extension and refresh both CreatorWeave and target tabs opened before that version. Page CSP does not compile workflow code. Keep a workspace selected and WebMCP enabled in the host. Browser commands require the connected extension and an agent mode that allows external Bash commands. An explicitly bound side-panel host takes priority; multiple otherwise matching hosts make a tool unavailable rather than selecting an arbitrary workspace. Inspect the target page console for `[WebMCP adapters] Injection failed` and the extension service worker console for catalog/validation diagnostics.
