/**
 * exec tool — Run a shell command on the user's machine via Native Host.
 *
 * This is the Tier 1.5 "transparent exec" capability.
 * It lets the agent verify its own work by running tests, builds, linters, etc.
 *
 * Approval flow (preApproved model):
 *   1. check_policy (stateless) → decision: 'auto' | 'prompt' | 'forbidden'
 *   2. 'auto'      → execute immediately
 *      'prompt'    → ask the user via the shared auth modal → if approved, execute with preApproved
 *      'forbidden' → refuse, return error (never executed)
 *      (YOLO on → 'prompt' downgrades to 'auto' at Step 2.5; the forbidden
 *       check above always runs first, so yolo never covers forbidden.)
 *   3. Execute via exec_sync (stateless sendNativeMessage) → stdout/stderr/exit
 *
 * Security model: "transparent + approval" — no sandbox promises.
 * The user installed the native host, authorized the directory, and approves
 * commands. This is exactly like running commands in their own terminal.
 *
 * This tool is ONLY registered when the Native Host bridge is available
 * (window.__agentWeb.nativeHostCall + nativeHostCheckPolicy).
 */

import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'
import { toolOkJson, toolErrorJson } from './tool-envelope'
// Unified auth channel (PR-1): exec prompts render via ToolAuthModal.
// exec deliberately passes memoryKey: null — exec grants are tuned through
// execpolicy.json, never through "always allow".
import { useToolAuthStore } from '@/store/tool-auth.store'
// YOLO mode (conversation-scoped): when on, exec skips the prompt-level
// approval modal entirely. Forbidden stays enforced (checked BEFORE this),
// mirroring policy-engine where yolo never covers forbidden tools.
import { isYoloOn } from '@/store/yolo-mode.store'
import { isNativeHostReachable, probeNativeHost } from '@/lib/native-host-probe'

// ─── Bridge types ──────────────────────────────────────────────

interface AgentWebBridge {
  nativeHostCall(payload: Record<string, unknown>): Promise<any>
  nativeHostCheckPolicy(command: string[]): Promise<{
    ok: boolean
    decision?: 'auto' | 'prompt' | 'forbidden'
    command?: string[]
    error?: string
  }>
}

// ─── Capability detection ─────────────────────────────────────

/**
 * Check if the Native Host exec bridge is available.
 * Requires BOTH nativeHostCall and nativeHostCheckPolicy on __agentWeb,
 * AND a verified-ping native host (see native-host-probe.ts). The shallow
 * bridge check alone would register exec with the extension installed but
 * the Rust binary missing — every call would then fail with a raw Chrome
 * "Native messaging host not found" error instead of the tool simply not
 * existing for the model.
 */
export function isExecBridgeAvailable(): boolean {
  const w = typeof window !== 'undefined'
    ? (window as unknown as { __agentWeb?: Partial<AgentWebBridge> })
    : undefined
  if (!w?.__agentWeb) return false
  const bridgePresent =
    typeof w.__agentWeb.nativeHostCall === 'function' &&
    typeof w.__agentWeb.nativeHostCheckPolicy === 'function'
  if (!bridgePresent) return false
  // Kick the cached probe (idempotent, dedup'd) and gate on its result.
  // getToolRegistry() retries registerExecTool() on every access, so a
  // successful ping registers exec on the next access after boot.
  void probeNativeHost()
  return isNativeHostReachable()
}


function getExecBridge(): AgentWebBridge | null {
  if (!isExecBridgeAvailable()) return null
  const w = window as unknown as { __agentWeb: AgentWebBridge }
  return w.__agentWeb
}

// ─── Tool definition ──────────────────────────────────────────

export const execDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'exec',
    description: [
      'Run a controlled command in an authorized Native Host project root. Use this tool primarily to inspect or verify work: list files, search text, inspect status, or run tests, builds, type checks, and linters.',
      '',
      'Do NOT use exec to read, create, modify, rename, or delete project files. Use read, write, edit, and delete for file operations so changes remain visible in the workspace pending/sync flow.',
      '',
      'Provide command as an argv array: the executable is the first element and every argument is a separate later element. Do not use a shell command string or shell syntax such as bash, sh, zsh, cd, &&, ||, |, >, <, $(), or shell redirects. A command beginning with a shell interpreter is usually a sign that the operation should be expressed as one direct argv command instead.',
      'Examples: ["git", "status"], ["rg", "TODO", "src"], ["pnpm", "run", "typecheck"].',
      '',
      'Commands always run inside an authorized root. Set root to a root name such as "<root-name>" when there is more than one available root. To run in a subdirectory, set cwd to a RELATIVE path such as "packages/app"; never provide an absolute path and never use cd.',
      '',
      'The result includes stdout, stderr, exit_code, timeout status, and output-truncation status. Inspect these fields before deciding whether verification succeeded.',
      '',
      'Approval policy (from execpolicy.json):',
      '  - Read-only inspection commands and common build/test/lint commands are usually auto-approved',
      '  - Dangerous commands are forbidden',
      '  - Other commands prompt the user for approval',
      '  - When the user has enabled YOLO mode, approval prompts are skipped and commands run immediately; forbidden commands are still blocked',
      '',
      'Requires both the Native Host and an authorized native-host root. FS Access-only roots cannot execute commands.',
      '',
      'IMPORTANT — no-root auto-authorization: when the call omits "root" and no native-host root is authorized yet (and the Native Host is reachable), exec does NOT fail immediately. Instead the user gets an authorization modal; on approval the OS folder picker opens, the user picks a directory (the project/monorepo root works best), and the command runs inside it — all in this one call. There is nothing to configure beforehand; just call exec normally without "root". If the user declines or picks nothing, a no_scope error explains the manual path (cable icon → "Local connection").',
      '',
      'Long-running processes (dev servers): set background to true and give the process a short name. One call starts it, waits until the port is ready (or ready_timeout / early exit), and returns the URL plus the log tail — you never poll. Later, use the `processes` tool to list processes, read recent output, or stop one by name.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'array',
          description: 'Required argv array. First element is the executable; each later element is one literal argument. Do not pass a shell string, bash/sh/zsh, or shell syntax (cd, &&, pipes, redirects). Prefer read-only inspection and verification commands. Example: ["pnpm", "run", "typecheck"].',
          items: { type: 'string' },
        },
        root: {
          type: 'string',
          description: 'Authorized Native Host root name (for example, "<root-name>"). The command runs inside this root. Provide it whenever more than one root is available; never pass a file path or an absolute disk path. If omitted, the first available native-host root is used.',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory RELATIVE to root (for example, "packages/app"). Defaults to the root directory. Must not be absolute and must not escape root; use this instead of a cd command.',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds. Defaults to 120000 (2 min). Max 600000 (10 min). Commands that exceed the timeout are killed.',
        },
        background: {
          type: 'boolean',
          description: 'Run as a detached background process (dev server). One call = start + wait until ready, returns { process_id, state: ready|timeout|exited, url, log_tail }. Requires user approval unless YOLO mode is on.',
        },
        name: {
          type: 'string',
          description: 'Short unique name for a background process (for example "web"). Required with background; later logs/stop calls reference the process by this name.',
        },
        port: {
          type: 'number',
          description: 'Expected localhost port for readiness detection of a background process (for example 5173). If omitted, the port is parsed from the process log output.',
        },
        ready_timeout: {
          type: 'number',
          description: 'Max milliseconds to wait for a background process port to become ready. Defaults to 60000. On timeout the process keeps running; the result says state=timeout with the log tail.',
        },
      },
      required: ['command'],
    },
  },
}

// ─── Constants ────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000

/**
 * Serialize the disk-sync and native-host execution phases per root. Authorization
 * stays outside this queue so users can review a batch immediately, while calls
 * targeting the same disk root cannot flush or execute concurrently.
 */
const execExecutionTails = new Map<string, Promise<void>>()

function serializeExecExecution<T>(scopeId: string, operation: () => Promise<T>): Promise<T> {
  const previous = execExecutionTails.get(scopeId) ?? Promise.resolve()
  const execution = previous.then(operation, operation)
  const next = execution.then(
    () => undefined,
    () => undefined,
  )
  execExecutionTails.set(scopeId, next)
  void next.finally(() => {
    if (execExecutionTails.get(scopeId) === next) {
      execExecutionTails.delete(scopeId)
    }
  })
  return execution
}

// ─── Executor ─────────────────────────────────────────────────

export const execExecutor: ToolExecutor = async (args, context) => {
  const command = args.command
  const rootName = typeof args.root === 'string' ? args.root : undefined
  const cwd = typeof args.cwd === 'string' ? args.cwd : undefined
  const timeoutRaw = typeof args.timeout === 'number' ? args.timeout : DEFAULT_TIMEOUT
  const timeout = Math.max(1_000, Math.min(timeoutRaw, MAX_TIMEOUT))
  const background = args.background === true
  const procName = typeof args.name === 'string' ? args.name : undefined

  // --- Validate command ---
  if (!Array.isArray(command) || command.length === 0) {
    return toolErrorJson('exec', 'INVALID_INPUT',
      'Parameter "command" must be a non-empty array of strings.',
      { retryable: true })
  }
  const cmdStrings = command.map(String)
  const cmdDisplay = cmdStrings.join(' ')

  // --- Check bridge availability ---
  const bridge = getExecBridge()
  if (!bridge) {
    return toolErrorJson('exec', 'bridge_unavailable',
      'Native Host exec bridge is not available. Install the Native Host and authorize a native-host root first.',
      { hint: 'Use ls() without arguments to check if native-host roots are authorized.' })
  }

  // --- Resolve scope_id from root name ---
  let scopeId = await resolveScopeId(rootName, context)
  if (!scopeId) {
    // No native-host root for this project. Before giving up, offer ONE
    // in-flow authorization: if the native host is actually reachable and
    // the caller didn't explicitly request a root that doesn't exist, ask
    // the user via the shared auth modal; on approval, pop the OS folder
    // picker (native host `pick_folder`) and retry the resolution. This
    // turns the former dead end ("no root → exec unusable, agent must tell
    // the user to find the cable icon") into a two-click flow.
    scopeId = rootName
      ? null
      : await authorizeRootInFlow(context, cmdDisplay)
    if (!scopeId) {
      return rootName
        ? toolErrorJson('exec', 'no_scope',
            `No native-host root named "${rootName}" found. Use ls() to list available roots.`,
            { hint: 'Only native-host roots (marked with the cable icon) support command execution.' })
        : toolErrorJson('exec', 'no_scope',
            'No native-host root authorized. Authorize a directory via native host first.',
            { hint: 'Only native-host roots (marked with the cable icon) support command execution. The user can add one via the cable icon ("Local connection") next to the folder selector, or approve the in-flow authorization prompt when exec is called again without an explicit root.' })
    }
  }

  // --- Step 1: check_policy ---
  let decision: 'auto' | 'prompt' | 'forbidden'
  try {
    const policyResp = await bridge.nativeHostCheckPolicy(cmdStrings)
    if (!policyResp.ok || !policyResp.decision) {
      return toolErrorJson('exec', 'policy_check_failed',
        `Failed to check command policy: ${policyResp.error ?? 'unknown error'}`)
    }
    decision = policyResp.decision
  } catch (err) {
    return toolErrorJson('exec', 'policy_check_failed',
      `Failed to check command policy: ${err instanceof Error ? err.message : String(err)}`)
  }

  // --- Step 2: Handle forbidden ---
  if (decision === 'forbidden') {
    return toolErrorJson('exec', 'forbidden',
      `Command "${cmdDisplay}" is forbidden by the exec policy.`,
      {
        hint: 'Dangerous commands (rm, sudo, curl, etc.) are blocked. If this is a false positive, edit ~/.creatorweave/execpolicy.json.',
      })
  }

  // Background processes always require explicit user approval in normal
  // modes: they keep running after the session, hold ports, and continuously
  // execute AI-modified code — one risk tier above one-shot commands. Under
  // YOLO (branch below) they skip the prompt like everything else.
  if (background && decision === 'auto') {
    decision = 'prompt'
  }

  // --- Step 2.5: YOLO mode skips the prompt-level approval ---
  // Mirrors policy-engine decision step 3: yolo covers everything prompt-level
  // but never forbidden (already returned above). This includes the forced
  // background-process prompt — YOLO's contract is "run without interrupting
  // me", so one-shot and background commands behave the same here. Forbidden
  // commands (execpolicy.json) remain blocked regardless of yolo. A dedicated
  // command-safety reviewer agent may later re-check the prompt/forbidden
  // boundary inside this branch.
  if (decision === 'prompt' && isYoloOn(context.workspaceId)) {
    decision = 'auto'
  }

  // --- Step 3: Handle prompt (needs user approval) ---
  // Uses a standalone auth modal (exec-auth.store), NOT context.askUserQuestion.
  // Same pattern as page-write-auth: a UI-level confirmation that blocks tool
  // execution until the user decides. The LLM never sees an approval token
  // and cannot bypass it.
  // Description carries ONLY the execution-context explanation (which
  // project root, which subdir, whether the process keeps running). The
  // command itself is rendered separately by ExecAuthModal — embedding it
  // here would flood the modal whenever an argv element contains newlines
  // (e.g. `git commit -m <multi-line commit message>`).
  const projectLabel = rootName ?? scopeId
  const subdir = cwd ? ` (subdir: ${cwd})` : ''
  const description = background
    ? `This BACKGROUND process will start in the "${projectLabel}" project directory${subdir}${procName ? ` as "${procName}"` : ''} and keep running until stopped.`
    : `This command will run in the "${projectLabel}" project directory${subdir}.`

  if (decision === 'prompt') {
    const resolution = await useToolAuthStore.getState().request({
      toolName: 'exec',
      description,
      // The command renders in the modal's code block (ExecAuthModal-era UX,
      // preserved in ToolAuthModal via `detail`).
      detail: cmdStrings.join(' '),
      memoryKey: null,
      conversationId: context.workspaceId ?? null,
      signal: context.abortSignal,
    })
    const approved = resolution.approved

    // Stale-approval guard: the auth queue is global and outlives loop
    // lifecycles, so the user may approve a request whose originating run
    // was already aborted/interrupted. Never let that execute. Mirrors the
    // guard in page-write.tool.ts.
    if (!approved || context.abortSignal?.aborted) {
      return toolErrorJson('exec', 'user_denied',
        `User denied execution of "${cmdDisplay}".`,
        { retryable: false })
    }
  }

  return serializeExecExecution(scopeId, async () => {
    // --- Step 3.5 (REMOVED in PR-3): the old silent auto-flush before
    // execution was an authorization bypass — it wrote pending changes to
    // the real disk without any user confirmation, including delete-type
    // changes. Disk sync now flows ONLY through sync-to-disk (prompt-level,
    // authorized) or the run-level auto-apply. Instead, if the target root
    // still has pending changes, the result tells the LLM exactly that (see
    // buildStaleDiskNotice below) so it can call sync-to-disk itself when
    // the command result depends on fresh content.

    // --- Step 4a: Background process start ---
  // exec_start ALWAYS required user approval above (decision 'prompt' is
  // forced for background: true — see policy check above), the child is
  // detached from the host, and this call waits for readiness internally so
  // the model gets one single result.
  if (background) {
    // Stale-disk check at START time: a dev server/build runs for minutes
    // reading from disk — if the root holds unsynced pending changes, the
    // process (and any test/build result it produces) sees stale content.
    const staleDiskNotice = await buildStaleDiskNotice(context.workspaceId, rootName)
    return startBackgroundProcess({
      scopeId,
      cmdStrings,
      cmdDisplay,
      name: procName,
      cwd,
      port: typeof args.port === 'number' ? args.port : undefined,
      readyTimeout: typeof args.ready_timeout === 'number' ? args.ready_timeout : 60_000,
      abortSignal: context.abortSignal,
      staleDiskNotice,
    })
  }

  // --- Step 4: Execute via stateless exec_sync (sendNativeMessage) ---
  // Uses the same stateless channel as file IO (nativeHostCall → sendNativeMessage).
  // The streaming relay (connectNative) is not yet reliable; this avoids it entirely.
  const agentWeb = (window as any).__agentWeb
  let result: any
  try {
    result = await agentWeb.nativeHostCall({
      action: 'exec_sync',
      scope_id: scopeId,
      command: cmdStrings,
      ...(cwd ? { cwd } : {}),
      ...(typeof timeout === 'number' ? { timeout: Math.floor(timeout / 1000) } : {}),
    })
  } catch (err) {
    return toolErrorJson('exec', 'execution_error',
      `Command "${cmdDisplay}" failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!result || !result.ok) {
    return toolErrorJson('exec', 'execution_error',
      `Command "${cmdDisplay}" failed: ${result?.error ?? 'unknown error'}`)
  }

  // --- Build result ---
  const stdout = (result.stdout as string) || ''
  const stderr = (result.stderr as string) || ''
  const fullOutput = [stdout, stderr ? `\n[stderr]\n${stderr}` : '']
    .filter(Boolean)
    .join('')

  // Post-execution stale-disk check for the FOREGROUND result only (the
  // background branch computes its own notice at start time).
  const staleDiskNotice = await buildStaleDiskNotice(context.workspaceId, rootName)

    return toolOkJson('exec', {
      command: cmdStrings,
      exit_code: result.exit_code ?? null,
      signal: result.signal ?? null,
      timed_out: result.timed_out === true,
      stdout: stdout || undefined,
      stderr: stderr || undefined,
      output: fullOutput || undefined,
      truncated: result.truncated === true,
      scope_id: scopeId,
      ...(staleDiskNotice ? { stale_disk: staleDiskNotice } : {}),
      ...(cwd ? { cwd } : {}),
      ...(rootName ? { root: rootName } : {}),
    }, {
      ...(staleDiskNotice ? { hint: staleDiskNotice.hint } : {}),
      ...(result.exit_code != null && result.exit_code !== 0
        ? { hint: `Command exited with code ${result.exit_code}. Check stdout/stderr above for errors.` }
        : {}),
    })
  })
}

// ─── Scope resolution ─────────────────────────────────────────

/**
 * Resolve a native-host scope_id from a root name.
 *
 * Strategy:
 * 1. If rootName is provided, look it up in the project_roots table (backend='native-host')
 * 2. If not, find the first native-host root for the current project
 * 3. Returns null if no native-host root is available
 */
async function resolveScopeId(
  rootName: string | undefined,
  context: { projectId?: string | null; workspaceId?: string | null }
): Promise<string | null> {
  try {
    const { getProjectRootRepository } = await import(
      '@/sqlite/repositories/project-root.repository'
    )
    const repo = getProjectRootRepository()
    const roots = await repo.findByProject(context.projectId ?? '')

    // Filter to native-host roots only
    const nativeHostRoots = roots.filter((r: any) => r.backend === 'native-host')

    if (rootName) {
      const match = nativeHostRoots.find((r: any) => r.name === rootName)
      return match?.scopeId ?? null
    }

    // No rootName → return the first (default) native-host root
    const defaultRoot = nativeHostRoots.find((r: any) => r.isDefault) ?? nativeHostRoots[0]
    return defaultRoot?.scopeId ?? null
  } catch {
    return null
  }
}

// ─── In-flow root authorization ───────────────────────────────

/**
 * Dedup guard: concurrent exec calls hitting the no-root state must share ONE
 * authorization flow, otherwise two auth modals (and two OS folder pickers)
 * pile up for the same missing root.
 */
let authorizeRootInFlight: Promise<string | null> | null = null

/**
 * Offer an in-flow native-host root authorization when exec runs with no
 * authorized root.
 *
 * Flow: full-chain probe (page → extension → Rust host) → shared auth modal
 * (user-facing explanation + the pending command as a `$ …` preview; the
 * command's own execpolicy approval, when required, comes separately later)
 * → the existing `addNativeHostRoot` store action, which pops the OS folder
 * picker (native host `pick_folder`), registers the scope in the host's
 * scopes.json (host-side dedup by canonical path means re-authorizing the
 * same folder returns the SAME scope_id — `scope.rs add_scope`), creates the
 * `project_roots` SQLite row and invalidates the root-map cache. On success
 * the caller retries `resolveScopeId` and the command proceeds in the same
 * tool call.
 *
 * Security posture is unchanged: the user picks the directory in the OS
 * dialog and explicitly approves the modal; the agent never sees or chooses
 * a path. Returns the fresh scope_id, or null when any step is declined /
 * unavailable (the caller then returns the actionable no_scope error).
 */
async function authorizeRootInFlow(
  context: { projectId?: string | null; workspaceId?: string | null; abortSignal?: AbortSignal },
  cmdDisplay?: string,
  projectId?: string | null
): Promise<string | null> {
  // Full-chain reachability: don't offer the flow when the Rust host isn't
  // installed — the folder picker would never appear.
  await probeNativeHost()
  if (!isNativeHostReachable()) return null
  if (context.abortSignal?.aborted) return null

  if (authorizeRootInFlight) return authorizeRootInFlight
  authorizeRootInFlight = doAuthorizeRootInFlow(context, cmdDisplay, projectId).finally(() => {
    authorizeRootInFlight = null
  })
  return authorizeRootInFlight
}

async function doAuthorizeRootInFlow(
  context: { projectId?: string | null; workspaceId?: string | null; abortSignal?: AbortSignal },
  cmdDisplay?: string,
  projectId?: string | null
): Promise<string | null> {
  const resolution = await useToolAuthStore.getState().request({
    toolName: 'exec',
    // Locale-aware descriptor rendered by ToolAuthModal.
    description: { key: 'describeAuthorizeRoot' },
    // The pending command renders as a `$ …` code block (ToolAuthModal's
    // exec-like path) so the user can see what the authorization is FOR
    // before picking a directory.
    detail: cmdDisplay,
    memoryKey: null,
    conversationId: context.workspaceId ?? null,
    signal: context.abortSignal,
  })
  if (!resolution.approved || context.abortSignal?.aborted) return null

  // Reuse the store action: OS folder picker + scopes.json registration +
  // project_roots row + root-map cache invalidation + toasts, all in one.
  // Bind the new root to the CONVERSATION's project (context.projectId), not
  // the global active-project pointer: resolveScopeId() looks the root up
  // under the conversation's project, and the active pointer can change
  // mid-run while the OS picker is open.
  const { useFolderAccessStore } = await import('@/store/folder-access.store')
  const added = await useFolderAccessStore.getState().addNativeHostRoot(projectId ?? undefined)
  if (!added) return null
  // Stale-authorization guard: the OS folder picker blocks for an unbounded
  // time and the user may have aborted the run while it was open. Keep the
  // freshly authorized root (explicitly user-approved — do not roll it back),
  // but never let the pending command execute on an aborted run: execpolicy-
  // 'auto' commands have no further approval gate after this point.
  if (context.abortSignal?.aborted) return null

  // The new root carries a fresh scope_id — resolve it directly instead of
  // guessing it from the store shape.
  return resolveScopeId(undefined, context)
}

// ─── Background processes ─────────────────────────────────────

function nativeHostCall(payload: Record<string, unknown>): Promise<any> {
  const agentWeb = (window as any).__agentWeb
  return agentWeb.nativeHostCall(payload)
}

/** Decode a base64 chunk from exec_logs into a string. */
function decodeBase64ToString(b64: string): string {
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return ''
  }
}

/** Extract the last localhost:<port> mention from a log string. */
function parsePortFromLog(log: string): number | undefined {
  const matches = [...log.matchAll(/(?:localhost|127\.0\.0\.1):(\d{2,5})/g)]
  const last = matches[matches.length - 1]
  if (!last) return undefined
  const port = Number(last[1])
  return port > 0 && port <= 65535 ? port : undefined
}

async function readLogTail(processId: string, tailBytes = 64_000): Promise<string> {
  const resp = await nativeHostCall({ action: 'exec_logs', process_id: processId, tail: tailBytes })
  if (!resp?.ok) return ''
  return decodeBase64ToString(String(resp.data ?? ''))
}

/**
 * Start a detached background process and wait (inside this tool call) until
 * its port is ready, it exits early, or readyTimeout elapses. Returns ONE
 * result — the model never polls.
 */
async function startBackgroundProcess(params: {
  scopeId: string
  cmdStrings: string[]
  cmdDisplay: string
  name: string | undefined
  cwd: string | undefined
  port: number | undefined
  readyTimeout: number
  abortSignal?: AbortSignal
  staleDiskNotice?: StaleDiskNotice | null
}) {
  const {
    scopeId, cmdStrings, cmdDisplay, name, cwd, port, readyTimeout,
    abortSignal, staleDiskNotice,
  } = params

  if (!name) {
    return toolErrorJson('exec', 'INVALID_INPUT',
      'Parameter "name" is required with background: true (a short process name such as "web").',
      { retryable: true })
  }

  // --- Start ---
  let startResp: any
  try {
    startResp = await nativeHostCall({
      action: 'exec_start',
      scope_id: scopeId,
      command: cmdStrings,
      name,
      ...(cwd ? { cwd } : {}),
    })
  } catch (err) {
    return toolErrorJson('exec', 'start_failed',
      `Failed to start "${cmdDisplay}": ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!startResp?.ok) {
    return toolErrorJson('exec', 'start_failed',
      `Failed to start "${cmdDisplay}": ${startResp?.error ?? 'unknown error'}`)
  }
  const processId: string = startResp.process_id

  // --- Wait for readiness (single internal loop, no tool-call polling) ---
  const deadline = Date.now() + readyTimeout
  let detectedPort = port
  let lastLog = ''

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) break

    // Early exit detection
    let status: any
    try {
      status = await nativeHostCall({
        action: 'exec_status',
        process_id: processId,
        ...(detectedPort ? { probe_port: detectedPort } : {}),
      })
    } catch {
      status = null
    }
    if (status?.ok) {
      if (status.state !== 'running') {
        // Process died before becoming ready — surface the log for diagnosis.
        const log = await readLogTail(processId).catch(() => '')
        window.dispatchEvent(new CustomEvent('cw:bg-processes-changed'))
        return toolOkJson('exec', {
          background: true,
          process_id: processId,
          name,
          state: 'exited',
          exit_code: status.exit_code ?? null,
          log_tail: log.slice(-4000) || undefined,
          ...(staleDiskNotice ? { stale_disk: staleDiskNotice } : {}),

        }, {
          hint: [
            'The background process exited before its port became ready. Read log_tail for the error.',
            staleDiskNotice?.hint,
          ].filter(Boolean).join(' '),
        })
      }
      if (status.port_ready === true) {
        const log = await readLogTail(processId).catch(() => '')
        window.dispatchEvent(new CustomEvent('cw:bg-processes-changed'))
        return toolOkJson('exec', {
          background: true,
          process_id: processId,
          name,
          state: 'ready',
          url: `http://localhost:${detectedPort}`,
          port: detectedPort,
          log_tail: log.slice(-4000) || undefined,
          ...(staleDiskNotice ? { stale_disk: staleDiskNotice } : {}),

        }, {
          hint: [
            `The dev server is running in the background. The user can open the URL directly. Stop it later with the processes tool: processes({ action: "stop", process: "${name}" }).`,
            staleDiskNotice?.hint,
          ].filter(Boolean).join(' '),
        })
      }
    }

    // Port not known yet — try to sniff it from fresh log output.
    lastLog = await readLogTail(processId).catch(() => lastLog)
    if (!detectedPort) {
      detectedPort = parsePortFromLog(lastLog) ?? port
    }

    await new Promise((r) => setTimeout(r, 500))
  }

  // Ready timeout — the process keeps running; report state with logs.
  const log = lastLog || (await readLogTail(processId).catch(() => ''))
  window.dispatchEvent(new CustomEvent('cw:bg-processes-changed'))
  return toolOkJson('exec', {
    background: true,
    process_id: processId,
    name,
    state: 'timeout',
    ...(detectedPort ? { port: detectedPort } : {}),
    log_tail: log.slice(-4000) || undefined,
    ...(staleDiskNotice ? { stale_disk: staleDiskNotice } : {}),

  }, {
    hint: [
      `Port not ready after ${Math.round(readyTimeout / 1000)}s; the process is still running. Check log_tail, or read more with processes({ action: "logs", process: "${name}" }).`,
      staleDiskNotice?.hint,
    ].filter(Boolean).join(' '),
  })
}

// ─── Stale-disk notice (replaces the removed exec auto-flush) ──────────
//
// PR-3 removed the silent flush that wrote pending changes to disk before
// every exec call — it was an authorization bypass (no user confirmation,
// delete-type changes included). The trade-off: a command now sees the OLD
// disk content while OPFS holds the new one. This notice re-establishes
// DIAGNOSABILITY (the causal chain enters the LLM's context) without
// re-introducing the bypass: the LLM must call sync-to-disk (authorized) if
// it needs the command to see fresh content.

export interface StaleDiskNotice {
  /** Pending paths in the target root (truncated when long). */
  pendingPaths: string[]
  /** Pending paths of type delete — deleted files may STILL exist on disk. */
  pendingDeletions: string[]
  /** Total pending count before truncation. */
  total: number
  /** LLM-facing hint (also attached as result.hint). */
  hint: string
}

const STALE_DISK_PATH_LIMIT = 10

/**
 * Check the exec target root for pending changes and, if any, build the
 * notice explaining that the command ran against stale disk content.
 * Best-effort: any failure returns null (never blocks execution reporting).
 */
async function buildStaleDiskNotice(
  workspaceId: string | null | undefined,
  rootName: string | undefined,
): Promise<StaleDiskNotice | null> {
  try {
    if (!workspaceId) return null

    const { getWorkspaceManager } = await import('@/opfs')
    const manager = await getWorkspaceManager()
    const workspace = await manager.getWorkspace(workspaceId)
    if (!workspace) return null

    const pending = workspace.getPendingChanges()
    if (pending.length === 0) return null

    // Only paths routed to the target root (explicit rootName, or the
    // default native-host root when unspecified — same targeting the old
    // flush used). Unresolvable paths are ignored.
    const targetPaths: string[] = []
    for (const change of pending) {
      try {
        const resolved = await workspace.resolvePath(change.path)
        if (resolved.backend !== 'native-host') continue
        if (rootName && resolved.rootName !== rootName) continue
        if (!rootName && resolved.rootName !== (await defaultNativeHostRootName(workspaceId))) {
          continue
        }
        targetPaths.push(change.path)
      } catch {
        // Unresolvable — skip.
      }
    }
    if (targetPaths.length === 0) return null

    const pendingByPath = new Map(pending.map((c) => [c.path, c]))
    const pendingDeletions = targetPaths.filter(
      (p) => pendingByPath.get(p)?.type === 'delete',
    )
    const displayPaths = targetPaths.slice(0, STALE_DISK_PATH_LIMIT)
    const suffix =
      targetPaths.length > STALE_DISK_PATH_LIMIT
        ? ` (…and ${targetPaths.length - STALE_DISK_PATH_LIMIT} more)`
        : ''

    const hint =
      `The command ran against DISK content, but ${targetPaths.length} pending change(s) in this root ` +
      `are NOT on disk yet: ${displayPaths.join(', ')}${suffix}. ` +
      (pendingDeletions.length > 0
        ? `Note: ${pendingDeletions.length} of these are DELETE-type changes — the deleted file(s) may still exist on disk (ghost files). `
        : '') +
      `If this result depends on the latest file content, call sync-to-disk (asks the user for ` +
      `permission; pending deletions are included and listed in the approval modal) and re-run the command.`

    return {
      pendingPaths: displayPaths,
      pendingDeletions,
      total: targetPaths.length,
      hint,
    }
  } catch {
    return null
  }
}

/** Name of the first native-host root for the project (mirrors resolveScopeId's default). */
async function defaultNativeHostRootName(workspaceId: string): Promise<string | null> {
  try {
    const { getWorkspaceManager } = await import('@/opfs')
    const manager = await getWorkspaceManager()
    const workspace = await manager.getWorkspace(workspaceId)
    if (!workspace) return null
    const projectId = await (workspace as any).resolveProjectId?.()
    if (!projectId) return null
    const { getProjectRootRepository } = await import(
      '@/sqlite/repositories/project-root.repository'
    )
    const roots = await getProjectRootRepository().findByProject(projectId)
    const nativeHostRoots = roots.filter((r: any) => r.backend === 'native-host')
    const defaultRoot = nativeHostRoots.find((r: any) => r.isDefault) ?? nativeHostRoots[0]
    return defaultRoot?.name ?? null
  } catch {
    return null
  }
}

// ─── Prompt doc ───────────────────────────────────────────────

export const execPromptDoc: ToolPromptDoc = {
  category: 'execution',
  section: '### Command Execution',
  lines: [
    '- `exec(command, root?, cwd?, timeout?)` — Run a controlled command inside an authorized Native Host root, primarily for read-only inspection and verification (tests/build/typecheck/lint).',
    '  - Use `read` / `write` / `edit` / `delete` for all file operations. Do not use exec to create, modify, rename, or delete files; those changes bypass the normal workspace pending/sync flow.',
    '  - Pass an argv array, never a shell string: `["git", "status"]`, `["rg", "TODO", "src"]`, `["pnpm", "run", "typecheck"]`. Do not start commands with `bash`, `sh`, or `zsh`; that usually means the operation should be expressed as one direct argv command instead. Do not use `cd`, pipes, redirects, `&&`, `||`, or command substitution.',
    '  - `root` is an authorized root name such as `"<root-name>"`, not a file path. Specify it whenever multiple roots exist. `cwd`, when needed, is relative to root (for example `"packages/app"`), never absolute; use it instead of `cd`.',
    '  - Check `exit_code`, `stdout`, `stderr`, `timed_out`, and `truncated` in the result. Read-only and common verification commands are usually auto-approved; other commands require user approval, and dangerous commands are blocked. When YOLO mode is on, approval prompts are skipped and commands run immediately (dangerous commands remain blocked).',
    '  - Commands see the version of the files that is ON DISK. Pending changes (from write/edit) are NOT on disk until synced: if a result carries `stale_disk`, the target root still has unsynced changes — call `sync-to-disk` first (asks the user for permission) and re-run the command when its result depends on those files. Delete-type changes are never auto-applied and may leave deleted files still present on disk.',
    '  - If no native-host root is authorized yet, calling exec without `root` triggers an in-flow authorization: the user confirms a modal, picks a folder in the OS picker, and the command runs inside it in the same call. Do not ask the user to pre-authorize anything manually — just call exec normally.',
    '  - For long-running processes (dev servers): `exec({ command, background: true, name: "web", port: 5173 })` starts one and waits until ready in a single call. List / inspect / stop background processes with the `processes` tool.',
  ],
}
