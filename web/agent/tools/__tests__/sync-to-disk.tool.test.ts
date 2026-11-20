import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../tool-types'
import { syncToDiskExecutor } from '../sync-to-disk.tool'
import { useToolAuthStore } from '@/store/tool-auth.store'
import { useSessionAllowStore } from '@/store/session-allow.store'
import { useYoloModeStore } from '@/store/yolo-mode.store'

/**
 * sync-to-disk is the authorized disk-flush entry point. These tests pin the
 * guarantees from redesign doc §3.6 (as amended by the "authorized deletions"
 * follow-up):
 *   1. delete-type changes ARE applied on this authorized channel, and the
 *      flush that contains them uses the deletion-specific memory key
 *   2. forceOverwrite is never passed through (conflicts → skipped, reported)
 *   3. every call passes the policy engine (prompt level)
 *   4. a regular-write "always allow" grant never covers deletions
 */

vi.mock('@/opfs', () => ({
  getWorkspaceManager: () => ({
    getWorkspace: vi.fn(async () => mockRuntime),
  }),
}))

/**
 * Run-completion policy stub. Default OFF (auto-apply) so the shortcuts this
 * file pins (yolo / "always allow") stay reachable; the manual-apply block
 * flips it ON to prove the flush must then stay interactive.
 */
const manualApplyState = vi.hoisted(() => ({ manual: false }))
vi.mock('@/store/workspace-preferences.store', () => ({
  isManualApplyPolicy: () => manualApplyState.manual,
}))

const syncToDiskMock = vi.fn()
const createSnapshotMock = vi.fn()
const markSyncedMock = vi.fn()

const mockRuntime = {
  getPendingChanges: vi.fn(() => [] as Array<{ path: string; type: string }>),
  createApprovedSnapshotForPaths: createSnapshotMock,
  syncToDisk: syncToDiskMock,
  markSnapshotAsSynced: markSyncedMock,
} as never as {
  getPendingChanges: ReturnType<typeof vi.fn>
  createApprovedSnapshotForPaths: ReturnType<typeof vi.fn>
  syncToDisk: ReturnType<typeof vi.fn>
  markSnapshotAsSynced: ReturnType<typeof vi.fn>
}

const context = {
  workspaceId: 'conv-1',
  abortSignal: undefined,
} as unknown as ToolContext

describe('sync-to-disk tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    manualApplyState.manual = false
    useToolAuthStore.getState().clear()
    useSessionAllowStore.getState().clearAll()
    useYoloModeStore.getState().clearAll()
    createSnapshotMock.mockResolvedValue({ snapshotId: 'snap_1' })
    markSyncedMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    useToolAuthStore.getState().clear()
    useSessionAllowStore.getState().clearAll()
    useYoloModeStore.getState().clearAll()
  })

  it('queues an authorization modal BEFORE touching the disk (prompt level)', async () => {
    mockRuntime.getPendingChanges.mockReturnValue([
      { path: 'a.ts', type: 'modify' },
    ])
    syncToDiskMock.mockResolvedValue({ success: 1, failed: 0, conflicts: [] })

    const pending = syncToDiskExecutor({ paths: ['a.ts'] }, context)
    // Flush all pending microtasks (dynamic import + manager.getWorkspace)
    await new Promise((r) => setTimeout(r, 0))
    // then assert the modal is queued before any disk write.
    // first), then assert the modal is queued before any disk write.
    expect(useToolAuthStore.getState().pending?.toolName).toBe('sync-to-disk')
    expect(useToolAuthStore.getState().pending?.memoryKey).toBe('sync-to-disk')
    expect(syncToDiskMock).not.toHaveBeenCalled()

    useToolAuthStore.getState().approve()
    const result = JSON.parse((await pending) as string) as { tool: string; data?: { synced: string[] } }
    expect(result.tool).toBe('sync-to-disk')
    expect(result.data?.synced).toEqual(['a.ts'])
  })

  it('"always allow" persists the grant and the next call short-circuits', async () => {
    mockRuntime.getPendingChanges.mockReturnValue([
      { path: 'a.ts', type: 'modify' },
    ])
    syncToDiskMock.mockResolvedValue({ success: 1, failed: 0, conflicts: [] })

    const first = syncToDiskExecutor({ paths: ['a.ts'] }, context)
    await new Promise((r) => setTimeout(r, 0))
    useToolAuthStore.getState().approve(true)
    await first
    expect(useSessionAllowStore.getState().has('conv-1', 'sync-to-disk')).toBe(true)

    // Second call: no modal queued (memory short-circuit), disk written.
    const second = (await syncToDiskExecutor({ paths: ['a.ts'] }, context)) as string
    expect(useToolAuthStore.getState().queue).toHaveLength(0)
    const parsed = JSON.parse(second) as { data?: { synced_count: number } }
    expect(parsed.data?.synced_count).toBe(1)
  })

  it('applies delete-type changes on the authorized channel and reports them', async () => {
    mockRuntime.getPendingChanges.mockReturnValue([
      { path: 'keep.ts', type: 'modify' },
      { path: 'gone.ts', type: 'delete' },
    ])
    syncToDiskMock.mockResolvedValue({ success: 2, failed: 0, conflicts: [] })

    const pending = syncToDiskExecutor({}, context)
    await new Promise((r) => setTimeout(r, 0))
    // Deletion-bearing flush uses the deletion-specific memory key.
    expect(useToolAuthStore.getState().pending?.memoryKey).toBe('sync-to-disk:delete')
    useToolAuthStore.getState().approve()
    const parsed = JSON.parse((await pending) as string) as {
      data?: {
        synced: string[]
        excluded_deletions: string[]
        applied_deletions: string[]
      }
      hint?: string
    }

    // The delete reached the disk pipeline alongside the write.
    expect(syncToDiskMock).toHaveBeenCalledWith(null, ['keep.ts', 'gone.ts'], false)
    expect(parsed.data?.synced).toEqual(['keep.ts', 'gone.ts'])
    expect(parsed.data?.applied_deletions).toEqual(['gone.ts'])
    expect(parsed.data?.excluded_deletions).toEqual([])
    const metaHint = String((parsed as { meta?: { hint?: string } }).meta?.hint ?? '')
    expect(metaHint).toContain('deletion')
    expect(metaHint).toContain('gone.ts')
  })

  it('a write-only "always allow" grant does NOT cover a deletion-bearing flush', async () => {
    // First flush: writes only → remembered under the plain key.
    mockRuntime.getPendingChanges.mockReturnValue([
      { path: 'a.ts', type: 'modify' },
    ])
    syncToDiskMock.mockResolvedValue({ success: 1, failed: 0, conflicts: [] })
    const first = syncToDiskExecutor({ paths: ['a.ts'] }, context)
    await new Promise((r) => setTimeout(r, 0))
    useToolAuthStore.getState().approve(true)
    await first
    expect(useSessionAllowStore.getState().has('conv-1', 'sync-to-disk')).toBe(true)

    // Second flush: now includes a deletion → NEW modal (different memory
    // key); the write grant must not silently cover file removals.
    mockRuntime.getPendingChanges.mockReturnValue([
      { path: 'a.ts', type: 'modify' },
      { path: 'gone.ts', type: 'delete' },
    ])
    const second = syncToDiskExecutor({}, context)
    await new Promise((r) => setTimeout(r, 0))
    expect(useToolAuthStore.getState().pending?.memoryKey).toBe('sync-to-disk:delete')
    useToolAuthStore.getState().approve(true)
    await second
    expect(useSessionAllowStore.getState().has('conv-1', 'sync-to-disk:delete')).toBe(true)
  })

  it('a deletion-only flush authorizes with the deletion description', async () => {
    mockRuntime.getPendingChanges.mockReturnValue([
      { path: 'gone.ts', type: 'delete' },
    ])
    syncToDiskMock.mockResolvedValue({ success: 1, failed: 0, conflicts: [] })

    const pending = syncToDiskExecutor({}, context)
    await new Promise((r) => setTimeout(r, 0))
    expect(useToolAuthStore.getState().pending?.toolName).toBe('sync-to-disk')
    expect(useToolAuthStore.getState().pending?.description).toEqual({
      key: 'describeSyncToDiskDelete',
      params: { count: 1, paths: 'gone.ts' },
    })
    useToolAuthStore.getState().approve()
    const parsed = JSON.parse((await pending) as string) as {
      data?: { synced: string[]; applied_deletions: string[] }
    }
    expect(parsed.data?.synced).toEqual(['gone.ts'])
    expect(parsed.data?.applied_deletions).toEqual(['gone.ts'])
  })

  it('forces forceOverwrite=false and reports per-file conflicts as skipped', async () => {
    mockRuntime.getPendingChanges.mockReturnValue([
      { path: 'clean.ts', type: 'create' },
      { path: 'hot.ts', type: 'modify' },
    ])
    syncToDiskMock.mockResolvedValue({
      success: 1,
      failed: 0,
      conflicts: [{ path: 'hot.ts' }],
    })

    const pending = syncToDiskExecutor({}, context)
    await new Promise((r) => setTimeout(r, 0))
    useToolAuthStore.getState().approve()
    const parsed = JSON.parse((await pending) as string) as {
      data?: { synced: string[]; skipped_conflicts: string[] }
      hint?: string
    }

    expect(syncToDiskMock).toHaveBeenCalledWith(null, expect.anything(), false)
    expect(parsed.data?.synced).toEqual(['clean.ts'])
    expect(parsed.data?.skipped_conflicts).toEqual(['hot.ts'])
    const metaHint = String((parsed as { meta?: { hint?: string } }).meta?.hint ?? '')
    expect(metaHint).toContain('skipped')
  })

  it('reports no-op clearly when nothing is pending', async () => {
    mockRuntime.getPendingChanges.mockReturnValue([])
    const parsed = JSON.parse(
      (await syncToDiskExecutor({}, context)) as string,
    ) as { data?: { message?: string } }
    expect(parsed.data?.message).toContain('No pending changes')
    expect(syncToDiskMock).not.toHaveBeenCalled()
    expect(createSnapshotMock).not.toHaveBeenCalled()
  })

  it('yolo mode auto-allows the disk flush when the workspace auto-applies', async () => {
    useYoloModeStore.getState().setYolo('conv-1', true)
    mockRuntime.getPendingChanges.mockReturnValue([
      { path: 'a.ts', type: 'modify' },
    ])
    syncToDiskMock.mockResolvedValue({ success: 1, failed: 0, conflicts: [] })

    // Resolves WITHOUT a modal decision — yolo short-circuits the prompt.
    const parsed = JSON.parse(
      (await syncToDiskExecutor({ paths: ['a.ts'] }, context)) as string,
    ) as { data?: { synced: string[] } }
    expect(parsed.data?.synced).toEqual(['a.ts'])
    expect(useToolAuthStore.getState().queue).toHaveLength(0)
  })

  describe('manual apply policy ("手动应用变更")', () => {
    beforeEach(() => {
      manualApplyState.manual = true
      mockRuntime.getPendingChanges.mockReturnValue([
        { path: 'a.ts', type: 'modify' },
      ])
      syncToDiskMock.mockResolvedValue({ success: 1, failed: 0, conflicts: [] })
    })

    it('yolo does NOT flush silently — the modal is still required', async () => {
      useYoloModeStore.getState().setYolo('conv-1', true)

      const pending = syncToDiskExecutor({ paths: ['a.ts'] }, context)
      await new Promise((r) => setTimeout(r, 0))
      expect(useToolAuthStore.getState().pending?.toolName).toBe('sync-to-disk')
      expect(syncToDiskMock).not.toHaveBeenCalled()

      useToolAuthStore.getState().approve()
      const parsed = JSON.parse((await pending) as string) as { data?: { synced: string[] } }
      expect(parsed.data?.synced).toEqual(['a.ts'])
    })

    it('a remembered approval can never store a grant under manual apply', async () => {
      const pending = syncToDiskExecutor({ paths: ['a.ts'] }, context)
      await new Promise((r) => setTimeout(r, 0))
      // No "always allow" button (a stored grant would defeat the policy)…
      expect(useToolAuthStore.getState().pending?.memoryKey).toBeNull()

      useToolAuthStore.getState().approve(true)
      await pending
      // …and the verdict cannot sneak one into the session store either.
      expect(useSessionAllowStore.getState().has('conv-1', 'sync-to-disk')).toBe(false)
    })

    it('a denial leaves the changes pending (no snapshot, no disk write)', async () => {
      const pending = syncToDiskExecutor({ paths: ['a.ts'] }, context)
      await new Promise((r) => setTimeout(r, 0))
      useToolAuthStore.getState().deny()
      const parsed = JSON.parse((await pending) as string) as { error?: { code?: string } }
      expect(parsed.error?.code).toBe('AUTH_DENIED_BY_USER')
      expect(syncToDiskMock).not.toHaveBeenCalled()
      expect(createSnapshotMock).not.toHaveBeenCalled()
    })
  })

  describe('snapshot summary (AI-provided title)', () => {
    beforeEach(() => {
      mockRuntime.getPendingChanges.mockReturnValue([
        { path: 'a.ts', type: 'modify' },
      ])
      syncToDiskMock.mockResolvedValue({ success: 1, failed: 0, conflicts: [] })
    })

    it('appends a provided summary to the mechanical title prefix', async () => {
      useYoloModeStore.getState().setYolo('conv-1', true)
      await syncToDiskExecutor(
        { paths: ['a.ts'], summary: 'fix homepage redirect' },
        context,
      )
      expect(createSnapshotMock).toHaveBeenCalledWith(
        ['a.ts'],
        'sync-to-disk (1 file): fix homepage redirect',
        null,
        null,
      )
    })

    it('keeps the bare mechanical title when summary is omitted', async () => {
      useYoloModeStore.getState().setYolo('conv-1', true)
      await syncToDiskExecutor({ paths: ['a.ts'] }, context)
      expect(createSnapshotMock).toHaveBeenCalledWith(
        ['a.ts'],
        'sync-to-disk (1 file)',
        null,
        null,
      )
    })

    it('degrades whitespace-only summaries to the bare prefix and clamps length', async () => {
      useYoloModeStore.getState().setYolo('conv-1', true)
      await syncToDiskExecutor({ paths: ['a.ts'], summary: '   ' }, context)
      expect(createSnapshotMock).toHaveBeenCalledWith(
        ['a.ts'],
        'sync-to-disk (1 file)',
        null,
        null,
      )

      createSnapshotMock.mockClear()
      await syncToDiskExecutor(
        { paths: ['a.ts'], summary: 'x'.repeat(500) },
        context,
      )
      const title = createSnapshotMock.mock.calls[0][1] as string
      expect(title.startsWith('sync-to-disk (1 file): ')).toBe(true)
      expect(title).toHaveLength('sync-to-disk (1 file): '.length + 160)
    })
  })
})
