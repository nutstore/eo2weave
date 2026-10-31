import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'

// ── Mocks ────────────────────────────────────────────────────────────
const routerReplaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: routerReplaceMock, push: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(), info: vi.fn() },
}))

// RootPage renders inside the (app) group's client-only bootstrap; in unit
// tests we exercise the component directly, so the heavy app-build module
// is not needed.
vi.mock('@/app-build', () => ({
  APP_BUILD_ID: 'test',
  IS_DEVELOPMENT: false,
}))

import RootPage from '@/app/(app)/page'
import { useProjectStore } from '@/store/project.store'

// ── Fixtures ─────────────────────────────────────────────────────────
function makeProject(id: string) {
  return { id, name: id, status: 'active' as const, createdAt: 1_000, updatedAt: 1_000 }
}

function setupStore(opts: {
  initialized: boolean
  projects: ReturnType<typeof makeProject>[]
  error?: string | null
  initError?: string | null
}) {
  useProjectStore.setState({
    projects: opts.projects,
    projectStats: {},
    activeProjectId: opts.projects[0]?.id ?? '',
    initialized: opts.initialized,
    isLoading: false,
    // action-level and init failures are INDEPENDENT fields; the fixture
    // must be able to set one without the other (Sourcery: "Action errors
    // can trigger redirects" — merging them in the fixture masked a guard
    // regression that redirected on any action error).
    error: opts.error ?? null,
    initError: opts.initError ?? null,
    initErrorKind: 'transient',
  })
}

/**
 * Re-render helper: RootPage subscribes to the project store, so a plain
 * setState triggers the re-render + effect re-run, mirroring what happens
 * when initialize() fills the list after mount.
 */
function App() {
  const ref = useRef(0)
  useEffect(() => {
    ref.current += 1
  })
  return <RootPage />
}

describe('(app)/page.tsx first-run redirect', () => {
  beforeEach(() => {
    routerReplaceMock.mockClear()
    sessionStorage.clear()
    localStorage.clear()
    useProjectStore.setState({ error: null, initError: null, initErrorKind: 'transient' })
  })

  it('redirects to /projects without the first-run flow when store init failed', async () => {
    // Issue #131: a SQLite init failure must surface the ProjectHomeView
    // error banner (via /projects), never the blank page or a redirect into
    // a "default project" that was never loaded.
    setupStore({ initialized: false, projects: [], initError: 'OPFS pool busy' })
    render(<App />)

    await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith('/projects'))
    expect(routerReplaceMock).not.toHaveBeenCalledWith('/projects/project-fresh')
  })

  it('does NOT redirect to /projects for an action-level error when initError is null', async () => {
    // Sourcery round 2 ("Action errors can trigger redirects"): the guard is
    // keyed on `initError` ONLY. A failed project action sets `error` while
    // `initError` stays null — that must never drive the root-page redirect.
    // With the old fixture (`initError: opts.error`) this regression was
    // invisible: both fields carried the same value, so a guard flipped to
    // `error` still passed this suite.
    setupStore({
      initialized: false,
      projects: [],
      error: 'Failed to rename project',
      initError: null,
    })
    render(<App />)

    await new Promise((r) => setTimeout(r, 30))
    expect(routerReplaceMock).not.toHaveBeenCalled()
  })
  it('redirects to /projects when initialized but the list is terminally empty', async () => {
    // Terminal empty state: the user deleted every project. The auto-default
    // flag stays set, so initialize() will never auto-create again — waiting
    // forever would leave `/` blank. Redirect to the ProjectHome empty state.
    setupStore({ initialized: true, projects: [] })
    render(<App />)

    await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith('/projects'))
  })

  it('waits (no redirect) while storage is not yet initialized', async () => {
    setupStore({ initialized: false, projects: [] })
    render(<App />)

    await new Promise((r) => setTimeout(r, 30))
    expect(routerReplaceMock).not.toHaveBeenCalled()
  })

  it('defers the root redirect while a side-panel hostname route is pending', async () => {
    sessionStorage.setItem('__cw_workspace_assistant_pending', '1')
    localStorage.setItem('creatorweave:auto-default-project-created', '1')
    setupStore({ initialized: true, projects: [makeProject('project-fresh')] })
    render(<App />)

    await new Promise((r) => setTimeout(r, 30))
    expect(routerReplaceMock).not.toHaveBeenCalled()
  })

  it('redirects into the auto-created default project for first-time users', async () => {
    localStorage.setItem('creatorweave:auto-default-project-created', '1')
    setupStore({ initialized: true, projects: [makeProject('project-fresh')] })
    render(<App />)

    await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith('/projects/project-fresh'))
    expect(sessionStorage.getItem('creatorweave:auto-default-redirected')).toBe('1')
  })

  it('redirects to /projects when multiple projects exist (returning user)', async () => {
    localStorage.setItem('creatorweave:auto-default-project-created', '1')
    setupStore({
      initialized: true,
      projects: [makeProject('project-a'), makeProject('project-b')],
    })
    render(<App />)

    await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith('/projects'))
    // Session flag must NOT be consumed in this branch
    expect(sessionStorage.getItem('creatorweave:auto-default-redirected')).toBeNull()
  })

  it('redirects to /projects when the auto-created flag is absent', async () => {
    setupStore({ initialized: true, projects: [makeProject('project-a')] })
    render(<App />)

    await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith('/projects'))
  })

  it('skips the first-run flow once the session flag is set', async () => {
    sessionStorage.setItem('creatorweave:auto-default-redirected', '1')
    localStorage.setItem('creatorweave:auto-default-project-created', '1')
    setupStore({ initialized: true, projects: [makeProject('project-fresh')] })
    render(<App />)

    // Already redirected this session → plain /projects redirect
    await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith('/projects'))
    expect(routerReplaceMock).not.toHaveBeenCalledWith('/projects/project-fresh')
  })
})
