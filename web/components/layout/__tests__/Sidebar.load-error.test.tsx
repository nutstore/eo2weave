import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
  workspaces: [] as Array<{ id: string }>,
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
    loadFromDB: vi.fn(async () => {}),
  }
}

describe('Sidebar — conversation loadError banner (issue #147)', () => {
  beforeEach(() => {
    emptyStore()
    mockContextState.activeWorkspaceId = null
    mockContextState.workspaceStats = []
  })

  it('renders the error banner with Retry instead of the list when loadError is set', () => {
    mockConversationState.loadError = 'OPFS init failed'
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
    // No conversation rows rendered while the error is present.
    expect(screen.queryByRole('link', { name: /workspaceLabel/ })).toBeNull()
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
