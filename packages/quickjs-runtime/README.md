# QuickJS runtime

This package executes async JavaScript function bodies in an isolated QuickJS VM.
It does not depend on the web app, an agent loop, an extension, or another workspace
package. The caller supplies a compiled WASM module, bindings, execution limits,
and an abort signal. Each execution creates and disposes its own VM; the compiled
WASM module can be reused across concurrent executions.

```ts
import { DEFAULT_LIMITS, executeQuickJs } from '@creatorweave/quickjs-runtime'

const result = await executeQuickJs(
  wasm,
  {
    code: 'return await double(input.value)',
    filename: 'example.js',
    setup: '',
    limits: DEFAULT_LIMITS,
  },
  {
    globals: { input: { value: 21 } },
    functions: { double: async ([value], signal) => Number(value) * 2 },
  },
  new AbortController().signal,
)
// { ok: true, value: 42 }
```

`globals` injects lossless JSON values. `functions` injects async host calls that
receive JSON arguments and a host-owned cancellation signal, and return JSON.
Both use the same global namespace; collisions and `__qjs` names are rejected.
`setup` is caller-owned guest JavaScript evaluated after injection and before
the async function body. It can build namespaced APIs around the injected calls.
Functions and native host objects cannot be injected as JSON values.
Host failures preserve `code`, `message`, and caller-owned JSON metadata, without
assuming tool names or any application-specific error schema.

The guest has JavaScript built-ins and explicitly supplied bindings. The runtime
does not install DOM, browser/extension APIs, network access, timers, `tools`, or
an application console. There is no module loader. Syntax diagnostics refer to
the caller's source. The host requires standard WebAssembly, AbortController,
TextEncoder, and timer APIs; it does not require a browser or Worker.

Limits cover wall time, guest CPU time, VM memory, total and concurrent host calls,
and JSON transfer size. Host waiting does not consume guest CPU time. Execution
returns a structured success or failure, disposes guest handles, and cancels
unfinished host calls on exit. Host functions must observe cancellation where
supported; canceling does not undo side effects.

WASM loading and packaging, Workers and messaging, tool policies, logs, traces,
and application result envelopes belong to consumers. The web adapter in
`web/runtime/quickjs/` owns its asset loading, Worker protocol, and watchdog.

Run `pnpm test:run` and `pnpm typecheck` in this package independently of the web app.
