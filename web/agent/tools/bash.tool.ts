/**
 * bash tool — Execute shell commands in a sandboxed bash environment.
 *
 * Runs just-bash (https://github.com/vercel-labs/just-bash) inside a Web Worker
 * so that CPU-bound interpreter loops (grep, sed, awk, rg, large loops) no
 * longer block the browser main thread.
 *
 * All file operations inside the bash session (cat, grep, sed, echo >, etc.)
 * are bridged back to the main thread via VFS RPC, so they go through the same
 * VfsBackend used by read/write/edit tools — preserving pending-change
 * tracking, undo/redo, and sync preview.
 *
 * Wall-clock timeouts and abort signals truly interrupt execution by
 * terminating the worker (the only way to stop a CPU-bound JS loop).
 */

import { toolOkJson, toolErrorJson } from './tool-envelope'
import type { ToolContext, ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'
import { resolveVfsTarget } from './vfs-resolver'
import { isSubagentPermissionDenied, SUBAGENT_PERMISSION_DENIED } from './agent-file-protection'
import { isToolTimeoutError } from './tool-utils'
import { bashCommandRegistry } from '@/agent/bash-commands/registry'
import { bashExec } from './bash-worker/client'
import type { VfsRpcHandlerConfig } from './bash-worker/vfs-rpc-handler'

/** Workspace mount point inside the bash sandbox (must match bash-worker/bridge-shared.ts) */
const WORKSPACE_MOUNT = '/workspace'

// ---------------------------------------------------------------------------
// Tool definition (OpenAI function-calling format)
// ---------------------------------------------------------------------------

export const bashDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'bash',
    description: [
      'Execute a bash command in a sandboxed environment with access to the workspace files.',
      '',
      'PREFER bash over multiple read/edit calls when:',
      '- Batch text replacement across files (sed -i)',
      '- Quick file stats or summaries (wc -l, sort | uniq -c, du)',
      '- Multi-file search with complex patterns (rg + grep + awk pipeline)',
      '- One-liner tasks that would otherwise need 3+ tool calls',
      '',
      'Available: grep, sed, awk, cat, ls, find, sort, uniq, wc, head, tail, jq, diff, xargs, tr, cut, tee, rg, tree, file, split, rev, gzip, gunzip, zcat, etc.',
      'NOT available: git, node, npm, python3, curl, wget, tar, patch.',
      'Limitations: no process substitution <(...), no xargs -I, echo -e does not interpret escapes (use printf instead), rg does not support --no-heading or -r (use sed -i for replacements).',
      'Pipes (|), redirections (>, >>), chaining (&&, ||, ;) all work.',
      'Workspace at /workspace/<rootName>/..., assets at /assets/..., agents at /agents/...',
      '',
      'UTF-8 / ENCODING:',
      '- Bash sandbox now preserves UTF-8/CJK correctly for `cat`, command substitution (`$(cat file)`), and binary redirects like `cat src > dst` / `uniq src > dst`.',
      '- Safe choices: `cp`, `cat`, `uniq`, `sed`, `awk`, `printf`, `echo`, pipes, and `>` / `>>` with normal UTF-8 text all work correctly.',
      '- `echo -e` still does NOT interpret escapes in this sandbox; use `printf` for escape sequences.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The bash command(s) to execute. Supports multi-line scripts.',
        },
        timeout: {
          type: 'number',
          description: 'Maximum execution time in milliseconds (default: 120000).',
        },
        cwd: {
          type: 'string',
          description: 'Working directory inside the sandbox. Usually unnecessary — defaults to /workspace/<firstRootName>.',
        },
      },
      required: ['command'],
    },
  },
}

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

export const bashToolExecutor: ToolExecutor = async (
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<string> => {
  const command = args.command as string | undefined
  if (!command || typeof command !== 'string' || !command.trim()) {
    return toolErrorJson('bash', 'invalid_input', 'command is required and must be a non-empty string')
  }

  // Resolve VFS backend for workspace (validates that a workspace exists)
  try {
    await resolveVfsTarget('', context, 'read', { allowEmptyPath: true })
  } catch (err) {
    return toolErrorJson('bash', 'no_workspace', 'No workspace available for bash execution', {
      details: { error: (err as Error).message },
    })
  }

  const isPlanMode = (context.agentMode ?? 'act') === 'plan'

  // Resolve multi-root names
  let rootNames: string[] = []
  try {
    const { getProjectRootRepository } = await import(
      '@/sqlite/repositories/project-root.repository'
    )
    const repo = getProjectRootRepository()
    if (context.projectId) {
      const roots = await repo.findByProject(context.projectId)
      rootNames = roots.map((r: { name: string }) => r.name)
    }
  } catch {
    // Root repository not available — single root
  }

  const defaultCwd = rootNames.length > 0
    ? `${WORKSPACE_MOUNT}/${rootNames[0]}`
    : WORKSPACE_MOUNT
  const cwd = (args.cwd as string) || defaultCwd
  const timeoutMs = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : 120_000

  // VFS RPC handler config — passed to BashWorkerClient so it can execute
  // file IO on the main thread (where all the zustand stores / managers live).
  const handlerConfig: VfsRpcHandlerConfig = {
    workspaceId: context.workspaceId ?? null,
    projectId: context.projectId ?? null,
    currentAgentId: context.currentAgentId ?? null,
    readOnly: isPlanMode,
    restrictAgentCoreFiles: context.isSubagent === true,
    onWorkspacePathsChanged: context.onWorkspacePathsChanged,
    directoryHandle: context.directoryHandle,
  }

  const startTime = Date.now()

  try {
    await bashCommandRegistry.refresh()
    const result = await bashExec(
      {
        command,
        cwd,
        rootNames,
        readOnly: isPlanMode,
        restrictAgentCoreFiles: context.isSubagent === true,
        timeoutMs,
        abortSignal: context.abortSignal,
      },
      handlerConfig,
    )

    return toolOkJson('bash', {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      truncated: result.truncated,
      command,
      elapsedMs: result.elapsedMs,
    })
  } catch (err) {
    const elapsedMs = Date.now() - startTime
    if (isToolTimeoutError(err)) {
      return toolErrorJson('bash', 'timeout', err.message, {
        details: { command, elapsedMs },
        retryable: true,
      })
    }
    const message = err instanceof Error ? err.message : String(err)
    if (isSubagentPermissionDenied(err) || message.startsWith('EACCES: delegated subagent')) {
      return toolErrorJson('bash', SUBAGENT_PERMISSION_DENIED, message, {
        details: { command, elapsedMs },
      })
    }
    return toolErrorJson('bash', 'execution_error', `Bash execution failed: ${message}`, {
      details: { command, elapsedMs },
    })
  }
}

// ---------------------------------------------------------------------------
// Prompt doc for system prompt
// ---------------------------------------------------------------------------

export const bashPromptDoc: ToolPromptDoc = {
  category: 'file-ops',
  section: '### Shell',
  lines: [
    '- `bash(command, cwd?)` — Execute bash commands in a sandboxed environment',
    '  - Available: grep, sed, awk, cat, ls, find, sort, uniq, wc, head, tail, jq, rg, diff, xargs, tree, gzip, gunzip, zcat, etc.',
    '  - NOT available: git, node, npm, python3, curl, wget, tar',
    '  - Limitations: no process substitution `<(...)`, no `xargs -I`, `echo -e` does not interpret escapes (use printf), `rg` does not support --no-heading or -r',
    '  - Pipes (`|`), redirections (`>`, `>>`), chaining (`&&`, `||`, `;`)',
    '  - Workspace at /workspace/<rootName>/..., assets at /assets/..., agents at /agents/...',
  ],
}
