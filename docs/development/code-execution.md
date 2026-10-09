# Code execution

Tools return data, code selects its output, and the caller owns presentation.
`read_image` and `run_code` never enqueue conversation messages or modify model
context. The same execution result can be consumed by the Agent or a WebMCP
workflow without assuming either caller has a conversation.

## Tool composition and the JSON contract

`run_code` accepts required nonempty `purpose` and `code` strings. Direct tools
remain available. Code composes the current caller's capabilities using
`await tools.name(args)` or bracket access for names containing punctuation.
It cannot invoke itself. Nested calls recheck availability, capability scope,
Plan/Act policy, schemas and execution hooks through `services/tool-invocation.ts`.
Successful V2 envelopes yield their `data`; other JSON is parsed and plain text
stays a string. Ordinary tool failures reject with `code` and `toolName`.

`services/code-execution.ts` constructs a portable execution result:

```ts
type OutputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
type RunResult =
  | { ok: true; value: JsonValue; output: OutputPart[] }
  | { ok: false; error: { code: string; message: string; [key: string]: JsonValue }; output: OutputPart[] }
```

The internal tool wraps this in a successful V2 transport envelope, with UI-only
`meta.calls`. Script failure is represented by `data.ok === false`, preserving
accepted output before failure, timeout or cancellation. WebMCP and nested tool
callers receive the unwrapped RunResult, including script failures. Transport,
authorization and argument errors still reject. The portable contract and
`CODE_RUN_RESULT_SCHEMA` live in `@creatorweave/shared/code-output`.

`return` selects `value`; no return becomes null. `text(value)`, `image(value)` and
`console.log/info/warn/error/debug` synchronously append to the invocation's
`output`. `output.forward(child.output)` explicitly forwards another result's
output. Calling a tool, returning a nested result or receiving an envelope with
`contentParts` does not implicitly forward media. Output order is emission order;
code can await parallel calls and then emit in its chosen order.

```js
const images = await Promise.all([
  tools.read_image({ path: 'photos/first.png' }),
  tools.read_image({ path: 'photos/second.png' }),
])
text('Compare these two images')
for (const result of images) image(result)
return { count: images.length }
```

Output is limited to 1000 parts and 6 MiB of serialized UTF-8 JSON. These limits
include text, media and JSON overhead. Exceeding them produces `JS_OUTPUT_LIMIT`
and retains earlier output. The complete RunResult has an 8 MiB transfer limit;
an oversized value produces `JS_RESULT_LIMIT` while keeping accepted output.
Text output does not consume the asynchronous host-call quota. Arguments, values
and output must be lossless JSON; functions, cycles, BigInt, non-finite numbers
and native objects are rejected. Await all work that must complete: unfinished
host calls are canceled on exit and may already have performed side effects.
Programs are never automatically retried.

## Images and consumer presentation

`read_image` returns `{type:'image', data, mimeType, path, width, height}`. It uses
the existing VFS permissions and image normalization limits: 10 MiB source,
20 million decoded pixels, 4096-pixel edge and 4 MiB normalized binary data.
There is no dependency on provider capabilities, OCR or handoff callbacks.
`page_screenshot` exposes bytes through `result.image`. MCP `call_tool` retains
`content`, resource blocks and `structuredContent`, including mixed text/images.
Untrusted external text keeps its existing security wrapper.

`image()` accepts an image block, raw base64 or an inline base64 data URL. It
checks the base64 shape and image signature and derives MIME for PNG, JPEG,
GIF or WebP; it rejects remote URLs. Inline bytes make the result portable for
external callers without access to CreatorWeave's OPFS. Reference-based transport
can be introduced later only with an explicit resource-access contract.

The Agent adapter projects only top-level run_code output, direct read_image data
or explicitly declared envelope contentParts into multimodal tool results. It
removes image bytes from text presentation and truncates the combined textual
output against the context budget. A text-only model receives an image omission
marker; OCR requires a separate explicit tool call. Text/image order survives
message persistence and replay. UI traces and direct image preview data stay in `Message.displayContent` and
are excluded from model context. Historical deferred-context and read-image
handoff metadata remains readable; new executions produce neither.

WebMCP receives ordinary JSON. Its workflow's `run` return is validated against
that step's outputSchema. Nested output is never appended to the return object or
caller context. For a workflow returning a count, select the value explicitly:

```js
const result = await tools.run_code({
  purpose: 'Inspect the selected image',
  code: 'const imageData = await tools.read_image({path:"photos/first.png"}); image(imageData); return 1',
})
if (!result.ok) throw new Error(result.error.message)
return { count: result.value }
```

If the workflow instead returns the entire RunResult, its outputSchema must
allow that contract. The external caller decides whether to render or incorporate
its `output`. Public workspace capabilities use an explicit allowlist, enforced
again for nested calls. Agent questions, delegation, mode switching, subagent
management and conversation search are not exposed. Shared invocation has no
conversation writes; Agent-specific elicitation and file-change observations
are installed by the Agent consumer only.

## Generic runtime

`web/runtime/quickjs/client.ts` exports `executeCode(request, bindings, signal)`.
It has no dependencies on agent tools, conversations, OPFS or WebMCP. Callers
provide JSON `globals`, asynchronous host `functions`, an optional synchronous
JSON `onEvent` sink and a trusted `setup` script. Events carry invocation-local
data; the runtime has no media or conversation semantics. One Worker and VM
serve one execution. Compiled WASM is cached and cloned; mutable VM state is
never reused. Late events after completion are ignored by the client.

```ts
const result = await executeCode(
  { code: 'return await double(input)', filename: 'example.js', setup: '', limits: DEFAULT_LIMITS },
  { globals: { input: 21 }, functions: { double: async ([value]) => Number(value) * 2 } },
  abortController.signal,
)
```

No filesystem, network, DOM or timers are injected. Babel parses the strict
async-function wrapper without TypeScript or JSX. Diagnostics map to the original
source; dynamic imports are rejected. Default limits are 10 seconds of guest CPU,
10 minutes elapsed time, 64 MiB memory, 200 host calls, 16 concurrent calls and
8 MiB per transfer. Host waiting does not consume the CPU budget. A main-thread
watchdog terminates an unresponsive Worker and cancels host work via AbortSignal;
it cannot undo external side effects. WebMCP workflows retain their own shorter
55-second elapsed and 1-second CPU limits.

Pinned `quickjs-wasi` WASM is copied by `scripts/copy-quickjs.mjs` during dev/build;
no CDN is required. Babel 7 remains pinned for the Node 20 release workflow.
