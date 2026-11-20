import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mocks = vi.hoisted(() => ({
  sidePanel: false,
  requestPermission: vi.fn(),
  loadRoots: vi.fn(),
  repickRoot: vi.fn(),
}))

vi.mock('@/agent/workspace-assistant-context', () => ({ isSidePanelMode: () => mocks.sidePanel }))
// Return templates containing the interpolation placeholders so the tests
// fail if the component stops substituting {name}/{count}.
vi.mock('@/i18n', () => ({
  useT: () => (key: string) =>
    ({
      'projectRoots.bannerSingleTitle': 'Reauthorize {name}',
      'projectRoots.bannerMultiTitle': 'Reauthorize {count} folders',
    })[key] ?? key,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/native-fs', () => ({ bindRuntimeDirectoryHandle: vi.fn() }))
vi.mock('@/store/agent.store', () => ({ useAgentStore: { setState: vi.fn() } }))

const expiredRoot = {
  id: 'root-photos',
  name: 'photos',
  isDefault: false,
  readOnly: false,
  backend: 'fsaccess',
  scopeId: null,
  handle: null,
  persistedHandle: { requestPermission: mocks.requestPermission },
  status: 'needs_user_activation',
}
const nativeRoot = {
  id: 'root-disk',
  name: 'disk-archive',
  isDefault: false,
  readOnly: false,
  backend: 'native-host',
  scopeId: 'scope-1',
  handle: null,
  persistedHandle: null,
  // needs_user_activation on purpose: if the fsaccess-only filter regresses,
  // this fixture must surface in the banner and fail the exclusion test
  // (an 'idle' status would mask the regression).
  status: 'needs_user_activation',
}

vi.mock('@/store/folder-access.store', () => {
  let state: Record<string, unknown> = {
    roots: [] as unknown[],
    rootsHydrated: true,
    activeProjectId: 'project-1',
    loadRoots: mocks.loadRoots,
    repickRoot: mocks.repickRoot,
  }
  const useFolderAccessStore = (selector?: (s: Record<string, unknown>) => unknown) =>
    selector ? selector(state) : state
  useFolderAccessStore.getState = () => state
  useFolderAccessStore.setState = (
    partial: Partial<Record<string, unknown>> | ((s: Record<string, unknown>) => Partial<Record<string, unknown>>)
  ) => {
    state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) }
  }
  return {
    useFolderAccessStore,
    __setMockState: (s: Record<string, unknown>) => {
      state = s
    },
  }
})

// @ts-expect-error — test-only export from the vi.mock factory (real module has no __setMockState)
import { __setMockState, useFolderAccessStore } from '@/store/folder-access.store'

function setRoots(roots: unknown[], hydrated = true) {
  __setMockState({
    roots,
    rootsHydrated: hydrated,
    activeProjectId: 'project-1',
    loadRoots: mocks.loadRoots,
    repickRoot: mocks.repickRoot,
  })
}

import { FolderPermissionBanner } from '../FolderPermissionBanner'
import { toast } from 'sonner'
import { useAgentStore } from '@/store/agent.store'

describe('FolderPermissionBanner (issue #83)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadRoots.mockResolvedValue(undefined)
    mocks.repickRoot.mockResolvedValue(true)
    setRoots([expiredRoot])
    window.sessionStorage.clear()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders with a re-authorize action when a fsaccess root is needs_user_activation', () => {
    render(<FolderPermissionBanner />)
    expect(screen.getByTestId('folder-permission-banner')).toBeTruthy()
    // Interpolation assertion: the {name} placeholder must be substituted.
    expect(screen.getByText('Reauthorize photos')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'projectRoots.bannerReauthorize' })).toBeTruthy()
  })

  it('asks for a fresh pick when the stored handle never answered', async () => {
    // Field case (#316): the directory is fine and was never moved, but the
    // persisted handle stopped answering permission calls. Asking it again
    // cannot work, so the banner must drive a re-pick instead.
    setRoots([{ ...expiredRoot, stalled: true }])
    render(<FolderPermissionBanner />)

    const button = screen.getByRole('button', { name: 'projectRoots.bannerReselect' })
    await act(async () => {
      await userEvent.click(button)
    })

    expect(mocks.repickRoot).toHaveBeenCalledWith('photos')
    expect(mocks.requestPermission).not.toHaveBeenCalled()
  })

  it('shows nothing when all roots are ready', () => {
    setRoots([{ ...expiredRoot, status: 'ready' }])
    const { container } = render(<FolderPermissionBanner />)
    expect(screen.queryByTestId('folder-permission-banner')).toBeNull()
    expect(container.childElementCount).toBe(0)
  })

  it('excludes native-host roots even when they are needs_user_activation', () => {
    setRoots([nativeRoot])
    render(<FolderPermissionBanner />)
    expect(screen.queryByTestId('folder-permission-banner')).toBeNull()
  })

  it('lists only fsaccess roots when native-host and expired roots coexist', () => {
    setRoots([nativeRoot, expiredRoot])
    render(<FolderPermissionBanner />)
    // Only the fsaccess root counts → single-folder title, not the multi one.
    expect(screen.getByText('Reauthorize photos')).toBeTruthy()
    expect(screen.queryByText(/disk-archive/)).toBeNull()
    expect(screen.getByRole('button', { name: 'projectRoots.bannerReauthorize' })).toBeTruthy()
  })

  it('waits for hydration before deciding', () => {
    setRoots([expiredRoot], false)
    render(<FolderPermissionBanner />)
    expect(screen.queryByTestId('folder-permission-banner')).toBeNull()
  })

  it('lists every expired folder name when several lapse at once', () => {
    setRoots([expiredRoot, { ...expiredRoot, id: 'root-docs', name: 'documents' }])
    render(<FolderPermissionBanner />)
    // Interpolation assertion: the {count} placeholder must be substituted.
    expect(screen.getByText('Reauthorize 2 folders')).toBeTruthy()
    expect(screen.getByText('photos, documents')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'photos' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'documents' })).toBeTruthy()
  })

  it('requests permission on click, refreshes roots via loadRoots, and hides the banner once granted', async () => {
    mocks.requestPermission.mockResolvedValue('granted')
    // The grant flow must refresh root status: simulate the real store by
    // making loadRoots flip the root to ready. The banner must disappear as
    // a result of that refresh — not because the test manually edits state.
    mocks.loadRoots.mockImplementation(async () => {
      setRoots([{ ...expiredRoot, status: 'ready', handle: {} }])
    })
    const user = userEvent.setup()
    const { rerender } = render(<FolderPermissionBanner />)
    await user.click(screen.getByRole('button', { name: 'projectRoots.bannerReauthorize' }))
    await waitFor(() =>
      expect(mocks.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' })
    )
    // The successful restore must call loadRoots() to refresh root statuses.
    await waitFor(() => expect(mocks.loadRoots).toHaveBeenCalled())
    // The mock store doesn't notify subscribers — re-render to let the
    // component read the state loadRoots() just wrote. The banner must
    // disappear because of the grant flow's refresh, not a manual edit.
    rerender(<FolderPermissionBanner />)
    await waitFor(() =>
      expect(screen.queryByTestId('folder-permission-banner')).toBeNull()
    )
  })

  it('still treats the grant as success when loadRoots rejects after a grant', async () => {
    mocks.requestPermission.mockResolvedValue('granted')
    mocks.loadRoots.mockRejectedValue(new Error('db down'))
    const user = userEvent.setup()
    render(<FolderPermissionBanner />)
    await user.click(screen.getByRole('button', { name: 'projectRoots.bannerReauthorize' }))
    // The grant must not be reported as a failure…
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('projectRoots.permissionRestored'))
    expect(toast.error).not.toHaveBeenCalledWith('projectRoots.permissionFailed')
    // …and the agent store must still be synced with the granted handle.
    await waitFor(() => expect(useAgentStore.setState).toHaveBeenCalled())
    expect(useAgentStore.setState).toHaveBeenCalledWith(
      expect.objectContaining({ directoryName: 'photos' })
    )
    // Even with the reload failing, the granted root must be marked ready
    // optimistically (Sourcery round 3): the success toast must never sit
    // next to a banner still showing that folder as expired.
    await waitFor(() =>
      expect(
        (useFolderAccessStore.getState() as { roots: Array<{ id: string; status: string }> })
          .roots.find((r) => r.id === 'root-photos')?.status
      ).toBe('ready')
    )
  })

  it('keeps the banner visible after a denied permission request', async () => {
    mocks.requestPermission.mockResolvedValue('denied')
    const user = userEvent.setup()
    render(<FolderPermissionBanner />)
    await user.click(screen.getByRole('button', { name: 'projectRoots.bannerReauthorize' }))
    await waitFor(() => expect(mocks.requestPermission).toHaveBeenCalled())
    // The denial path ends with the `permissionDenied` error toast; waiting
    // for it proves the whole restore flow (including its post-await state
    // work) has settled before we assert the banner stayed put — otherwise a
    // handler that hides the banner after the awaited denial would still
    // pass this test (Sourcery round 2 finding).
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('projectRoots.permissionDenied'))
    expect(screen.getByTestId('folder-permission-banner')).toBeTruthy()
  })

  it('dismiss hides it for the session, stores the flag, and stays hidden after remount', async () => {
    const user = userEvent.setup()
    const first = render(<FolderPermissionBanner />)
    await user.click(screen.getByRole('button', { name: 'projectRoots.bannerDismiss' }))
    expect(screen.queryByTestId('folder-permission-banner')).toBeNull()
    expect(window.sessionStorage.getItem('folder-permission-banner-dismissed')).toBe('1')

    // Remount in the same session: the mount-time read of the session flag
    // must keep the banner hidden (not just local component state).
    first.unmount()
    act(() => {
      setRoots([expiredRoot])
    })
    render(<FolderPermissionBanner />)
    expect(screen.queryByTestId('folder-permission-banner')).toBeNull()

    // Inverse contract (Sourcery round 3): the banner must COME BACK when
    // the session flag is absent — without this assertion, removing the
    // mount-time sessionStorage read would still pass (dismissed state
    // defaults hidden), silently turning a session dismissal into a
    // permanent one. Clear the flag, remount, expect the banner again.
    first.unmount()
    window.sessionStorage.removeItem('folder-permission-banner-dismissed')
    act(() => {
      setRoots([expiredRoot])
    })
    render(<FolderPermissionBanner />)
    expect(screen.getByTestId('folder-permission-banner')).toBeTruthy()
  })

  it('hands off to /folder-pick in side-panel mode instead of prompting', async () => {
    mocks.sidePanel = true
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    const user = userEvent.setup()
    render(<FolderPermissionBanner />)
    await user.click(screen.getByRole('button', { name: 'projectRoots.bannerReauthorize' }))
    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining('/folder-pick?projectId=project-1'),
      '_blank',
      'noopener'
    )
    expect(mocks.requestPermission).not.toHaveBeenCalled()
    openSpy.mockRestore()
    mocks.sidePanel = false
  })
})
