import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Sidebar } from '@/components/layout/Sidebar'

/**
 * Issue #147 invariant: when the conversation store's loadFromDB fails
 * (loadError set), the sidebar must render an error banner with a Retry
 * button — never the empty list, which reads as "history wiped".
 */

// ── Conversation store (the concern under test) ─────────────────────────
let mockConversationState: {
  conversations: Array<{ id: string; title: string }>
  loadError: string | null
  loadErrorScope: 'metadata' | 'transcript' | null
  loadFromDB: ReturnType<typeof vi.fn>
}

vi.mock('@/store/conversation.store', () => ({
  useConversationStore: (selector: (s: typeof mockConversationState) => unknown) =>
    selector(mockConversationState),
}))

// ── Side stores the Sidebar reads reactively ────────────────────────────
const mockScheduleState = { workspaceScheduleCount: new Map() }
vi.mock('@/store/schedule.store', () => ({
  useScheduleStore: (selector: (s: typeof mockScheduleState) => unknown) => selector(mockScheduleState),
}))

const mockRuntimeState = { runtimes: new Map() }
vi.mock('@/store/conversation-runtime.store', () => ({
  useConversationRuntimeStore: (selector: (s: typeof mockRuntimeState) => unknown) => selector(mockRuntimeState),
}))

const mockContextState = {
  activeWorkspaceId: null as string | null,
  workspaces: [] as Array<{ id: string; status?: string; pendingCount?: number; lastAccessedAt?: number }>,
  workspaceStats: [] as Array<{ id: string; status?: string; pendingCount?: number }>,
  currentPendingCount: 0,
}
vi.mock('@/store/conversation-context.store', () => ({
  useConversationContextStore: (selector: (s: typeof mockContextState) => unknown) => selector(mockContextState),
}))

const mockWorkspaceState = {
  pinnedWorkspaceIds: [] as string[],
  togglePin: vi.fn(),
  workspaceScheduleCount: {} as Record<string, number>,
}
vi.mock('@/store/workspace.store', () => ({
  useWorkspaceStore: (selector: (s: typeof mockWorkspaceState) => unknown) => selector(mockWorkspaceState),
}))

const mockProjectState = { activeProjectId: 'p1' }
vi.mock('@/store/project.store', () => ({
  useProjectStore: (selector: (s: typeof mockProjectState) => unknown) => selector(mockProjectState),
}))

const mockOpfsState = {
  isRefreshing: false,
  refresh: vi.fn(),
  pendingChanges: [],
  cachedPaths: [] as string[],
  approvedNotSyncedPaths: new Set<string>(),
}
vi.mock('@/store/opfs.store', () => ({
  useOPFSStore: (selector: (s: typeof mockOpfsState) => unknown) => selector(mockOpfsState),
}))

const mockFolderAccessState = { roots: [] as Array<{ id: string; name: string }> }
vi.mock('@/store/folder-access.store', () => ({
  useFolderAccessStore: (selector: (s: typeof mockFolderAccessState) => unknown) => selector(mockFolderAccessState),
}))

const mockPrefsState = {
  panelSizes: { sidebarWidth: 280, conversationRatio: 50 },
  panelState: { sidebarCollapsed: false },
  setSidebarWidth: vi.fn(),
  setConversationRatio: vi.fn(),
  setSidebarCollapsed: vi.fn(),
}
vi.mock('@/store/workspace-preferences.store', () => ({
  useWorkspacePreferencesStore: (selector: (s: typeof mockPrefsState) => unknown) => selector(mockPrefsState),
}))

// ── Framework / heavy children ──────────────────────────────────────────
vi.mock('framer-motion', () => ({
  motion: new Proxy({}, { get: () => (props: Record<string, unknown>) => <div {...props} /> }),
  useReducedMotion: () => true,
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: (props: Record<string, unknown>) => <a {...props} />,
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn() }) }))

vi.mock('@/components/file-viewer/FileTreePanel', () => ({
  FileTreePanel: () => <div data-testid='file-tree-panel' />,
}))
vi.mock('@/components/sync/PendingSyncPanel', () => ({
  PendingSyncPanel: () => <div />,
}))
vi.mock('@/components/sync/SnapshotList', () => ({
  SnapshotList: () => <div />,
}))
vi.mock('@/components/conversation/ExportConversationDialog', () => ({
  ExportConversationDialog: () => <div />,
}))
vi.mock('@/components/conversation/BatchExportDialog', () => ({
  BatchExportDialog: () => <div />,
}))

function emptyStore() {
  mockConversationState = {
    conversations: [],
    loadError: null,
    loadErrorScope: null,
    loadFromDB: vi.fn(async () => {}),
  }
}

/**
 * Seed the workspace lists the sidebar renders rows from. The rows come from
 * the context store's `workspaces` (workspaceStats only carries the status
 * map), so both have to be seeded for a row to appear.
 */
function seedWorkspaces(ids: string[]) {
  mockContextState.workspaces = ids.map((id) => ({ id, status: 'active' }))
  mockContextState.workspaceStats = ids.map((id) => ({ id, status: 'active' }))
}

describe('Sidebar — conversation loadError banner (issue #147)', () => {
  beforeEach(() => {
    emptyStore()
    mockContextState.activeWorkspaceId = null
    mockContextState.workspaces = []
    mockContextState.workspaceStats = []
  })

  it('renders the error banner with Retry instead of the list when the metadata load failed', () => {
    mockConversationState.loadError = 'OPFS init failed'
    // The METADATA load failed — the conversation list itself is unavailable,
    // so the rows must stay hidden.
    mockConversationState.loadErrorScope = 'metadata'
    // A non-empty list proves the failure case really hides conversation
    // rows — an empty list would pass even if the banner rendered on top
    // of the list (PR #149 review).
    mockConversationState.conversations = [{ id: 'c1', title: 'My chat' }]
    mockContextState.activeWorkspaceId = 'c1'
    seedWorkspaces(['c1'])
    render(
      <Sidebar
        onFileSelect={() => {}}
        onInspect={() => {}}
        selectedFilePath={null}
        onSelectWorkspace={() => {}}
      />,
    )

    const banner = screen.getByTestId('conversation-load-error')
    expect(banner.getAttribute('role')).toBe('alert')
    // The raw error message must be visible — not just a generic title.
    expect(screen.getByText('OPFS init failed')).toBeTruthy()
    // Retry button re-runs loadFromDB.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mockConversationState.loadFromDB).toHaveBeenCalledTimes(1)
    // No conversation rows rendered while the error is present — neither the
    // row link (role="listitem" + workspaceLabel aria-label) nor its title.
    expect(screen.queryByRole('listitem', { name: 'Chat: My chat' })).toBeNull()
    expect(screen.queryByText('My chat')).toBeNull()
  })

  it('keeps the loaded conversation rows visible when only the transcript failed', () => {
    // PR #149 review ("Active transcript failure hides all history"): the
    // metadata loaded, only the ACTIVE conversation's transcript read failed.
    // Hiding every row would strand the user on the failing conversation
    // with no way to select another one.
    mockConversationState.loadError = 'Failed to load messages for active conversation'
    mockConversationState.loadErrorScope = 'transcript'
    mockConversationState.conversations = [
      { id: 'c1', title: 'Failing chat' },
      { id: 'c2', title: 'Other chat' },
    ]
    mockContextState.activeWorkspaceId = 'c1'
    seedWorkspaces(['c1', 'c2'])
    render(
      <Sidebar
        onFileSelect={() => {}}
        onInspect={() => {}}
        selectedFilePath={null}
        onSelectWorkspace={() => {}}
      />,
    )

    // The failure is still surfaced…
    expect(screen.getByTestId('conversation-load-error')).toBeTruthy()
    expect(
      screen.getByText('Failed to load messages for active conversation'),
    ).toBeTruthy()
    // …but the loaded rows stay usable so the user can pick another chat.
    expect(screen.getByRole('listitem', { name: 'Chat: Failing chat' })).toBeTruthy()
    expect(screen.getByRole('listitem', { name: 'Chat: Other chat' })).toBeTruthy()
  })

  it('keeps the alert visible until a pending retry settles', async () => {
    // PR #149 review ("Retry persistence is unchecked"): a deferred
    // loadFromDB mock proves the alert survives the whole retry — a render
    // that hid the banner while the retry was still in flight would fail
    // here.
    mockConversationState.loadError = 'OPFS init failed'
    mockConversationState.loadErrorScope = 'metadata'
    mockConversationState.conversations = [{ id: 'c1', title: 'My chat' }]
    mockContextState.activeWorkspaceId = 'c1'
    seedWorkspaces(['c1'])

    let resolveRetry!: () => void
    mockConversationState.loadFromDB = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve
        }),
    )

    render(
      <Sidebar
        onFileSelect={() => {}}
        onInspect={() => {}}
        selectedFilePath={null}
        onSelectWorkspace={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mockConversationState.loadFromDB).toHaveBeenCalledTimes(1)

    // The retry is still in flight: the alert must stay visible and the
    // Retry button must show the "retrying" state.
    expect(screen.getByTestId('conversation-load-error')).toBeTruthy()
    expect(screen.getByText('OPFS init failed')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeTruthy()

    // Round-3 hardening (PR #149 review): the settled store state must be
    // what the banner reflects after the retry — mutate the mocked store
    // (successful retry clears the error) before resolving, and assert the
    // banner GONE against the changed state.
    resolveRetry()
    mockConversationState.loadError = null
    mockConversationState.loadErrorScope = null
    await act(async () => {
      await Promise.resolve()
    })

    // The retry settled onto a clean store: the alert (and its Retry button
    // with it) is gone — no stale "Retrying…" state is left behind.
    expect(screen.queryByTestId('conversation-load-error')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retrying…' })).toBeNull()
  })

  it('renders a generic message (not a blank line) when loadError is an empty string', () => {
    mockConversationState.loadError = ''
    render(
      <Sidebar
        onFileSelect={() => {}}
        onInspect={() => {}}
        selectedFilePath={null}
        onSelectWorkspace={() => {}}
      />,
    )

    // `loadError !== null` — not truthiness — must gate the banner, or an
    // Error with an empty message silently hides it.
    expect(screen.getByTestId('conversation-load-error')).toBeTruthy()
    expect(screen.queryByText('My chat')).toBeNull()
  })

  it('renders the normal list when loadError is null', () => {
    mockContextState.activeWorkspaceId = 'c1'
    mockContextState.workspaceStats = [{ id: 'c1', status: 'active' }]
    mockConversationState.conversations = [{ id: 'c1', title: 'My chat' }]
    render(
      <Sidebar
        onFileSelect={() => {}}
        onInspect={() => {}}
        selectedFilePath={null}
        onSelectWorkspace={() => {}}
      />,
    )

    expect(screen.queryByTestId('conversation-load-error')).toBeNull()
    expect(screen.getByText('My chat')).toBeTruthy()
  })
})
