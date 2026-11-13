/**
 * Ask User Question Tool - allows the agent to ask the user a question
 * and synchronously wait for a response.
 *
 * This is a meta-tool: the executor pauses until the user responds via UI.
 * It is classified as a "read" tool so it's available in both Plan and Act modes.
 *
 * Supported question types:
 * - yes_no: Binary confirmation (default)
 * - single_choice: Select one from options
 * - multi_choice: Select multiple from options
 * - free_text: Open-ended text input
 */

import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'
import { toolErrorJson, toolOkJson } from './tool-envelope'

export const askUserQuestionDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'ask_user_question',
    description: [
      'Ask the user a question and wait for their response. The agent loop automatically resumes after the user answers.',
      '',
      '## Why you should use this tool',
      'When you call this tool, the agent loop pauses and automatically resumes once the user answers — you get the answer back as the tool result and can continue working in the same loop turn.',
      'If you skip asking and guess wrong, the user has to send a new message and start a brand-new loop, wasting all the context and work from the current turn.',
      '**Asking is far cheaper than guessing wrong and redoing the work.**',
      '',
      '## When to use',
      '1. Disambiguate — when the user request has multiple possible interpretations',
      '2. Confirm — before executing irreversible / destructive operations',
      '3. Choose — when multiple viable approaches exist',
      '4. Gather info — when critical parameters are missing',
      '',
      '## Choosing `type` (decision tree — pick the most specific match)',
      '- `yes_no` (DEFAULT — use this most often): two clearly opposed answers — "Apply / Cancel", "Keep / Discard", "Proceed / Stop". If only 2 options and one semantically means "yes", use `yes_no`.',
      '- `single_choice`: 3+ mutually exclusive options — "Pick a DB engine", "Which deployment target".',
      '- `multi_choice`: 3+ independent toggleable items — "Select features to enable", "Pick which files to refactor".',
      '- `free_text`: no good preset exists — user must type their own answer (project name, explanation, free-form feedback).',
      '',
      '⚠️ Common mistake: do NOT use `single_choice` with just 2 options like [{ label: "Yes" }, { label: "No" }] — use `yes_no` instead. Two radio buttons is strictly worse UX than Yes/No buttons for a binary decision.',
      '',
      '## Examples (GOOD vs BAD)',
      '',
      '✅ GOOD — `yes_no` for binary confirmation:',
      '  ask_user_question({ question: "Apply 3 pending migrations to local DB?", type: "yes_no", context: { affected_files: ["db/migrations/001_init.sql", "db/migrations/002_users.sql"] } })',
      '',
      '✅ GOOD — `single_choice` with object form (recommended + description):',
      '  ask_user_question({ question: "Which database engine should the project use?", type: "single_choice", options: [',
      '    { label: "PostgreSQL", recommended: true, description: "Mature, production-grade, strong consistency" },',
      '    { label: "SQLite", description: "Zero-config, file-based, good for single-user" },',
      '    { label: "MySQL", description: "Wide compatibility, but weaker consistency guarantees" }',
      '  ], default_answer: "PostgreSQL" })',
      '',
      '✅ GOOD — `multi_choice` for independent toggles:',
      '  ask_user_question({ question: "Which features should I scaffold in the new project?", type: "multi_choice", options: [',
      '    { label: "Authentication", description: "User login, signup, password reset" },',
      '    { label: "Payments", description: "Stripe integration, subscription billing" },',
      '    { label: "Email", description: "Transactional and marketing emails" },',
      '    { label: "Search", description: "Full-text search across content" }',
      '  ] })',
      '',
      '✅ GOOD — `free_text` when no preset fits:',
      '  ask_user_question({ question: "What should we name this new project?", type: "free_text" })',
      '',
      '❌ BAD — `single_choice` used for a binary decision:',
      '  ask_user_question({ question: "Apply migrations?", type: "single_choice", options: [{ label: "Yes" }, { label: "No" }] })',
      '  → Should be: type: "yes_no" with NO options field',
      '',
      '❌ BAD — `options` passed to `yes_no` (executor rejects with INVALID_INPUT):',
      '  ask_user_question({ question: "Confirm?", type: "yes_no", options: [{ label: "Yes" }, { label: "No" }] })',
      '  → Just omit `options`. yes_no uses built-in Yes/No buttons.',
      '',
      '❌ BAD — passing string options (executor rejects with INVALID_INPUT):',
      '  ask_user_question({ options: ["PostgreSQL", "MySQL", "SQLite"] })',
      '  → Use object form: options: [{ label: "PostgreSQL" }, { label: "MySQL" }, { label: "SQLite" }].',
      '  → The string form was removed; ⭐ prefix and em-dash separator tricks no longer work.',
      '',
      '## When NOT to use',
      '- You can find the answer yourself via read/search tools — prefer tools over asking the user',
      '- The answer has one obvious interpretation and the cost of being wrong is low',
      '- You want to batch multiple questions in one turn — this tool shows ONE question at a time. Ask the most important one first, then continue based on the answer.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要向用户提出的问题。应该清晰、具体、易于回答。',
        },
        type: {
          type: 'string',
          enum: ['yes_no', 'single_choice', 'multi_choice', 'free_text'],
          description: [
            '问题类型：',
            '- yes_no: 是/否确认（默认）',
            '- single_choice: 单选',
            '- multi_choice: 多选',
            '- free_text: 自由文本输入',
          ].join('\n'),
        },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '选项主标签（必填）。' },
              description: { type: 'string', description: '选项补充说明（可选），会显示在 label 下方较小字号。' },
              recommended: { type: 'boolean', description: '是否标记为推荐（可选，默认 false），标记后会在 label 前显示 ⭐ 推荐 徽章。' },
            },
            required: ['label'],
          },
          description: [
            '选项列表。',
            '- `type=single_choice` 或 `multi_choice` 时必填，至少 2 个选项。',
            '- `type=yes_no` 或 `free_text` 时严禁传此字段（executor 会返回 INVALID_INPUT）。',
            '',
            '## 唯一支持的格式：对象形式',
            '每个选项必须是 object，必填 `label`，可选 `description` 和 `recommended`。',
            '',
            '```json',
            '{ "label": "PostgreSQL", "description": "成熟稳定，适合生产环境", "recommended": true }',
            '```',
            '',
            '⚠️ 字符串形式已被完全移除（之前支持 `"PostgreSQL"` 和 `"⭐ PostgreSQL — 推荐"` 写法）。',
            '传字符串的选项会被 executor 拒绝并返回 INVALID_INPUT + 详细 hint。',
            '',
            '## 标注推荐',
            '使用对象形式的 `recommended: true` 字段，不要用 ⭐ 前缀字符串。',
            '当 agent 对某个选项有明确倾向时，应标注推荐并附上简短理由。',
            '如果各选项没有明显优劣，则不要标注推荐。',
            '标注推荐时，`default_answer` 也应对齐到推荐项的 label。',
          ].join('\n'),
        },
        default_answer: {
          type: 'string',
          description: '默认答案（可选），用于 UI 预选以及超时/取消时的降级回答。',
        },
        context: {
          type: 'object',
          properties: {
            affected_files: {
              type: 'array',
              items: { type: 'string' },
              description: '受影响的文件列表（用于确认操作时展示上下文）。使用 workspace 相对路径，不带 rootName 前缀、不带前导斜杠，例如 "src/App.tsx"（不是 "creatorweave/src/App.tsx" 也不是 "/abs/path/src/App.tsx"）。',
            },
            preview: {
              type: 'string',
              description: '预览内容（如 diff 摘要、操作说明），帮助用户做知情决策',
            },
          },
          description: '附加上下文信息，帮助用户理解问题的背景。',
        },
        timeout_ms: {
          type: 'number',
          description: '超时时间（毫秒）。默认 300000（5 分钟）。范围：5000 ~ 3600000。',
        },
      },
      required: ['question'],
    },
  },
}

/**
 * Executor for the ask_user_question tool.
 *
 * The executor calls context.askUserQuestion (injected by the UI layer)
 * to display a question card and wait for the user's response.
 *
 * If no handler is registered (e.g. in subagent context), it falls back
 * to the default_answer or a generic response.
 */
export const askUserQuestionExecutor: ToolExecutor = async (
  args: Record<string, unknown>,
  context
) => {
  const {
    question,
    type = 'yes_no',
    options,
    default_answer,
    context: questionContext,
    timeout_ms = 300_000,
  } = args as {
    question: string
    type?: 'yes_no' | 'single_choice' | 'multi_choice' | 'free_text'
    options?: Array<{ label: string; description?: string; recommended?: boolean }>
    default_answer?: string
    context?: { affected_files?: string[]; preview?: string }
    timeout_ms?: number
  }

  // --- Parameter validation ---
  if (!question?.trim()) {
    return toolErrorJson(
      'ask_user_question',
      'INVALID_INPUT',
      'Parameter "question" is required and must be non-empty.',
      { retryable: true }
    )
  }

  const questionType = type as 'yes_no' | 'single_choice' | 'multi_choice' | 'free_text'

  if (
    (questionType === 'single_choice' || questionType === 'multi_choice') &&
    (!options || options.length < 2)
  ) {
    return toolErrorJson(
      'ask_user_question',
      'INVALID_INPUT',
      `Parameter "options" must have at least 2 items for type "${questionType}".`,
      { retryable: true }
    )
  }

  // String form was REMOVED. All options must be objects.
  // Runtime check (defense-in-depth) in case the LLM SDK doesn't strictly
  // enforce the JSON schema.
  if (questionType === 'single_choice' || questionType === 'multi_choice') {
    const stringOptions = (options ?? []).filter(o => typeof o === 'string')
    if (stringOptions.length > 0) {
      const sample = stringOptions
        .slice(0, 3)
        .map(s => JSON.stringify(s))
        .join(', ')
      return toolErrorJson(
        'ask_user_question',
        'INVALID_INPUT',
        `Parameter "options" no longer accepts string entries (${stringOptions.length} found, e.g. ${sample}). Each option must be an object with at least a "label" field.`,
        {
          retryable: true,
          hint: 'Replace each string entry with an object. For example, options: ["Yes", "No"] becomes options: [{ label: "Yes" }, { label: "No" }].',
        }
      )
    }
  }

  // yes_no / free_text have built-in UI affordances — options field is invalid.
  // Catching this here (rather than silently ignoring) gives the LLM a clear
  // signal to fix the call instead of producing a confusing QuestionCard.
  if (
    (questionType === 'yes_no' || questionType === 'free_text') &&
    options !== undefined &&
    options.length > 0
  ) {
    const hint =
      questionType === 'yes_no'
        ? 'Use type: "yes_no" with NO options field (Yes/No buttons are built-in), or switch to type: "single_choice" if you need custom labels.'
        : 'Use type: "free_text" with NO options field (text input is built-in).'
    return toolErrorJson(
      'ask_user_question',
      'INVALID_INPUT',
      `Parameter "options" is not allowed when type is "${questionType}". ${hint}`,
      { retryable: true, hint }
    )
  }

  // Clamp timeout to safe bounds [5s, 1h]
  const clampedTimeout = Math.max(5_000, Math.min(timeout_ms, 3_600_000))

  // --- No handler: fallback ---
  if (!context.askUserQuestion) {
    return toolOkJson('ask_user_question', {
      answer: default_answer ?? 'yes',
      confirmed: false,
      timed_out: false,
    }, {
      warning:
        'No askUserQuestion handler registered. Used default answer. This is expected in subagent contexts.',
    })
  }

  // --- Wait for user response with timeout ---
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<{ answer: string; confirmed: boolean; timed_out: boolean }>(
      (resolve) => {
        timeoutId = setTimeout(
          () =>
            resolve({
              answer: default_answer ?? 'timeout',
              confirmed: false,
              timed_out: true,
            }),
          clampedTimeout
        )
      }
    )

    const result = await Promise.race([
      context.askUserQuestion({
        question,
        type: questionType,
        options,
        defaultAnswer: default_answer,
        context: questionContext,
        signal: context.abortSignal,
        toolCallId: context.currentToolCallId,
      }),
      timeoutPromise,
    ])

    return toolOkJson('ask_user_question', result)
  } catch {
    // AbortSignal cancelled (user stopped the agent loop)
    return toolOkJson('ask_user_question', {
      answer: default_answer ?? 'cancelled',
      confirmed: false,
      timed_out: false,
    }, {
      warning: 'Question was cancelled (agent loop aborted).',
    })
  } finally {
    // Always clean up the timeout timer to prevent memory leaks
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  }
}

export const askUserQuestionPromptDoc: ToolPromptDoc = {
  category: 'interaction',
  section: '### User Interaction',
  lines: [
    '- `ask_user_question(question, type?, options?, ...)` - Ask the user a question and wait for their response within the current loop',
    '- `confirmed: false` means no answer was recorded: either the user skipped the prompt or it timed out (`timed_out: true` = they never answered). Do not silently pick an option for them; proceed with the safest default and say so, or stop and ask again in plain chat — after a timeout, do not re-ask the same question.',
  ],
}
