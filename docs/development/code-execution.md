# Code execution

`run_code` accepts two required nonempty strings: `purpose` and `code`. All allowed
ordinary tools remain directly visible to the model. The code tool composes them
using `await tools.name(args)` or bracket access for names containing punctuation.
It cannot invoke itself. Each nested invocation rechecks current availability,
Plan/Act policy, argument schemas and execution hooks through `invokeTool`.

```js
const result = await tools.read({ path: 'vfs://workspace/example.txt' })
return result
```

Successful V2 envelopes return their `data`; other JSON returns parsed data and
plain text returns a string. Failures reject with an Error containing `code` and
`toolName`. Intermediate results stay outside model context. `return` preserves
JSON values; no return becomes null. Logs are limited to 64 KiB. Tool arguments and
return values must be lossless JSON; functions, cycles, BigInt and non-finite
numbers are rejected. Always await work that must finish.

## Generic runtime

`web/runtime/quickjs/client.ts` exports `executeCode(request, bindings, signal)`.
It has no dependencies on agent tools, conversations, OPFS or WebMCP. Callers supply
`globals`, asynchronous host `functions`, and a trusted `setup` script (empty when
unneeded). Each execution receives an isolated Worker and VM. Compiled WASM is
cached by the client and cloned to the Worker; mutable VM state is never reused.

```ts
const result = await executeCode(
  {
    code: 'return await double(input)',
    filename: 'example.js',
    setup: '',
    limits: DEFAULT_LIMITS,
  },
  {
    globals: { input: 21 },
    functions: { double: async ([value]) => Number(value) * 2 },
  },
  abortController.signal,
)
```

Use empty binding maps for pure JS execution. No filesystem, network, DOM or timers
are injected. Babel parses the same strict async-function wrapper used by QJS,
without TypeScript or JSX extensions. Diagnostics map to the original source.
Dynamic imports are rejected because the runtime provides no module loader.

Default limits: 10 seconds of guest CPU time, 10 minutes total elapsed time,
64 MiB guest memory, 200 host calls, 16 concurrent host calls, 8 MiB per transfer.
Host waiting does not consume the guest CPU budget. Approval tools retain their
own timeout exemptions, within the overall elapsed-time budget. A main-thread
watchdog terminates an unresponsive Worker. Termination cancels host work via an
AbortSignal but cannot undo side effects already performed by external tools.

WASM is copied from pinned `quickjs-wasi` by `scripts/copy-quickjs.mjs`, called by
both dev and build scripts. No CDN or extension is required. Babel 7 is pinned for
compatibility with the repository's Node 20 release workflow.

## Deferred context and traces

Tools can emit `context.deferContext(parts)` while executing. Each invocation
owns a collector that closes on completion, error, timeout or cancellation. Late
emissions are ignored. Nested `read_image` handoffs are captured by that collector;
image content from successful tool envelopes is also deferred automatically.

The code adapter orders deferred content by invocation order and event order,
then attaches it to the enclosing `run_code` result. It does not synthesize
assistant tool calls or orphan tool results. The caller sees the context on its
next model request, including observations emitted before failure or cancellation.

UI-only child traces live in `Message.displayContent`; source metadata lives in
`Message.deferredContext`. SQLite persists both, but model conversion excludes
those fields. Model-facing content already contains the deferred parts and is
not expanded again on replay. Trace result text is capped at 2 Mi characters with
an explicit truncation marker. There is no session-global context queue.

The shared invocation entry preserves existing per-tool retry behavior;
`run_code` itself never automatically retries a program with possible side effects.
