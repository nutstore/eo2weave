---
title: 编写自定义 Agent Tool
order: 106
---

# 编写自定义 Agent Tool

本教程以一个 `word_count` 工具为例，完整走一遍新增工具的全部环节：定义、执行器、注册、Plan 模式归类、授权、测试与文档。

所有内容都对齐内置工具的真实做法。拿不准时，先读 `web/agent/tools/switch-mode.tool.ts`（短小、自包含）和 `web/agent/tools/tool-types.ts`（类型定义）。

> **不要把 `web/agent/tools/ls.tool.ts` 当模板。** 它只是两行转出口（`export { ... } from '@/vfs/ls-operation'`），真正实现位于 VFS 层，不适合作为写工具的范例。

## 1. 一个工具由什么组成

工具在类型上就是一个 `ToolEntry`（`web/agent/tools/tool-types.ts`）：

```ts
export interface ToolEntry {
  definition: ToolDefinition
  executor: ToolExecutor
  /** Feeds the system prompt's Available Tools section */
  promptDoc?: ToolPromptDoc
}
```

三部分各司其职：

| 部分 | 类型 | 作用 |
| --- | --- | --- |
| `definition` | `ToolDefinition` | 模型看到的东西：名称、描述、JSON Schema 参数（OpenAI function calling 形状，但类型由 `tool-types.ts` 本地定义，**不是** OpenAI SDK 的类型） |
| `executor` | `ToolExecutor` | 真正执行：`(args, context) => Promise<string>` |
| `promptDoc` | `ToolPromptDoc` | 可选。系统提示词「Available Tools」段落里的一行说明 + 展示分组 |

`promptDoc` 在类型上可选，但内置工具全都提供 —— 不写的话工具仍可被调用，却不会出现在提示词的工具摘要里，模型因此很容易「忘了」它存在。

## 2. 写 definition

新建 `web/agent/tools/word-count.tool.ts`：

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

几条要点：

- **`name`** 是模型输出的标识符，也是执行器查找的键。用 snake_case，且在整个注册表内唯一（历史别名放在 `tool-registry.ts` 的 `TOOL_ALIASES` 里，只有重命名旧工具时才需要动）。
- **`description`** 是模型判断「什么时候该调它」的唯一依据。既写清做什么，也写清**不该**用它的场景。
- **`parameters`** 用的是本地 `JSONSchema` 子集（`web/agent/tools/tool-types.ts`）：`string | number | boolean | array | object`，外加 `enum`、`items`、`required`、`default`、`minimum`、`maximum`、`minLength`、`oneOf`。子集之外的写法不会渲染给模型。

## 3. 写 executor

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

约定：

- **返回字符串**，实践中就是 `JSON.stringify(...)`。这个返回值会作为工具消息回给模型。
- **预期内的失败不要抛异常**，返回 `{ error: '...' }`（参考 `delete.tool.ts`）。抛异常会被 agent loop 收敛成通用失败，模型无法据此自我修正；`throw` 只留给真正的 bug。
- **防御性校验 `args`**。它来自大模型，类型是 `Record<string, unknown>`，逐字段窄化（`typeof args.text === 'string'`）而不是直接断言。
- **第二个参数是 `ToolContext`**，只在需要时使用：

  ```ts
  export const wordCountExecutor: ToolExecutor = async (args, context) => {
    if (context.abortSignal?.aborted) {
      return JSON.stringify({ error: 'cancelled' })
    }
    // context.directoryHandle / context.projectId / context.currentAgentId
    // for tools that touch the workspace — see read.tool.ts / write.tool.ts.
    // ...your logic here
  }
  ```

## 4. 注册

修改 `web/agent/tool-registry.ts`，共三处：

1. 在其他工具 import 旁边加上：

   ```ts
   import { wordCountDefinition, wordCountExecutor, wordCountPromptDoc } from './tools/word-count.tool'
   ```

2. 加入 `BUILTIN_TOOLS`：

   ```ts
   const BUILTIN_TOOLS: Array<{ definition: ToolDefinition; executor: ToolExecutor }> = [
     ...
     { definition: wordCountDefinition, executor: wordCountExecutor },
   ]
   ```

3. 加入 `ALL_PROMPT_DOCS`：

   ```ts
   const ALL_PROMPT_DOCS: ToolPromptDoc[] = [
     ...
     wordCountPromptDoc,
   ]
   ```

`promptDoc` 本身写在工具文件里：

```ts
export const wordCountPromptDoc: ToolPromptDoc = {
  category: 'meta',
  section: '### Text Utilities',
  lines: ['- `word_count(text)` - Count words, characters and lines of a string'],
}
```

`category` 决定展示分组顺序；`section` 是它在提示词里归属的 Markdown 标题（省略则追加到上一节）。

## 5. 归类到 Plan 模式

Plan 模式是只读的，闸门在 `web/agent/agent-mode.ts`：

```ts
export const TOOL_MODE_CLASSIFICATION: Map<string, ToolModeMetadata> = new Map([
  ...
  // Meta tools (read-only — no file modifications)
  ['ask_user_question', { name: 'ask_user_question', category: 'read' }],
])
```

加上：

```ts
['word_count', { name: 'word_count', category: 'read' }],
```

**默认值是 `write`**（`getToolCategory()` 对未登记的名字返回 `'write'`），所以没归类的工具在 Plan 模式下不可见。这是安全默认，也是「Act 模式能用、Plan 模式模型看不到」的常见原因。

## 6. 授权

只加一条策略表记录**并不会**产生任何拦截。`web/agent/policy-engine.ts` 暴露的是 `authorize(req)`，必须由工具自己去调用；目前只有 `call_tool`（经 `external-tool-bridge.ts`）和 `sync-to-disk` 这么做。从不调用 `authorize()` 的工具，无论表里怎么写，都会照常执行。

策略表（同文件的 `createPolicyTable()`）提供这次判断的输入：

- `auto` —— 直接执行（**未登记的工具也是这个默认值**）
- `prompt` —— 这次调用需要用户确认
- `forbidden` —— 模型永远不可调用

大多数工具既不需要登记、也不需要调用 `authorize()`：没有条目就是 `auto`。网络读取（`web_search`、`web_fetch`）同样是 `auto` —— 访问网络本身不构成弹窗的理由。

如果工具做的是不可逆操作（写真实磁盘、批量删除、回滚），要在执行器里调用 `authorize()` 并处理拒绝：

```ts
const auth = await authorize({
  toolName: 'my_disk_writer',
  args: { ... },
  conversationId: context.workspaceId,
  // Plan 模式下抑制「本对话内总是允许」：探索阶段的授权不能预先放行之后的 act 调用
  mode: context.agentMode,
  signal: context.abortSignal,
})
if (auth.decision === 'deny') {
  return JSON.stringify({ error: 'AUTH_DENIED_BY_USER', reason: auth.reason })
}
// 用户确认之后、真正动手之前仍可能被中断 —— 不可逆操作前再查一次
if (context.abortSignal?.aborted) {
  return JSON.stringify({ error: 'ABORTED' })
}
```

然后在 `createPolicyTable()` 里登记级别：

```ts
set('my_disk_writer', {
  level: 'prompt',
  describe: () => ({ key: 'describeMyDiskWriter' }),
  memoryKey: () => 'my-disk-writer',
})
```

`describe` 指向 `agent.toolAuth.*` 下的 key，必须补进四个语言（`packages/i18n/src/locales/{en-US,zh-CN,ja-JP,ko-KR}`），否则弹窗会直接显示 key 原文。`memoryKey` 让「本对话内总是允许」按工具族生效。

还有两个行为来自 `authorize()` 本身，而不是你的表记录：

- 开启 YOLO 模式时，`prompt` 级别会直接返回 `allow`，不弹窗。YOLO 是**按会话**的开关、由用户控制（按会话持久化；LLM 无法自己开启——`switch_agent_mode` 会强制清掉），所以这是用户自己的选择，不是你的工具引入的绕过。`forbidden` 在 YOLO 下依然拒绝——这条检查在 YOLO 之前。
- `memoryKey` 才是让「本对话内总是允许」跳过后续提示的原因。不可逆操作建议返回 `null`（不给 `memoryKey`），这样每次调用都会再问一次——`snapshot_restore` 就是这么做的。

## 7. 测试

执行器就是普通函数，不需要渲染 React，放在 `web/agent/tools/__tests__/word-count.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { wordCountDefinition, wordCountExecutor } from '../word-count.tool'

// Only the fields the executor reads; the rest is cast away.
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

每个工具测试至少保留两条：正常路径，以及模型真正会看到的失败形状。只断言 `ok: true` 的测试，即使工具什么都没返回也会通过。

运行：

```bash
# from the repo root
cd web && pnpm test:run agent/tools/__tests__/word-count.test.ts
cd .. && make typecheck
```

## 8. 补文档

文档是双语的，统一放在 `docs/` 下，由 `web/lib/docs-server.ts` 渲染：

- 英文：`docs/en/developer/<slug>.md`
- 中文：`docs/zh/developer/<slug>.md`

两个文件都必须带 frontmatter，否则会在侧边栏排到最后。两个语言要放在相对 `docs/<lang>/developer/` 的**相同路径**——slug 是从相对路径推导的（`docs-server.ts` 的 `slugFromFile`），比如 `docs/en/developer/word-count-tool.md` 和 `docs/zh/developer/word-count-tool.md` 共享 slug `word-count-tool`，语言切换后仍停留在对应页面；某个语言多套一层子目录会改变它的 slug，破坏配对：

```markdown
---
title: Word Count Tool
order: 107
---
```

如果工具会在界面里出现（设置项、配置面板），还要把 UI 文案补进 `packages/i18n/src/locales/{en-US,zh-CN,ja-JP,ko-KR}` —— 四个语言必须同步（`node scripts/check-i18n-parity.mjs`）。

## 检查清单

- [ ] `definition` 的 `name` 唯一，描述写清「何时用 / 何时不用」，参数是模型能满足的 JSON Schema
- [ ] `executor` 返回字符串，预期失败用 `{ error }` 表达，逐字段窄化入参
- [ ] 已加入 `web/agent/tool-registry.ts` 的 `BUILTIN_TOOLS` **和** `ALL_PROMPT_DOCS`
- [ ] 已在 `web/agent/agent-mode.ts` 的 `TOOL_MODE_CLASSIFICATION` 归类（除非会写文件，否则用 `read`）
- [ ] 仅当工具具破坏性、访问网络或需要用户确认时，才在 `policy-engine.ts` 加条目
- [ ] 单测覆盖正常路径与错误形状
- [ ] `pnpm test:run agent/tools/__tests__/<tool>.test.ts` 与 `make typecheck` 通过
- [ ] 英文 **和** 中文文档页都带 frontmatter
