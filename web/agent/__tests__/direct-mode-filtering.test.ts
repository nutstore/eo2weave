/**
 * Direct-mode tool filtering (kind='direct' conversations):
 *
 * Direct conversations have NO folder authorization, so every
 * folder-dependent AND host-capable tool must be invisible to the agent —
 * in BOTH plan and act modes, and both at registration
 * (getToolDefinitionsForMode) and execution (invokeTool) layers. Everything
 * else (page_*, run_python, bash, skills, subagents, schedule) must stay
 * available.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  FOLDER_DEPENDENT_TOOLS,
  getToolCategory,
  isToolAllowedInDirectMode,
  TOOL_MODE_CLASSIFICATION,
} from '@/agent/agent-mode'
import { getToolRegistry } from '@/agent/tool-registry'

// The exec/processes tools register only when the native-host probe reports
// reachable — an async ping that never completes in the test environment.
// Mock it reachable so registerExecTool() behaves as it does with a live
// native host; the guard under test fires before any executor runs, so no
// native messaging happens in these tests.
vi.mock('@/lib/native-host-probe', () => ({
  isNativeHostReachable: () => true,
  probeNativeHost: () => Promise.resolve('reachable' as const),
  getNativeHostProbeState: () => 'reachable' as const,
  subscribeNativeHostProbe: () => () => {},
}))

describe('directMode tool filtering', () => {
  // Independent of FOLDER_DEPENDENT_TOOLS: if the set ever drops one of these
  // names, the checks below fail LOUDLY instead of silently passing because
  // they iterate the very set under test.
  const REQUIRED_FOLDER_DEPENDENT_TOOLS = [
    'read', 'write', 'edit', 'delete', 'ls', 'search',
    'snapshot_status', 'snapshot_diff', 'snapshot_log', 'snapshot_show',
    'snapshot_restore', 'sync-to-opfs',
    'read_image', 'ocr',
  ] as const

  // Independent enumeration of host-capable tools (exec/processes need the
  // Native Host; sync-to-disk/detect_conflicts write or inspect real disk;
  // checkpoint tools are registered dynamically when a directory handle
  // exists). If the direct-mode guard ever drops one of these, the checks
  // below fail loudly.
  const REQUIRED_HOST_CAPABLE_TOOLS = [
    'exec', 'processes', 'sync-to-disk', 'detect_conflicts',
    'create_checkpoint', 'rollback_checkpoint',
  ] as const

  // Registry setup runs in shared setup, not inside the first test: the
  // filtering, default-registry, and execution tests below all assert against
  // the full registry (including the dynamically registered checkpoint
  // tools), and each must hold when run standalone — not only when the
  // enumeration test happened to run first. registerExecTool() and
  // registerCheckpointTools() are idempotent (has() guards), so running them
  // once here is safe regardless of test order or -t selection.
  beforeAll(() => {
    // Mirror the production registration sequence: exec/processes ride the
    // native-host bridge (bridge stub + probe mocked reachable above) and
    // checkpoint tools are registered when a native directory handle is
    // granted. The guards under test must hold for the full registry, not a
    // partial one.
    const w = window as unknown as { __agentWeb?: Record<string, unknown> }
    w.__agentWeb = {
      nativeHostCall: () => Promise.resolve({}),
      nativeHostCheckPolicy: () => Promise.resolve({ ok: true, decision: 'auto' as const }),
    }
    const registry = getToolRegistry()
    registry.registerExecTool()
    registry.registerCheckpointTools()
  })

  it('FOLDER_DEPENDENT_TOOLS covers exactly the task-mandated tool set', () => {
    for (const name of REQUIRED_FOLDER_DEPENDENT_TOOLS) {
      expect(FOLDER_DEPENDENT_TOOLS.has(name), name).toBe(true)
    }
  })

  it('isToolAllowedInDirectMode rejects folder tools and keeps everything else', () => {
    for (const name of REQUIRED_FOLDER_DEPENDENT_TOOLS) {
      expect(isToolAllowedInDirectMode(name), name).toBe(false)
    }
    // Host-capable tools are excluded too, even though they are not
    // folder-dependent: exec/processes reach the host machine, and
    // sync-to-disk / detect_conflicts / checkpoint tools touch real-disk
    // state. A standalone chat has no folder authorized, so none of these
    // may run there.
    for (const name of REQUIRED_HOST_CAPABLE_TOOLS) {
      expect(isToolAllowedInDirectMode(name), name).toBe(false)
    }
    // Retained capabilities (design decision): page_*, run_python, skills,
    // webmcp app-tools (external bridge), spawn_subagent, schedule.
    for (const name of [
      'run_python', 'bash', 'web_search', 'web_fetch',
      'page_snapshot', 'page_click', 'page_screenshot',
      'read_skill', 'search_skills', 'search_tools', 'call_tool',
      'spawn_subagent', 'manage_schedule', 'ask_user_question', 'generate_image',
    ]) {
      expect(isToolAllowedInDirectMode(name), name).toBe(true)
    }
  })

  it('every folder-dependent tool exists in TOOL_MODE_CLASSIFICATION (no phantom entries)', () => {
    for (const name of FOLDER_DEPENDENT_TOOLS) {
      expect(TOOL_MODE_CLASSIFICATION.has(name), name).toBe(true)
    }
  })

  it('getToolDefinitionsForMode hides folder tools in act mode with directMode', () => {
    const registry = getToolRegistry()
    const names = (direct: boolean) =>
      registry.getToolDefinitionsForMode('act', { directMode: direct }).map((d) => d.function.name)

    const projectNames = names(false)
    const directNames = names(true)

    for (const name of FOLDER_DEPENDENT_TOOLS) {
      expect(projectNames, `project must register ${name}`).toContain(name)
      expect(directNames, `direct must NOT register ${name}`).not.toContain(name)
    }
    // Independent enumeration again: a tool dropped from the set must still
    // fail here if the registry (not the set) regressed.
    for (const name of REQUIRED_FOLDER_DEPENDENT_TOOLS) {
      expect(directNames, `direct must NOT register ${name}`).not.toContain(name)
    }
    // Host-capable tools must not register in direct mode either — including
    // the dynamically registered checkpoint tools.
    for (const name of REQUIRED_HOST_CAPABLE_TOOLS) {
      expect(projectNames, `project must register ${name}`).toContain(name)
      expect(directNames, `direct must NOT register ${name}`).not.toContain(name)
    }
    // Retained capabilities survive in direct mode. (web_search/web_fetch are
    // web-bridge tools registered only when the Browser Extension is detected —
    // absent from this bare registry, so not asserted here.)
    for (const name of ['run_python', 'bash', 'spawn_subagent', 'manage_schedule']) {
      expect(directNames, `direct must keep ${name}`).toContain(name)
    }
  })

  it('directMode also filters in plan mode (no mode re-introduces folder tools)', () => {
    const registry = getToolRegistry()
    const directPlanNames = registry
      .getToolDefinitionsForMode('plan', { directMode: true })
      .map((d) => d.function.name)
    for (const name of FOLDER_DEPENDENT_TOOLS) {
      expect(directPlanNames).not.toContain(name)
    }
    for (const name of REQUIRED_FOLDER_DEPENDENT_TOOLS) {
      expect(directPlanNames, `direct plan must NOT register ${name}`).not.toContain(name)
    }
    for (const name of REQUIRED_HOST_CAPABLE_TOOLS) {
      expect(directPlanNames, `direct plan must NOT register ${name}`).not.toContain(name)
    }
    // read-type non-folder tools stay visible in direct plan mode
    expect(directPlanNames).toContain('run_python')
  })

  it('omitting directMode preserves the full project behavior (zero drift)', () => {
    const registry = getToolRegistry()
    const names = registry.getToolDefinitionsForMode('act').map((d) => d.function.name)
    for (const name of FOLDER_DEPENDENT_TOOLS) {
      expect(names, `default must register ${name}`).toContain(name)
    }
    for (const name of REQUIRED_FOLDER_DEPENDENT_TOOLS) {
      expect(names, `default must register ${name}`).toContain(name)
    }
    for (const name of REQUIRED_HOST_CAPABLE_TOOLS) {
      expect(names, `default must register ${name}`).toContain(name)
    }
  })

  it('folder-dependent tools are classified read/write as before (filter does not touch plan gating)', () => {
    expect(getToolCategory('read')).toBe('read')
    expect(getToolCategory('write')).toBe('write')
    expect(getToolCategory('sync-to-opfs')).toBe('read')
  })

  it('execute() rejects folder tools when context.directMode is set (bypass-the-definitions guard)', async () => {
    const registry = getToolRegistry()
    const context = {
      directoryHandle: null,
      directMode: true,
    } as Parameters<typeof registry.execute>[2]

    for (const name of [...FOLDER_DEPENDENT_TOOLS, ...REQUIRED_HOST_CAPABLE_TOOLS]) {
      const raw = await registry.execute(name, {}, context)
      const parsed = JSON.parse(raw) as { error?: string }
      // Assert the SPECIFIC direct-mode authorization error — a generic
      // executor failure (bad args, missing context) must not pass here,
      // or a regression that removes the guard would go unnoticed.
      expect(parsed.error, name).toBe(
        `Tool "${name}" is not available in a standalone chat (no folder authorized).`
      )
    }

    // Non-folder tools keep executing normally in direct mode: exercise a
    // REGISTERED tool and assert its actual result, so an 'Unknown tool'
    // envelope cannot pass vacuously. ask_user_question is always registered;
    // with no UI handler wired it resolves through its documented fallback
    // (default answer 'yes', ok envelope).
    const raw = await registry.execute(
      'ask_user_question',
      { question: 'ping', type: 'single_choice', options: [{ label: 'a' }, { label: 'b' }] },
      context
    )
    const parsed = JSON.parse(raw) as { error?: unknown; ok?: boolean; data?: { answer?: string } }
    expect(parsed).not.toHaveProperty('error')
    expect(parsed.ok).toBe(true)
    expect(parsed.data?.answer).toBe('yes')

    // Omitting directMode preserves full project behavior (zero drift):
    // project tools must NOT hit the direct-mode guard AND must actually
    // reach their executor. Assert 'ls' exact deterministic envelope — in a
    // project context with no directoryHandle the executor (not the guard)
    // answers with the specific no_directory error; and assert a positive
    // success via ask_user_question (documented fallback, proven above).
    const projectContext = { directoryHandle: null } as unknown as Parameters<typeof registry.execute>[2]
    const projectRaw = await registry.execute('ls', {}, projectContext)
    expect(JSON.parse(projectRaw)).toEqual({
      ok: false,
      tool: 'ls',
      version: 2,
      error: { code: 'no_directory', message: 'No directory selected.', retryable: false },
    })

    const projectAskRaw = await registry.execute(
      'ask_user_question',
      { question: 'ping', type: 'single_choice', options: [{ label: 'a' }, { label: 'b' }] },
      projectContext
    )
    const projectAsk = JSON.parse(projectAskRaw) as { error?: unknown; ok?: boolean }
    expect(projectAsk).not.toHaveProperty('error')
    expect(projectAsk.ok).toBe(true)
  })

  it('executeNoRetry() applies the same direct-mode authorization as execute()', async () => {
    const registry = getToolRegistry()
    const context = {
      directoryHandle: null,
      directMode: true,
    } as Parameters<typeof registry.executeNoRetry>[2]

    // Folder-dependent tools are rejected on the no-retry path too.
    const folderRaw = await registry.executeNoRetry('read', {}, context)
    expect(JSON.parse(folderRaw) as { error?: string }).toHaveProperty(
      'error',
      'Tool "read" is not available in a standalone chat (no folder authorized).'
    )

    // Host-capable tools are rejected on the no-retry path too.
    const hostRaw = await registry.executeNoRetry('exec', { command: 'echo hi' }, context)
    expect(JSON.parse(hostRaw) as { error?: string }).toHaveProperty(
      'error',
      'Tool "exec" is not available in a standalone chat (no folder authorized).'
    )

    // A registered non-folder tool still executes on the no-retry path.
    const raw = await registry.executeNoRetry(
      'ask_user_question',
      { question: 'ping', type: 'single_choice', options: [{ label: 'a' }, { label: 'b' }] },
      context
    )
    const parsed = JSON.parse(raw) as { error?: unknown; ok?: boolean; data?: { answer?: string } }
    expect(parsed).not.toHaveProperty('error')
    expect(parsed.ok).toBe(true)
    expect(parsed.data?.answer).toBe('yes')
  })

  // Project-bound tools (delegate_to, dev-only db_query) reach the HOST
  // PROJECT's data without needing a folder authorization: delegate_to
  // switches into project-agent personas, db_query runs SQL over the host
  // project's OPFS SQLite. A standalone chat has no project, so both are
  // excluded in direct mode — at definition, execution, and no-retry layers.
  it('project-bound tools (delegate_to, db_query) are excluded from direct mode', () => {
    expect(isToolAllowedInDirectMode('delegate_to')).toBe(false)
    expect(isToolAllowedInDirectMode('db_query')).toBe(false)

    const registry = getToolRegistry()
    const names = (direct: boolean) =>
      registry.getToolDefinitionsForMode('act', { directMode: direct }).map((d) => d.function.name)

    // delegate_to is registered in project contexts (db_query only in dev
    // builds, so it may legitimately be absent from the registry here).
    expect(names(false)).toContain('delegate_to')
    expect(names(true)).not.toContain('delegate_to')
    expect(names(true)).not.toContain('db_query')
  })

  it('project-bound tools are rejected by execute()/executeNoRetry() in direct mode', async () => {
    const registry = getToolRegistry()
    // db_query registers only in dev builds; register it here explicitly so
    // the guard under test (not an 'Unknown tool' miss) produces the error.
    if (!registry.has('db_query')) {
      const { dbQueryTool } = await import('@/agent/tools/db-query.tool')
      registry.register(dbQueryTool.definition, dbQueryTool.executor)
    }
    const directContext = {
      directoryHandle: null,
      directMode: true,
    } as Parameters<typeof registry.execute>[2]

    for (const name of ['delegate_to', 'db_query'] as const) {
      const raw = await registry.execute(name, {}, directContext)
      expect(JSON.parse(raw) as { error?: string }, name).toHaveProperty(
        'error',
        `Tool "${name}" is not available in a standalone chat (no folder authorized).`
      )
      const noRetryRaw = await registry.executeNoRetry(name, {}, directContext)
      expect(JSON.parse(noRetryRaw) as { error?: string }, name).toHaveProperty(
        'error',
        `Tool "${name}" is not available in a standalone chat (no folder authorized).`
      )
    }

    // Zero drift: without directMode the tools still reach their executors
    // (delegate_to with an unknown target returns its specific INVALID_INPUT /
    // unknown-target error envelope — NOT the direct-mode guard message).
    const projectContext = {
      directoryHandle: null,
    } as unknown as Parameters<typeof registry.executeNoRetry>[2]
    const raw = await registry.executeNoRetry(
      'delegate_to',
      { target_agent_id: '', task: 'x' },
      projectContext
    )
    const parsed = JSON.parse(raw) as { error?: { code?: string } }
    expect(parsed.error?.code).not.toBeUndefined()
  })
})
