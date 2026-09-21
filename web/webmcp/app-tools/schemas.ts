/**
 * App-tools schemas — the 20 WebMCP tools EO2Weave's own page registers so
 * agents (in-app or external via the extension bridge) can operate the app:
 * projects, folders (mounted roots), conversations, runs, files, providers.
 *
 * Pure data module — no imports from stores/services; handlers.ts binds them.
 * JSON-schema fragments follow the WebMCP registerTool inputSchema shape.
 */

export interface AppToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  /** Passed through to registerTool annotations (readOnlyHint etc.) */
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    untrustedContentHint?: boolean
  }
}

const str = (description: string) => ({ type: 'string', description })
const bool = (description: string) => ({ type: 'boolean', description })
const num = (description: string) => ({ type: 'number', description })

export const APP_TOOLS: AppToolDefinition[] = [
  // ── Projects ──────────────────────────────────────────────────────────────
  {
    name: 'list_projects',
    description:
      'List all EO2Weave projects with their folder counts and last access time.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_project',
    description:
      'Create a new EO2Weave project. Folders (local directories) are attached ' +
      'separately by the user in the UI — a new project starts empty.',
    inputSchema: {
      type: 'object',
      properties: { name: str('Project name') },
      required: ['name'],
    },
  },

  // ── Folders (mounted local directories) ───────────────────────────────────
  {
    name: 'list_mounted_folders',
    description:
      'List the local folders the user has granted EO2Weave access to ' +
      '(path, owning project, read-only flag). Conversations are bound to one ' +
      'of these folders — use this to find which folder a task should target, ' +
      'then list_conversations to find conversations working on it.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },

  // ── Conversations ─────────────────────────────────────────────────────────
  {
    name: 'list_conversations',
    description:
      'List conversations (metadata only, no message bodies), newest first. ' +
      'Filter by mounted folder to find conversations that operate on it.',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: str('Only conversations bound to this mounted folder id (from list_mounted_folders)'),
        limit: num('Max entries to return (default 20, max 100)'),
        offset: num('Offset for paging'),
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'search_conversations',
    description:
      'Full-text search across all conversations (titles + message bodies). ' +
      'Supports optional project and time-window filters (Unix epoch ms). ' +
      'Returns conversation ids, titles and matched excerpts — the semantic ' +
      'way to locate "the conversation where we discussed X".',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('Keyword or phrase to search for'),
        updatedAfter: num('Unix epoch ms lower bound on conversation updatedAt'),
        updatedBefore: num('Unix epoch ms upper bound'),
        limit: num('Max results (default 10, max 50)'),
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
  },
  {
    name: 'create_conversation',
    description:
      'Create a new conversation. NOTE: a new conversation has NO mounted ' +
      'folder — it cannot operate on files until the user mounts a folder in ' +
      'the UI. For file tasks prefer an existing conversation bound to the ' +
      'target folder (list_mounted_folders + list_conversations).',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('Conversation title (auto-generated later if omitted)'),
      },
    },
  },
  {
    name: 'rename_conversation',
    description:
      'Rename a conversation. Marks the title as manual (auto-title generation ' +
      'will not overwrite it). Operates on THIS EO2Weave instance only — when ' +
      'multiple instances are open, use the variant matching the conversation\u2019s origin.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: str('Target conversation id'),
        title: str('New title (trimmed, 1-200 chars)'),
      },
      required: ['conversationId', 'title'],
    },
    annotations: {},
  },

  {
    name: 'get_messages',
    description:
      'Read the message history of a conversation, newest page first. ' +
      'Content is the final text per message; tool-call details are omitted. ' +
      'Single messages over 32KB are truncated with truncated:true.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: str('Conversation id'),
        page: num('1 = newest page (default)'),
        pageSize: num('Messages per page (default 50, max 200)'),
      },
      required: ['conversationId'],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true, idempotentHint: true },
  },

  // ── Runs ──────────────────────────────────────────────────────────────────
  {
    name: 'send_message',
    description:
      'Send a user message into a conversation and start the EO2Weave agent on it. ' +
      'Runs with the app’s currently configured provider/model (see ' +
      'list_providers / set_default_model). By default returns immediately with ' +
      'status "started" — poll get_run_status / get_run_progress for progress. ' +
      'wait=true blocks (max timeoutMs, hard cap 300s) and returns the final ' +
      'result with the agent’s summary and changed files. If the conversation ' +
      'already has a run in progress the message is queued (status "queued"). ' +
      'The conversation must have a mounted folder for file-manipulation tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: str('Conversation to send into'),
        content: str('Message text (the task for the agent)'),
        wait: bool('Block until the run finishes (default false). Caps at 55s — for longer tasks use wait=false and poll get_run_status.'),
        timeoutMs: num('Max wait when wait=true (default 50000, hard cap 55000 — the extension relay times out at 60s)'),
      },
      required: ['conversationId', 'content'],
    },
  },
  {
    name: 'get_run_status',
    description:
      'Get the status and (when finished) the result of a run started with ' +
      'send_message. Result includes the agent’s final summary, the list of ' +
      'changed files, and token usage.',
    inputSchema: {
      type: 'object',
      properties: { runId: str('Run id from send_message') },
      required: ['runId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_run_progress',
    description:
      'Live progress of a running run: elapsed time, completed tool-call count, ' +
      'the tool currently executing (name + argument preview) and a preview of ' +
      'the streaming output. Use to report progress or detect liveness. For ' +
      'finished runs returns only the terminal status.',
    inputSchema: {
      type: 'object',
      properties: { runId: str('Run id from send_message') },
      required: ['runId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'cancel_run',
    description: 'Cancel a running or queued run.',
    inputSchema: {
      type: 'object',
      properties: { runId: str('Run id from send_message') },
      required: ['runId'],
    },
    annotations: { destructiveHint: true },
  },

  // ── Files (inside the conversation’s mounted folder workspace) ─────────
  {
    name: 'read_folder_file',
    description:
      'Read a file from the workspace of the given conversation (path relative ' +
      'to the folder root). NOTE: this is the workspace copy — changes reach the ' +
      'real local disk when the user syncs to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: str('Conversation whose workspace to read from'),
        path: str('Relative path, e.g. "src/App.tsx"'),
      },
      required: ['conversationId', 'path'],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
  },
  {
    name: 'write_folder_file',
    description:
      'Write a file into the workspace of the given conversation (creates parent ' +
      'folders, overwrites existing). Goes to the workspace copy — the user ' +
      'syncs to the real disk from the UI. Useful to hand documents/specs to ' +
      'the agent before send_message.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: str('Conversation whose workspace to write into'),
        path: str('Relative path, e.g. "specs/fix-login.md"'),
        content: str('Full file content (text)'),
      },
      required: ['conversationId', 'path', 'content'],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'list_folder_files',
    description:
      'List files under a path in the conversation’s workspace. ' +
      'Paths are relative to the folder root. depth 0 = direct children only.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: str('Conversation whose workspace to list'),
        path: str('Relative directory path (default "" = folder root)'),
        depth: num('Recursion depth (default 2)'),
      },
      required: ['conversationId'],
    },
    annotations: { readOnlyHint: true },
  },

  // ── Providers & models ────────────────────────────────────────────────────
  {
    name: 'list_providers',
    description:
      'List every LLM provider configured in the app: whether an API key / ' +
      'OAuth is set up, its pinned (frequently used) models, and which ' +
      'provider+model is currently the global default used by all new runs.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'list_models',
    description:
      'List all models available for a provider (live catalog when the provider ' +
      'supports fetching, cached otherwise). Pinned models are flagged.',
    inputSchema: {
      type: 'object',
      properties: { providerId: str('Provider id from list_providers') },
      required: ['providerId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_pinned_model',
    description: 'Add a model to a provider’s pinned (frequently used) list.',
    inputSchema: {
      type: 'object',
      properties: {
        providerId: str('Provider id'),
        modelId: str('Model id (from list_models)'),
      },
      required: ['providerId', 'modelId'],
    },
  },
  {
    name: 'remove_pinned_model',
    description: 'Remove a model from a provider’s pinned list.',
    inputSchema: {
      type: 'object',
      properties: {
        providerId: str('Provider id'),
        modelId: str('Model id'),
      },
      required: ['providerId', 'modelId'],
    },
  },
  {
    name: 'set_default_model',
    description:
      'Set the global default provider+model used by new runs (including ' +
      'manual sends from the UI). The provider must already have an API key ' +
      'or OAuth configured.',
    inputSchema: {
      type: 'object',
      properties: {
        providerId: str('Provider id'),
        modelId: str('Model id'),
      },
      required: ['providerId', 'modelId'],
    },
  },
]
