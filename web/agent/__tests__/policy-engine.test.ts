import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useToolAuthStore } from '@/store/tool-auth.store'
import { useSessionAllowStore } from '@/store/session-allow.store'
import { useYoloModeStore } from '@/store/yolo-mode.store'
import { useTrustedSourceStore } from '@/store/trusted-source.store'
import { authorize, getToolPolicy } from '../policy-engine'

describe('tool-auth.store (unified FIFO queue)', () => {
  afterEach(() => {
    useToolAuthStore.getState().clear()
  })

  it('resolves { approved, remembered } when the user picks "always allow"', async () => {
    const request = useToolAuthStore.getState().request({
      toolName: 'sync-to-disk',
      description: 'Write 3 files to disk',
      memoryKey: 'sync-to-disk',
      conversationId: 'conv-1',
    })
    useToolAuthStore.getState().approve(true)
    await expect(request).resolves.toEqual({ approved: true, remembered: true })
  })

  it('queues concurrent requests FIFO and only the head is visible', async () => {
    const first = useToolAuthStore.getState().request({ toolName: 'a', description: 'A' })
    const second = useToolAuthStore.getState().request({ toolName: 'b', description: 'B' })

    expect(useToolAuthStore.getState().pending?.toolName).toBe('a')
    expect(useToolAuthStore.getState().queue).toHaveLength(2)

    useToolAuthStore.getState().approve()
    await expect(first).resolves.toEqual({ approved: true, remembered: false })
    expect(useToolAuthStore.getState().pending?.toolName).toBe('b')

    useToolAuthStore.getState().deny()
    await expect(second).resolves.toEqual({ approved: false, remembered: false })
  })

  it('resolves an aborted request as deny without disturbing the queue head', async () => {
    const first = useToolAuthStore.getState().request({ toolName: 'a', description: 'A' })
    const controller = new AbortController()
    const second = useToolAuthStore
      .getState()
      .request({ toolName: 'b', description: 'B', signal: controller.signal })

    controller.abort()
    await expect(second).resolves.toEqual({ approved: false, remembered: false })
    expect(useToolAuthStore.getState().pending?.toolName).toBe('a')
    expect(useToolAuthStore.getState().queue).toHaveLength(1)

    useToolAuthStore.getState().approve()
    await expect(first).resolves.toEqual({ approved: true, remembered: false })
  })

  it('denyAll denies pending and queued requests at once', async () => {
    const first = useToolAuthStore.getState().request({ toolName: 'a', description: 'A' })
    const second = useToolAuthStore.getState().request({ toolName: 'b', description: 'B' })

    useToolAuthStore.getState().denyAll()

    await expect(first).resolves.toEqual({ approved: false, remembered: false })
    await expect(second).resolves.toEqual({ approved: false, remembered: false })
    expect(useToolAuthStore.getState().queue).toEqual([])
  })
})

describe('session-allow.store (conversation-scoped memory)', () => {
  afterEach(() => {
    useSessionAllowStore.getState().clearAll()
  })

  it('scopes grants per conversation and never matches without one', () => {
    const store = useSessionAllowStore.getState()
    expect(store.has(null, 'sync-to-disk')).toBe(false)
    expect(store.has(undefined, 'sync-to-disk')).toBe(false)

    store.add('conv-1', 'sync-to-disk')
    expect(store.has('conv-1', 'sync-to-disk')).toBe(true)
    expect(store.has('conv-2', 'sync-to-disk')).toBe(false)
  })

  it('add() without a conversation id is a no-op', () => {
    useSessionAllowStore.getState().add(null, 'sync-to-disk')
    expect(useSessionAllowStore.getState().allowed.size).toBe(0)
  })

  it('clearFor drops one conversation; clearAll drops everything', () => {
    const store = useSessionAllowStore.getState()
    store.add('conv-1', 'k1')
    store.add('conv-2', 'k2')

    useSessionAllowStore.getState().clearFor('conv-1')
    expect(useSessionAllowStore.getState().has('conv-1', 'k1')).toBe(false)
    expect(useSessionAllowStore.getState().has('conv-2', 'k2')).toBe(true)

    useSessionAllowStore.getState().clearAll()
    expect(useSessionAllowStore.getState().allowed.size).toBe(0)
  })
})

describe('policy-engine authorize()', () => {
  beforeEach(() => {
    useSessionAllowStore.getState().clearAll()
    useToolAuthStore.getState().clear()
  })
  afterEach(() => {
    useSessionAllowStore.getState().clearAll()
    useToolAuthStore.getState().clear()
  })

  it('forbidden tools are denied and cannot be overridden by yolo or memory', async () => {
    useSessionAllowStore.getState().add('conv-1', 'switch_agent_mode')
    const result = await authorize({
      toolName: 'switch_agent_mode',
      conversationId: 'conv-1',
    })
    expect(result).toEqual({
      decision: 'deny',
      reason: expect.stringContaining('forbidden'),
    })
  })

  it('auto tools pass without user interaction', async () => {
    const result = await authorize({ toolName: 'read', args: { path: 'a.md' } })
    expect(result).toEqual({ decision: 'allow', via: 'auto' })
    expect(useToolAuthStore.getState().queue).toHaveLength(0)
  })

  it('session memory short-circuits the prompt', async () => {
    useSessionAllowStore.getState().add('conv-1', 'page-action-write')
    const result = await authorize({
      toolName: 'page_click',
      args: {},
      conversationId: 'conv-1',
    })
    expect(result).toEqual({ decision: 'allow', via: 'session-memory' })
  })

  it('memory miss queues a prompt modal; remember=true records the grant', async () => {
    const pending = authorize({
      toolName: 'page_click',
      args: {},
      conversationId: 'conv-1',
    })
    expect(useToolAuthStore.getState().pending?.memoryKey).toBe('page-action-write')

    useToolAuthStore.getState().approve(true)
    expect(await pending).toEqual({ decision: 'allow', via: 'auto' })
    expect(useSessionAllowStore.getState().has('conv-1', 'page-action-write')).toBe(true)

    // Next call short-circuits.
    const second = await authorize({
      toolName: 'page_fill',
      args: {},
      conversationId: 'conv-1',
    })
    expect(second).toEqual({ decision: 'allow', via: 'session-memory' })
  })

  it('memory grants stay scoped to the conversation that made them', async () => {
    const pending = authorize({
      toolName: 'page_click',
      args: {},
      conversationId: 'conv-1',
    })
    useToolAuthStore.getState().approve(true)
    expect(await pending).toEqual({ decision: 'allow', via: 'auto' })

    // conv-2 has no grant → a second modal is queued (no cross-conversation
    // fallback). Decide it, then assert the denial.
    const other = authorize({
      toolName: 'page_click',
      args: {},
      conversationId: 'conv-2',
    })
    expect(useToolAuthStore.getState().queue).toHaveLength(1)
    useToolAuthStore.getState().deny()
    expect(await other).toEqual({
      decision: 'deny',
      reason: expect.stringContaining('denied'),
    })
  })

  it('memoryKey null tools (snapshot_restore) can never be remembered', async () => {
    const pending = authorize({ toolName: 'snapshot_restore', args: {} })
    const queued = useToolAuthStore.getState().pending
    expect(queued?.memoryKey).toBeNull()

    // "Always allow" click is impossible in UI, but even if forced:
    queued?.resolve(true, true)
    expect(await pending).toEqual({ decision: 'allow', via: 'auto' })
    expect(useSessionAllowStore.getState().allowed.size).toBe(0)
  })

  it('passes toolArgs and fileChanges through to the queued modal request', async () => {
    const pendingPromise = authorize({
      toolName: 'sync-to-disk',
      args: { count: 2, deletes: ['a.txt'] },
      toolArgs: { paths: ['a.txt', 'b.txt'] },
      fileChanges: [
        { type: 'add', path: 'a.txt' },
        { type: 'delete', path: 'b.txt' },
      ],
      conversationId: 'conv-1',
    })
    const pending = useToolAuthStore.getState().pending
    expect(pending?.toolArgs).toEqual({ paths: ['a.txt', 'b.txt'] })
    expect(pending?.fileChanges).toEqual([
      { type: 'add', path: 'a.txt' },
      { type: 'delete', path: 'b.txt' },
    ])
    useToolAuthStore.getState().deny()
    expect(await pendingPromise).toEqual({ decision: 'deny', reason: expect.any(String) })
  })

  it('denial returns a reason the LLM can act on', async () => {
    const pending = authorize({ toolName: 'snapshot_restore', args: {} })
    useToolAuthStore.getState().deny()
    const result = await pending
    expect(result.decision).toBe('deny')
    if (result.decision === 'deny') {
      expect(result.reason).toContain('snapshot_restore')
    }
  })
})

describe('policy table', () => {
  it('classifies page-action writes as prompt with a coarse memory key', () => {
    const policy = getToolPolicy('page_fill')
    expect(policy.level).toBe('prompt')
    expect(policy.memoryKey?.({})).toBe('page-action-write')
  })

  it('snapshot_restore prompts without memory', () => {
    const policy = getToolPolicy('snapshot_restore')
    expect(policy.level).toBe('prompt')
    expect(policy.memoryKey?.({})).toBeNull()
  })

  it('call_tool prompts with a per server+tool memory key', () => {
    const policy = getToolPolicy('call_tool')
    expect(policy.level).toBe('prompt')
    expect(
      policy.memoryKey?.({ full_tool_name: 'github:create_issue' }),
    ).toBe('call_tool::github:create_issue')
    // unusable name → no safe key, ask every time
    expect(policy.memoryKey?.({})).toBeNull()
    expect(policy.memoryKey?.({ full_tool_name: '  ' })).toBeNull()
    // i18n descriptor with the tool name param
    expect(policy.describe?.({ full_tool_name: 'github:create_issue' })).toEqual({
      key: 'describeCallTool',
      params: { name: 'github:create_issue' },
    })
  })

  it('untrusted-annotated call_tool targets get a normal memory key (annotation is return-channel only)', () => {
    const policy = getToolPolicy('call_tool')
    expect(
      policy.memoryKey?.({ full_tool_name: 'page_tool', untrusted: true }),
    ).toBe('call_tool::page_tool')
  })

  it('switch_agent_mode is forbidden', () => {
    expect(getToolPolicy('switch_agent_mode').level).toBe('forbidden')
  })

  it('sync-to-disk prompts with a fixed memory key and file-count description', () => {
    const policy = getToolPolicy('sync-to-disk')
    expect(policy.level).toBe('prompt')
    // Regular write flush → plain memory key.
    expect(policy.memoryKey?.({ count: 3 })).toBe('sync-to-disk')
    // describe returns an i18n descriptor (rendered locale-aware by the modal)
    expect(policy.describe?.({ count: 3 })).toEqual({
      key: 'describeSyncToDisk',
      params: { count: 3 },
    })
    expect(policy.describe?.({})).toEqual({ key: 'describeSyncToDiskGeneric' })
  })

  it('deletion-bearing sync-to-disk gets its own description and memory key', () => {
    const policy = getToolPolicy('sync-to-disk')
    // Deletion flush → deletion-specific key and a modal body listing paths.
    expect(policy.memoryKey?.({ count: 1, deletes: ['a.ts', 'b.ts'] })).toBe(
      'sync-to-disk:delete',
    )
    expect(policy.describe?.({ count: 1, deletes: ['a.ts', 'b.ts'] })).toEqual({
      key: 'describeSyncToDiskDelete',
      params: { count: 2, paths: 'a.ts, b.ts' },
    })
    // More than the display limit → overflow suffix instead of full list.
    const many = Array.from({ length: 10 }, (_, i) => `f${i}.ts`)
    const desc = policy.describe?.({ count: 1, deletes: many })
    const params = desc?.params as { count: number; paths: string } | undefined
    expect(params?.paths).toContain('…(+2 more)')
    expect(params?.paths).not.toContain('f8.ts')
  })

  it('sync-to-opfs (renamed from sync) stays auto', () => {
    expect(getToolPolicy('sync-to-opfs').level).toBe('auto')
  })

  it('unregistered tools default to auto (PR-1 behavior freeze)', () => {
    expect(getToolPolicy('totally_unknown_tool').level).toBe('auto')
  })
})

describe('policy-engine: yolo generalization (PR-4)', () => {
  beforeEach(() => {
    useYoloModeStore.getState().clearAll()
    useSessionAllowStore.getState().clearAll()
    useToolAuthStore.getState().clear()
  })
  afterEach(() => {
    useYoloModeStore.getState().clearAll()
    useSessionAllowStore.getState().clearAll()
    useToolAuthStore.getState().clear()
  })

  it('yolo auto-allows the disk flush (prompt level) in its conversation', async () => {
    useYoloModeStore.getState().setYolo('conv-1', true)
    const result = await authorize({
      toolName: 'sync-to-disk',
      args: { count: 2 },
      conversationId: 'conv-1',
    })
    expect(result).toEqual({ decision: 'allow', via: 'yolo' })
    expect(useToolAuthStore.getState().queue).toHaveLength(0)
  })

  it('a remembered WRITE flush grant does not cover a DELETION-bearing flush', async () => {
    useSessionAllowStore.getState().add('conv-1', 'sync-to-disk')

    const pending = authorize({
      toolName: 'sync-to-disk',
      args: { count: 1, deletes: ['gone.ts'] },
      conversationId: 'conv-1',
    })
    // The deletion flush gets its own modal — the write grant never crosses.
    expect(useToolAuthStore.getState().queue).toHaveLength(1)
    useToolAuthStore.getState().approve()
    expect(await pending).toEqual({ decision: 'allow', via: 'auto' })
  })

  it('yolo does NOT leak into other conversations', async () => {
    useYoloModeStore.getState().setYolo('conv-1', true)
    const pending = authorize({
      toolName: 'sync-to-disk',
      args: { count: 2 },
      conversationId: 'conv-2',
    })
    // conv-2 gets a modal — the grant never crosses conversations.
    expect(useToolAuthStore.getState().queue).toHaveLength(1)
    useToolAuthStore.getState().deny()
    expect((await pending).decision).toBe('deny')
  })

  it('yolo never covers forbidden tools', async () => {
    useYoloModeStore.getState().setYolo('conv-1', true)
    const result = await authorize({
      toolName: 'switch_agent_mode',
      conversationId: 'conv-1',
    })
    expect(result.decision).toBe('deny')
  })

  it('yolo covers external calls (call_tool) in its conversation', async () => {
    useYoloModeStore.getState().setYolo('conv-1', true)
    const result = await authorize({
      toolName: 'call_tool',
      args: { full_tool_name: 'github:create_issue' },
      conversationId: 'conv-1',
      mode: 'act',
    })
    expect(result).toEqual({ decision: 'allow', via: 'yolo' })
  })
})

describe('policy-engine: manual-apply policy (disk flush stays interactive)', () => {
  beforeEach(() => {
    useYoloModeStore.getState().clearAll()
    useSessionAllowStore.getState().clearAll()
    useToolAuthStore.getState().clear()
  })
  afterEach(() => {
    useYoloModeStore.getState().clearAll()
    useSessionAllowStore.getState().clearAll()
    useToolAuthStore.getState().clear()
  })

  it('yolo does NOT skip the disk flush while manual apply is on', async () => {
    useYoloModeStore.getState().setYolo('conv-1', true)

    const pending = authorize({
      toolName: 'sync-to-disk',
      args: { count: 2 },
      conversationId: 'conv-1',
      manualApply: true,
    })
    // The modal is queued despite yolo — the user still decides when changes
    // reach the real disk.
    expect(useToolAuthStore.getState().queue).toHaveLength(1)
    expect(useToolAuthStore.getState().pending?.toolName).toBe('sync-to-disk')

    useToolAuthStore.getState().approve()
    expect(await pending).toEqual({ decision: 'allow', via: 'auto' })
  })

  it('manual apply ignores a standing "always allow" grant', async () => {
    useSessionAllowStore.getState().add('conv-1', 'sync-to-disk')

    const pending = authorize({
      toolName: 'sync-to-disk',
      args: { count: 1 },
      conversationId: 'conv-1',
      manualApply: true,
    })
    expect(useToolAuthStore.getState().queue).toHaveLength(1)
    useToolAuthStore.getState().approve()
    expect(await pending).toEqual({ decision: 'allow', via: 'auto' })
  })

  it('manual apply never offers or stores "always allow"', async () => {
    const pending = authorize({
      toolName: 'sync-to-disk',
      args: { count: 1 },
      conversationId: 'conv-1',
      manualApply: true,
    })
    // No "always allow" button (memoryKey stripped)…
    expect(useToolAuthStore.getState().pending?.memoryKey).toBeNull()
    // …and a remembered verdict cannot sneak a grant into the session store.
    useToolAuthStore.getState().approve(true)
    expect(await pending).toEqual({ decision: 'allow', via: 'auto' })
    expect(useSessionAllowStore.getState().has('conv-1', 'sync-to-disk')).toBe(false)
  })

  it('manual apply only gates disk-writing tools, not other prompt-level tools', async () => {
    useYoloModeStore.getState().setYolo('conv-1', true)
    const result = await authorize({
      toolName: 'call_tool',
      args: { full_tool_name: 'github:create_issue' },
      conversationId: 'conv-1',
      mode: 'act',
      manualApply: true,
    })
    expect(result).toEqual({ decision: 'allow', via: 'yolo' })
  })

  it('omitting manualApply keeps the yolo shortcut (auto-apply workspaces)', async () => {
    useYoloModeStore.getState().setYolo('conv-1', true)
    const result = await authorize({
      toolName: 'sync-to-disk',
      args: { count: 2 },
      conversationId: 'conv-1',
    })
    expect(result).toEqual({ decision: 'allow', via: 'yolo' })
  })
})

describe('policy-engine: plan mode (call_tool double gating)', () => {
  beforeEach(() => {
    useSessionAllowStore.getState().clearAll()
    useToolAuthStore.getState().clear()
  })
  afterEach(() => {
    useSessionAllowStore.getState().clearAll()
    useToolAuthStore.getState().clear()
  })

  it('a remembered call_tool grant does NOT short-circuit in plan mode', async () => {
    // Act-mode approval remembered earlier in the same conversation.
    useSessionAllowStore.getState().add('conv-1', 'call_tool::jira:get_ticket')

    const pending = authorize({
      toolName: 'call_tool',
      args: { full_tool_name: 'jira:get_ticket' },
      conversationId: 'conv-1',
      mode: 'plan',
    })
    // Queues a modal (no short-circuit)…
    expect(useToolAuthStore.getState().queue).toHaveLength(1)
    // …and without the "always allow" option (memoryKey stripped).
    expect(useToolAuthStore.getState().pending?.memoryKey).toBeNull()
    useToolAuthStore.getState().approve()
    expect(await pending).toEqual({ decision: 'allow', via: 'auto' })
    // Single-call approval must NOT write memory.
    expect(
      useSessionAllowStore.getState().has('conv-1', 'call_tool::jira:get_ticket'),
    ).toBe(true) // pre-existing grant untouched
  })

  it('plan-mode deny returns a reason the LLM can act on', async () => {
    const pending = authorize({
      toolName: 'call_tool',
      args: { full_tool_name: 'jira:get_ticket' },
      conversationId: 'conv-1',
      mode: 'plan',
    })
    useToolAuthStore.getState().deny()
    const result = await pending
    expect(result.decision).toBe('deny')
  })

  it('auto tools are unaffected by plan mode (memory check is a no-op for them)', async () => {
    const result = await authorize({
      toolName: 'read',
      args: { path: 'a.md' },
      mode: 'plan',
    })
    expect(result).toEqual({ decision: 'allow', via: 'auto' })
  })

  it('call_tool still prompts in act mode and CAN be remembered', async () => {
    const pending = authorize({
      toolName: 'call_tool',
      args: { full_tool_name: 'github:create_issue' },
      conversationId: 'conv-1',
      mode: 'act',
    })
    expect(useToolAuthStore.getState().pending?.memoryKey).toBe(
      'call_tool::github:create_issue',
    )
    useToolAuthStore.getState().approve(true)
    expect(await pending).toEqual({ decision: 'allow', via: 'auto' })
    expect(
      useSessionAllowStore.getState().has('conv-1', 'call_tool::github:create_issue'),
    ).toBe(true)

    // Later call in the same conversation short-circuits (act mode).
    const second = await authorize({
      toolName: 'call_tool',
      args: { full_tool_name: 'github:create_issue' },
      conversationId: 'conv-1',
      mode: 'act',
    })
    expect(second).toEqual({ decision: 'allow', via: 'session-memory' })
  })
})

describe('policy-engine: trusted source (global default-trust switch)', () => {
  beforeEach(() => {
    useTrustedSourceStore.getState().setDefaultTrustExternal(true)
    useSessionAllowStore.getState().clearAll()
    useToolAuthStore.getState().clear()
  })
  afterEach(() => {
    useTrustedSourceStore.getState().setDefaultTrustExternal(true)
    useSessionAllowStore.getState().clearAll()
    useToolAuthStore.getState().clear()
  })

  const callToolArgs = { full_tool_name: 'workspace.jianguoyun_com:message_send_text' }

  it('default ON: external calls auto-allow in act mode without a modal', async () => {
    const result = await authorize({
      toolName: 'call_tool',
      args: callToolArgs,
      trustedSource: { kind: 'webmcp', sourceId: 'workspace.jianguoyun.com' },
      conversationId: 'conv-1',
      mode: 'act',
    })
    expect(result).toEqual({ decision: 'allow', via: 'trusted-source' })
    expect(useToolAuthStore.getState().queue).toHaveLength(0)
  })

  it('default ON: external calls auto-allow in PLAN mode too (unlike session memory)', async () => {
    const result = await authorize({
      toolName: 'call_tool',
      args: callToolArgs,
      trustedSource: { kind: 'webmcp', sourceId: 'workspace.jianguoyun.com' },
      conversationId: 'conv-1',
      mode: 'plan',
    })
    expect(result).toEqual({ decision: 'allow', via: 'trusted-source' })
    expect(useToolAuthStore.getState().queue).toHaveLength(0)
  })

  it('switch OFF: external calls prompt again', async () => {
    useTrustedSourceStore.getState().setDefaultTrustExternal(false)

    const pending = authorize({
      toolName: 'call_tool',
      args: callToolArgs,
      trustedSource: { kind: 'webmcp', sourceId: 'workspace.jianguoyun.com' },
      conversationId: 'conv-1',
      mode: 'act',
    })
    expect(useToolAuthStore.getState().queue).toHaveLength(1)
    useToolAuthStore.getState().deny()
    expect((await pending).decision).toBe('deny')
  })

  it('untrusted-annotated tools DO qualify with default trust ON (annotation is return-channel only)', async () => {
    const result = await authorize({
      toolName: 'call_tool',
      args: { ...callToolArgs, untrusted: true },
      trustedSource: { kind: 'webmcp', sourceId: 'workspace.jianguoyun.com' },
      conversationId: 'conv-1',
      mode: 'act',
    })
    // The annotation gates the RETURN value (output isolation), not the call.
    expect(result).toEqual({ decision: 'allow', via: 'trusted-source' })
    expect(useToolAuthStore.getState().queue).toHaveLength(0)
  })

  it('missing trustedSource falls through to the modal (no behavior change for other tools)', async () => {
    const pending = authorize({
      toolName: 'call_tool',
      args: callToolArgs,
      conversationId: 'conv-1',
      mode: 'act',
    })
    expect(useToolAuthStore.getState().queue).toHaveLength(1)
    useToolAuthStore.getState().deny()
    expect((await pending).decision).toBe('deny')
  })
})
