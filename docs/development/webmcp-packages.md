# WebMCP packages

A WebMCP package exposes website actions as tools. Each tool is a behavior-tree
workflow that the browser extension runs in a QuickJS session inside its service
worker. Target pages only receive tool metadata and a forwarding proxy; workflow
source never reaches the page.

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
  readers/*.js      # optional shared helpers read via packageRoot
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
`action`. Callbacks receive `{ input, state, target: { tabId, url }, packageRoot }`.

Browser operations go through `tools.bash` with the extension `browser` command,
passing `--tab=${target.tabId}`. `browser eval` returns `{ tabId, logs, result }`.
Browser commands need the `debugger` permission (see the extension README).

Execution limits: 55 s deadline, 1 s guest CPU budget, 8 concurrent executions
globally, one in-flight execution per route. Disconnect, workspace switch,
package replacement, navigation and cancellation abort in-flight work; started
side effects are not rolled back.

The authoritative authoring guide is the `cw-webmcp-creator` skill at
`browser-extension/skills/cw-webmcp-creator/SKILL.md`.

## Validate

```bash
webmcp validate /external/webmcp/com.example.tools
```

Exit code 0 means the whole package is valid, 1 means invalid/unreadable, 2 means
incorrect usage. Writes and removals refresh the package catalog immediately.

## Code map

| Area | Location |
|---|---|
| Catalog and config parsing | `packages/shared/src` |
| Package repository, management, provider handler | `browser-extension/entrypoints/webmcp/package-*.ts`, `provider*.ts` |
| Adapter runtime (behavior tree + QuickJS) | `browser-extension/entrypoints/webmcp/adapter-*.ts`, `packages/behavior-tree`, `packages/quickjs-runtime` |
| Workspace tool host / connection | `web/webmcp/workspace-tool-*.ts` |
| Built-in packages | `browser-extension/builtin-webmcp/` |
| Live E2E | `web/tests/e2e/webmcp/real-workflows.spec.ts` (needs `WEBMCP_E2E_*` env and real sites) |
