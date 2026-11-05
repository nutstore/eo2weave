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
    characters: text.length,
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
    ...
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

`web/agent/policy-engine.ts` decides whether a call needs user approval:

- `auto` — run without asking (also the default for **unregistered** tools)
- `prompt` — show the unified `ToolAuthModal`
- `forbidden` — never callable by the model

A read-only tool needs no entry: it inherits `auto`. Add an entry when the tool mutates something outside OPFS, reaches the network, or performs a destructive/irreversible operation *even inside OPFS* — rollbacks and bulk deletes deserve a prompt too (`snapshot_restore` is registered as `prompt` for exactly that reason):

```ts
set('word_count', { level: 'auto' })
// vs.
set('my_disk_writer', { level: 'prompt', describe: () => ({ key: 'describeMyDiskWriter' }), memoryKey: () => 'my-disk-writer' })
```

`describe` returns an i18n key under `agent.toolAuth.*` so the modal follows the user's locale; `memoryKey` lets "always allow this conversation" work per tool family.

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
    expect(result).toMatchObject({ success: true, words: 3, lines: 2 })
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
- Chinese: `docs/zh/developer/guides/<slug>.md`

Both files need frontmatter, or they sort last in the sidebar:

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
