---
title: Creating a Custom Agent Tool
order: 106
---

# Creating a Custom Agent Tool

This tutorial adds a new tool the agent can call — a `word_count` tool — end to end: definition, executor, registration, Plan-mode classification, authorization, tests, and docs.

Everything here mirrors what the built-in tools do. When in doubt, read `web/agent/tools/switch-mode.tool.ts` (a small, self-contained tool) and `web/agent/tools/tool-types.ts` (the types).

> **Don't copy `web/agent/tools/ls.tool.ts` as an example.** It is a two-line re-export of `@/vfs/ls-operation`; the implementation lives in the VFS layer and is not a tool-writing template.

## 1. What a tool is

A tool is a `ToolEntry` (`web/agent/tools/tool-types.ts`):

```ts
export interface ToolEntry {
  definition: ToolDefinition
  executor: ToolExecutor
  /** Prompt doc for auto-generating the system prompt's Available Tools section */
  promptDoc?: ToolPromptDoc
}
```

Three parts, three jobs:

| Part | Type | Purpose |
| --- | --- | --- |
| `definition` | `ToolDefinition` | What the model sees: name, description, JSON Schema parameters (OpenAI function-calling shape, defined locally in `tool-types.ts` — this is **not** the OpenAI SDK type) |
| `executor` | `ToolExecutor` | What runs on the host: `(args, context) => Promise<string>` |
| `promptDoc` | `ToolPromptDoc` | Optional. The one-line entry in the system prompt's "Available Tools" section, plus a display category |

`promptDoc` is optional in the type but the built-in tools all provide it — without it the tool is callable but invisible in the prompt's tool summary, which is how agents end up forgetting it exists.

## 2. Write the definition

Create `web/agent/tools/word-count.tool.ts`:

```ts
import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'

export const wordCountDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'word_count',
    description:
      'Count words, characters and lines of a text string. ' +
      'Use it when the user asks for the length of a draft rather than for file statistics.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to measure.',
        },
      },
      required: ['text'],
    },
  },
}
```

Rules that matter:

- **`name`** is the identifier the model emits and the executor is looked up by. Keep it snake_case, unique across the registry (aliases live in `TOOL_ALIASES` in `tool-registry.ts` — don't add one unless you rename an existing tool).
- **`description`** is the only thing the model uses to decide *when* to call the tool. Say what it does **and** when not to use it.
- **`parameters`** uses the local `JSONSchema` subset (`web/agent/tools/tool-types.ts`): `string | number | boolean | array | object`, plus `enum`, `items`, `required`, `default`, `minimum`, `maximum`, `minLength`, `oneOf`. Anything outside that subset is not rendered to the model.

## 3. Write the executor

```ts
export const wordCountExecutor: ToolExecutor = async (args) => {
  const text = typeof args.text === 'string' ? args.text : ''

  if (!text.trim()) {
    return JSON.stringify({ error: 'text is required and must not be empty' })
  }

  const words = text.trim().split(/\s+/).length
  const lines = text.split('\n').length

  return JSON.stringify({
    success: true,
    words,
    characters: [...text].length, // code points, not UTF-16 units
    lines,
  })
}
```

Conventions:

- **Return a string.** In practice: `JSON.stringify(...)`. The result is what the model reads back as the tool message.
- **Do not throw for expected failures.** Return `{ error: '...' }` (see `delete.tool.ts`); the agent loop turns thrown errors into generic failures it cannot act on. Reserve `throw` for genuine bugs.
- **Validate `args` defensively.** They come from an LLM: `args` is typed `Record<string, unknown>`, so narrow each field (`typeof args.text === 'string'`) instead of casting.
- **Second parameter is `ToolContext`.** Add it only if you need it:

  ```ts
  export const wordCountExecutor: ToolExecutor = async (args, context) => {
    if (context.abortSignal?.aborted) {
      return JSON.stringify({ error: 'cancelled' })
    }
    // context.directoryHandle / context.projectId / context.currentAgentId
    // are for tools that touch the workspace — see read.tool.ts / write.tool.ts.
    // ...your logic here
  }
  ```

## 4. Register it

Edit `web/agent/tool-registry.ts` — three edits:

1. Import the pieces next to the other tool imports:

   ```ts
   import { wordCountDefinition, wordCountExecutor, wordCountPromptDoc } from './tools/word-count.tool'
   ```

2. Add the entry to `BUILTIN_TOOLS`:

   ```ts
   const BUILTIN_TOOLS: Array<{ definition: ToolDefinition; executor: ToolExecutor }> = [
     ...
     { definition: wordCountDefinition, executor: wordCountExecutor },
   ]
   ```

3. Add the prompt doc to `ALL_PROMPT_DOCS`:

   ```ts
   const ALL_PROMPT_DOCS: ToolPromptDoc[] = [
     ...
     wordCountPromptDoc,
   ]
   ```

And define the doc itself in the tool file:

```ts
export const wordCountPromptDoc: ToolPromptDoc = {
  category: 'meta',
  section: '### Text Utilities',
  lines: ['- `word_count(text)` - Count words, characters and lines of a string'],
}
```

`category` groups tools for display ordering; `section` is the markdown heading it files under (omit it to append to the previous section).

## 5. Classify it for Plan mode

Plan mode is read-only. Its gate lives in `web/agent/agent-mode.ts`:

```ts
export const TOOL_MODE_CLASSIFICATION: Map<string, ToolModeMetadata> = new Map([
  ...
  // Meta tools (read-only — no file modifications)
  ['ask_user_question', { name: 'ask_user_question', category: 'read' }],
])
```

Add:

```ts
['word_count', { name: 'word_count', category: 'read' }],
```

**The default is `write`** (`getToolCategory()` returns `'write'` for unknown names), so an unclassified tool is hidden in Plan mode. That is the safe default and the usual cause of "my tool works in Act mode but the agent never sees it in Plan mode".

## 6. Authorization

Adding a policy entry does **not** gate anything by itself. `web/agent/policy-engine.ts` exposes `authorize(req)`; the tool has to call it. Today only `call_tool` (through `external-tool-bridge.ts`) and `sync-to-disk` do — a tool that never calls `authorize()` runs regardless of what the table says about it.

The table (`createPolicyTable()` in the same file) supplies the inputs to that decision:

- `auto` — run without asking (also the default for unregistered tools)
- `prompt` — the call needs approval
- `forbidden` — never callable by the model

Most tools need neither an entry nor an `authorize()` call: no entry means `auto`. Network reads (`web_search`, `web_fetch`) are `auto` too — reaching the network is not by itself a reason to prompt.

If your tool does something irreversible — writes the real disk, deletes in bulk, rolls back — call `authorize()` inside the executor and honour a denial:

```ts
const auth = await authorize({
  toolName: 'my_disk_writer',
  args: { ... },
  conversationId: context.workspaceId,
  // Plan mode suppresses the "always allow" memory: an approval granted while
  // exploring must not pre-authorize a later act-mode call.
  mode: context.agentMode,
  signal: context.abortSignal,
})
if (auth.decision === 'deny') {
  return JSON.stringify({ error: 'AUTH_DENIED_BY_USER', reason: auth.reason })
}
// The run can be aborted between the approval and this line — check again
// before doing the irreversible part.
if (context.abortSignal?.aborted) {
  return JSON.stringify({ error: 'ABORTED' })
}
```

Then register the level in `createPolicyTable()`:

```ts
set('my_disk_writer', {
  level: 'prompt',
  describe: () => ({ key: 'describeMyDiskWriter' }),
  memoryKey: () => 'my-disk-writer',
})
```

`describe` names a key under `agent.toolAuth.*`; add it to all four locales (`packages/i18n/src/locales/{en-US,zh-CN,ja-JP,ko-KR}`) or the modal renders the raw key. `memoryKey` lets "always allow this conversation" apply per tool family.

Two behaviours come from `authorize()` itself, not from your table entry:

- With YOLO mode on, `prompt` returns `allow` without prompting. YOLO is a per-conversation switch the user controls (persisted per conversation; the LLM cannot enable it — `switch_agent_mode` force-clears it), so this is the user's own choice, not a bypass your tool introduces. `forbidden` stays denied even under YOLO — that check runs first.
- `memoryKey` is what makes "always allow this conversation" skip later prompts. Omit it (return `null`) for irreversible operations so every call asks again — that is what `snapshot_restore` does.

## 7. Test it

Tool executors are plain functions — test them without React, in `web/agent/tools/__tests__/word-count.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { wordCountDefinition, wordCountExecutor } from '../word-count.tool'

// Only the fields your executor reads need to be present.
const ctx = { directoryHandle: null } as never

describe('word_count', () => {
  it('counts words, characters and lines', async () => {
    const result = JSON.parse(await wordCountExecutor({ text: 'one two\nthree' }, ctx))
    expect(result).toMatchObject({ success: true, words: 3, characters: 13, lines: 2 })
  })

  it('counts code points, not UTF-16 units', async () => {
    const result = JSON.parse(await wordCountExecutor({ text: '😀' }, ctx))
    expect(result.characters).toBe(1)
  })

  it('rejects an empty string instead of returning zero counts', async () => {
    const result = JSON.parse(await wordCountExecutor({ text: '   ' }, ctx))
    expect(result.error).toBeDefined()
  })

  it('advertises the parameter the executor requires', () => {
    expect(wordCountDefinition.function.parameters.required).toEqual(['text'])
  })
})
```

Two assertions worth keeping in every tool test: the happy path, and the failure shape the model will actually see. A test that only checks `ok: true` passes even when the tool returns nothing useful.

Run it:

```bash
# from the repo root
cd web && pnpm test:run agent/tools/__tests__/word-count.test.ts
cd .. && make typecheck
```

## 8. Document it

Docs are bilingual and live under a single tree (`docs/`), rendered by `web/lib/docs-server.ts`:

- English: `docs/en/developer/<slug>.md`
- Chinese: `docs/zh/developer/<slug>.md`

Both files need frontmatter, or they sort last in the sidebar. Give both locales the SAME path relative to `docs/<lang>/developer/` — the slug is derived from that relative path (`slugFromFile` in `docs-server.ts`), so `docs/en/developer/word-count-tool.md` and `docs/zh/developer/word-count-tool.md` share the slug `word-count-tool` and the language switcher keeps the reader on the page; nesting one locale under an extra subfolder changes its slug and breaks the pairing:

```markdown
---
title: Word Count Tool
order: 107
---
```

If the tool is user-facing (configured in the UI, or visible in settings), also add its UI strings to `packages/i18n/src/locales/{en-US,zh-CN,ja-JP,ko-KR}` — all four locales must stay in sync (`node scripts/check-i18n-parity.mjs`).

## Checklist

- [ ] `definition` has a unique `name`, a "when to use / when not to" description, and a JSON Schema the model can satisfy
- [ ] `executor` returns a string, reports expected failures as `{ error }`, and narrows each arg
- [ ] Entry added to `BUILTIN_TOOLS` **and** `ALL_PROMPT_DOCS` in `web/agent/tool-registry.ts`
- [ ] `TOOL_MODE_CLASSIFICATION` entry in `web/agent/agent-mode.ts` (`read` unless it writes)
- [ ] `policy-engine.ts` entry only if the tool is destructive, network-facing, or asks for approval
- [ ] Unit test covers the happy path and the error shape
- [ ] `pnpm test:run agent/tools/__tests__/<tool>.test.ts` and `make typecheck` pass
- [ ] English **and** Chinese docs page with frontmatter
