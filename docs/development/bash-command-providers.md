# Registering external Bash commands

Web exposes `window.creatorWeave.bash.registerCommand({ manifest, invoke, isAlive })` in
its page JavaScript context. Any extension can register commands through this
API. Each object supplies `manifest`, `invoke` and `isAlive`. Registration is immediate; same-name commands use the latest registration.
There are no provider IDs or enablement prompts.

```ts
const unregister = window.creatorWeave.bash.registerCommand({
  manifest: {
    name: 'example',
    description: 'Process text with the Example extension',
    manual: 'example [prefix]\nReads UTF-8 stdin and returns processed text.\nExample: printf "hello" | example greeting',
  },
  async isAlive() {
    // Perform a real round-trip to the extension, using its own bridge.
    return await extensionBridge.ping()
  },
  async invoke({ args, stdin }) {
    // The extension implements its own communication here.
    return { stdout: `${args[0] ?? ''}${stdin}`, stderr: '', exitCode: 0 }
  },
})

// Optional removal. This cannot remove a newer same-name registration.
unregister()
```

Contract:

- `manifest`: `name`, `description`, `manual` are strings. Names match
  `[a-zA-Z0-9_][a-zA-Z0-9_.-]*`.
- `invoke({ args: string[], stdin: string })` returns a promise resolving to
  `{ stdout: string, stderr: string, exitCode: number }`. Exit codes are integers
  from 0 to 255. Input and output are UTF-8 text; invalid UTF-8 input fails.
- Only arguments and stdin are passed to the extension. There is no filesystem,
  environment, cwd or tool context access through this API.
- Web includes the current manifests and manuals in the Agent's Bash tool
  description. There is no `man` command.
- Each Bash execution captures the registered commands at its start. Later
  registrations affect subsequent Bash executions.
- External commands are available in Act mode. Plan mode keeps its existing
  read-only sandbox and does not expose external commands with unknown effects.
- Bash pipes, redirection and conditionals work normally. Names that match
  existing commands follow just-bash command resolution; shell keywords and
  builtins retain their shell semantics.
- Exceptions and invalid results become command errors. Web emits the page event
  `creatorweave:bash-cancel` when a Bash execution ends or its worker stops,
  including timeout and explicit stop. Providers may listen and cancel their
  pending work through their own bridge. The event has no payload and does not
  change `invoke({args, stdin})`. Web cannot force arbitrary plugin code to stop
  or reverse effects; the plugin owns its transport and cancellation behavior.
- Web probes `isAlive()` every 15 seconds, before model requests and before Bash
  execution. A false result, exception or 3-second timeout removes the command.
  Web also checks liveness before each external invocation. `isAlive` must check
  the actual extension connection; returning a constant or checking a page object
  cannot detect uninstall. A returning extension must register again.
- The returned removal function is optional explicit cleanup, not the uninstall
  mechanism. Removing the latest registration does not restore an older one.

## Loading order

The API is installed when the Web app mounts. To register regardless of loading
order, run this in the **page context**:

```ts
function register() {
  window.creatorWeave.bash.registerCommand({
    manifest: { name: 'example', description: 'Echo input', manual: 'example: echo stdin' },
    async isAlive() { return await extensionBridge.ping() },
    async invoke({ stdin }) {
      return { stdout: stdin, stderr: '', exitCode: 0 }
    },
  })
}

if (window.creatorWeave?.bash) register()
else window.addEventListener('creatorweave:bash-ready', register, { once: true })
```

An isolated content script cannot directly call page JavaScript functions. The
extension supplies its own page-context adapter and bridges `invoke` to its
content script/background as needed. Web does not define that communication
protocol or verify an extension identity.

TypeScript consumers can import the public types from
`web/agent/bash-commands/registry.ts` (`ExternalBashCommand`,
`BashCommandManifest`, `BashCommandInput`, `BashCommandResult`).
