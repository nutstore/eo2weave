import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/projects',
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(), info: vi.fn() },
}))

// ── Real-store retry test support (Sourcery round 14) ────────────────
// The retry test drives the REAL initialize() action, so the store's
// infrastructure deps need stubs: the project repository (SQLite) and the
// Web Locks helper used by the auto-create path.
const {
  findAllProjectsMock,
  findProjectStatsMock,
  createProjectMock,
  navigatorLocksRequestMock,
} = vi.hoisted(() => ({
  findAllProjectsMock: vi.fn(),
  findProjectStatsMock: vi.fn(),
  createProjectMock: vi.fn(),
  navigatorLocksRequestMock: vi.fn(),
}))

vi.mock('@/sqlite/repositories/project.repository', () => ({
  DEFAULT_PROJECT_ID: 'default-project',
  getProjectRepository: () => ({
    findAllProjects: findAllProjectsMock,
    findProjectStats: findProjectStatsMock,
    createProject: createProjectMock,
    deleteProject: vi.fn(),
  }),
}))

vi.mock('@/opfs', () => ({
  ProjectManager: { create: vi.fn() },
}))

vi.mock('@/components/activity/ActivityHeatmap', () => ({
  ActivityHeatmap: () => null,
}))

vi.mock('@/store/theme.store', () => ({
  useTheme: () => ({ mode: 'light', setTheme: vi.fn(), accentColor: 'teal', setAccentColor: vi.fn() }),
  ACCENT_COLORS: {},
}))

vi.mock('@/i18n', () => ({
  useT: () => (key: string, params?: Record<string, string | number>) => {
    const messages: Record<string, string> = {
      'app.initFailed': 'Initialization failed',
      'app.retry': 'Retry',
      'app.projectsInitErrorHint': 'Your projects are safe',
      'app.projectsInitUnknownHint': 'Unexpected storage error — data safety unconfirmed',
      'app.projectsInitCorruptionHint': 'Possible data problem',
      'app.projectsInitRetrying': 'Retrying...',
      'projectHome.sidebar.runDiagnostics': 'Run Diagnostics',
      'projectHome.dialogs.diagnosticsInProgress': 'Running…',
      'projectHome.dialogs.diagnosticsRunning': 'Collecting diagnostic information...',
      'projectHome.dialogs.diagnosticsFailed': 'Diagnostics failed',
      'projectHome.dialogs.copyReport': 'Copy Report',
      'projectHome.dialogs.copied': 'Copied',
      'common.close': 'Close',
    }
    let text = messages[key] ?? key
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.replaceAll(`{${name}}`, String(value))
      }
    }
    return text
  },
  useLocale: () => ['zh-CN', vi.fn()],
  LOCALE_LABELS: {
    'zh-CN': 'Simplified Chinese',
    'en-US': 'English',
    'ja-JP': 'Japanese',
    'ko-KR': 'Korean',
  },
}))

import ProjectHomeView from '@/components/project/ProjectHomeView'
import { useProjectStore } from '@/store/project.store'

function setupStore(opts: {
  initError: string | null
  initErrorKind?: 'transient' | 'corruption' | 'unknown'
  initialized?: boolean
  isLoading?: boolean
  initializingRetry?: boolean
  error?: string | null
  projects?: { id: string; name: string; status: 'active'; createdAt: number; updatedAt: number }[]
}) {
  useProjectStore.setState({
    activeProjectId: '',
    projects: opts.projects ?? [],
    projectStats: {},
    initialized: opts.initialized ?? false,
    isLoading: opts.isLoading ?? false,
    error: opts.error ?? null,
    initError: opts.initError,
    initErrorKind: opts.initErrorKind ?? 'transient',
    initializingRetry: opts.initializingRetry ?? false,
  })
}

describe('ProjectHomeView — SQLite init failure surfacing (issue #131)', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      ...(globalThis.navigator as object),
      locks: { request: navigatorLocksRequestMock },
    })
    findAllProjectsMock.mockResolvedValue([])
    findProjectStatsMock.mockResolvedValue([])
    localStorage.removeItem('creatorweave:auto-default-project-created')
    useProjectStore.setState({
      activeProjectId: '',
      projects: [],
      projectStats: {},
      initialized: false,
      isLoading: false,
      error: null,
      initError: null,
      initErrorKind: 'transient',
      initializingRetry: false,
    })
  })

  it('renders an error banner with the error message instead of an empty project list', () => {
    setupStore({ initError: 'OPFS pool busy' })

    render(<ProjectHomeView />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Initialization failed')
    expect(alert).toHaveTextContent('OPFS pool busy')
    // Must NOT show the "No projects yet" empty state — that reads as data loss.
    expect(screen.queryByText('projectHome.empty.noProjects')).toBeNull()
  })

  it('does not render the banner when there is no init error', () => {
    setupStore({
      initError: null,
      initialized: true,
      projects: [{ id: 'p1', name: 'P1', status: 'active', createdAt: 1, updatedAt: 1 }],
    })

    render(<ProjectHomeView />)

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does NOT render the banner for an action-level error (only init failures lock the page)', () => {
    // Sourcery High: `error` also carries project-action failures — a failed
    // rename/delete must never lock the whole projects page into the banner.
    setupStore({
      initError: null,
      error: 'Failed to rename project',
      initialized: true,
      projects: [{ id: 'p1', name: 'P1', status: 'active', createdAt: 1, updatedAt: 1 }],
    })

    render(<ProjectHomeView />)

    expect(screen.queryByRole('alert')).toBeNull()
    // The project card list renders (name appears in card title AND heading
    // region — assert ANY occurrence, not a unique one).
    expect(screen.getAllByText('P1').length).toBeGreaterThan(0)
  })

  it('shows the corruption guidance instead of reassurance for corruption-classified errors', () => {
    setupStore({ initError: 'database file is corrupt', initErrorKind: 'corruption' })

    render(<ProjectHomeView />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Possible data problem')
    expect(alert).not.toHaveTextContent('Your projects are safe')
  })

  it('shows neutral (non-reassuring) copy for unknown-classified init errors', () => {
    // Sourcery round 2 ("Storage damage gets reassurance"): an unclassified
    // storage failure (e.g. I/O error) must not claim the projects are safe.
    setupStore({ initError: 'Storage I/O error', initErrorKind: 'unknown' })

    render(<ProjectHomeView />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Unexpected storage error — data safety unconfirmed')
    expect(alert).not.toHaveTextContent('Your projects are safe')
  })

  it('keeps Diagnostics reachable while the init-error banner is shown', async () => {
    // Sourcery round 2 ("Diagnostics become inaccessible"): when init fails,
    // the banner replaces ProjectHome — and with it the settings drawer that
    // hosts the Diagnostics entry. The banner itself must expose a Diagnostics
    // action so the user can still generate and copy the report.
    const user = userEvent.setup()
    const diagnosticsSpy = vi
      .spyOn(await import('@/storage/diagnostics'), 'runDiagnostics')
      .mockResolvedValue({
        markdown: '# Diagnostic Report\n\nok',
        sections: [],
      } as never)
    setupStore({ initError: 'database file is corrupt', initErrorKind: 'corruption' })

    render(<ProjectHomeView />)

    expect(screen.getByRole('alert')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Run Diagnostics' }))

    await waitFor(() => expect(diagnosticsSpy).toHaveBeenCalledTimes(1))
    // The report becomes copyable so it can be attached to a bug report.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copy Report' })).toBeEnabled()
    )

    // Sourcery round 5 ("Diagnostic reports cannot be copied"): the test must
    // prove the Copy action actually passes the report to the clipboard —
    // a no-op handler would otherwise still pass.
    const copySpy = vi
      .spyOn(await import('@/storage/diagnostics'), 'copyMarkdownToClipboard')
      .mockResolvedValue(true)
    await user.click(screen.getByRole('button', { name: 'Copy Report' }))

    await waitFor(() => expect(copySpy).toHaveBeenCalledTimes(1))
    expect(copySpy).toHaveBeenCalledWith('# Diagnostic Report\n\nok')
  })

  it('keeps the banner (with Retrying...) visible while a retry is in flight', async () => {
    // Sourcery Medium: initialize() clears the error only when it resolves —
    // meanwhile the banner must stay so the empty list never flashes
    // "No projects yet". Drive the retry through the REAL store action
    // (deferred repository response) so the test exercises the actual
    // initializingRetry transition instead of a mocked initialize that
    // never touches state (Sourcery round 14: "Retry banner can disappear
    // unnoticed" — a mock leaving initError untouched makes banner
    // assertions pass without proving the store transition).
    const user = userEvent.setup()

    // Stub the store's infrastructure deps (NOT initialize itself): the
    // repository defers its response so the retry stays in flight until we
    // resolve it; the OPFS/agent sync paths are inert stubs.
    // NOTE: findProjectStatsMock keeps its beforeEach mockResolvedValue([]) —
    // Promise.all snapshots both promises at call time, so a never-settling
    // stats promise here would block initialize() forever even after
    // resolveFindAll fires.
    let resolveFindAll: (projects: never[]) => void = () => {}
    findAllProjectsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFindAll = resolve
        })
    )
    navigatorLocksRequestMock.mockImplementation(
      async (_scope: string, cb: () => Promise<void>) => {
        await cb()
      }
    )
    // Skip the auto-create branch so the retry attempt is a pure
    // repository round-trip.
    localStorage.setItem('creatorweave:auto-default-project-created', '1')

    setupStore({ initError: 'transient' })

    render(<ProjectHomeView />)

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    // Retry is in flight (repository not yet resolved): banner stays, button
    // shows Retrying..., initializingRetry is set by the REAL store action,
    // and the empty-list state never renders.
    const alert = screen.getByRole('alert')
    expect(alert).toBeInTheDocument()
    expect(useProjectStore.getState().initializingRetry).toBe(true)
    expect(useProjectStore.getState().initError).toBe('transient')
    expect(screen.getByRole('button', { name: 'Retrying...' })).toBeDisabled()
    expect(screen.queryByText('projectHome.empty.noProjects')).toBeNull()

    // Let the attempt succeed: the store clears initError and
    // initializingRetry in the SAME set() — the banner must unmount as part
    // of that real transition, not because a mock was cleared.
    resolveFindAll([])
    findProjectStatsMock.mockResolvedValue([])
    await waitFor(() =>
      expect(screen.queryByRole('alert')).toBeNull()
    )
    expect(useProjectStore.getState().initializingRetry).toBe(false)
    expect(useProjectStore.getState().initError).toBe(null)
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Retrying...' })).toBeNull()
    )
  })

  it('re-runs initialize() when the Retry button is clicked', async () => {
    const user = userEvent.setup()
    const initializeSpy = vi
      .spyOn(useProjectStore.getState(), 'initialize')
      .mockResolvedValue(undefined)
    setupStore({ initError: 'transient failure' })

    render(<ProjectHomeView />)

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(initializeSpy).toHaveBeenCalledTimes(1))
    // Failure is not pinned: initialized stays false so the retry is real.
    expect(useProjectStore.getState().initialized).toBe(false)
  })
})
