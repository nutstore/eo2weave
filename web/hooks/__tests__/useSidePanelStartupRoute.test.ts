import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, StrictMode, type PropsWithChildren } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSidePanelStartupRoute } from '@/hooks/useSidePanelStartupRoute'

const mocks = vi.hoisted(() => ({
  pending: true,
  pathname: '/projects',
  router: { replace: vi.fn() },
  handleReady: vi.fn<(navigate: (path: string) => void) => Promise<void>>(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => mocks.router,
}))

vi.mock('@/agent/workspace-assistant-context', () => ({
  hasPendingSidePanelProjectRoute: () => mocks.pending,
  handleWorkspaceAssistantOnReady: mocks.handleReady,
}))

describe('useSidePanelStartupRoute', () => {
  beforeEach(() => {
    mocks.pending = true
    mocks.pathname = '/projects'
    mocks.router.replace.mockReset()
    mocks.handleReady.mockReset().mockResolvedValue(undefined)
  })

  it('holds the launch screen until storage and the resolved Next.js route are ready', async () => {
    const target = '/projects/site/workspaces/saved'
    let finishLookup!: () => void
    mocks.handleReady.mockImplementation(async (navigate) => {
      await new Promise<void>((resolve) => { finishLookup = resolve })
      navigate(target)
    })
    const { result, rerender } = renderHook(
      ({ ready }) => useSidePanelStartupRoute(ready),
      { initialProps: { ready: false } },
    )
    expect(result.current).toBe(true)
    expect(mocks.handleReady).not.toHaveBeenCalled()

    rerender({ ready: true })
    await waitFor(() => expect(mocks.handleReady).toHaveBeenCalledTimes(1))
    expect(result.current).toBe(true)
    await act(async () => finishLookup())
    expect(mocks.router.replace).toHaveBeenCalledWith(target)
    expect(result.current).toBe(true)

    mocks.pathname = target
    rerender({ ready: true })
    await waitFor(() => expect(result.current).toBe(false))

    // Ordinary navigation after startup must not bring the launch screen back.
    mocks.pathname = '/projects/site/workspaces/another'
    rerender({ ready: true })
    expect(result.current).toBe(false)
  })

  it('does not hide ordinary pages without a side-panel launch request', async () => {
    mocks.pending = false
    const { result } = renderHook(() => useSidePanelStartupRoute(true))

    expect(result.current).toBe(false)
  })

  it('reveals the route that interrupts the startup replacement', async () => {
    mocks.handleReady.mockImplementation(async (navigate) => {
      navigate('/projects/site/workspaces/saved')
    })
    const { result, rerender } = renderHook(() => useSidePanelStartupRoute(true))
    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalled())
    expect(result.current).toBe(true)

    // Back/navigation can commit elsewhere before the requested route does.
    mocks.pathname = '/settings'
    rerender()
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('waits for the original lookup through StrictMode effect replay', async () => {
    let finishLookup!: () => void
    mocks.handleReady.mockImplementation(() => new Promise<void>((resolve) => {
      finishLookup = resolve
    }))
    const { result } = renderHook(() => useSidePanelStartupRoute(true), {
      wrapper: ({ children }: PropsWithChildren) => createElement(StrictMode, null, children),
    })

    expect(mocks.handleReady).toHaveBeenCalledTimes(1)
    expect(result.current).toBe(true)
    await act(async () => finishLookup())
    await waitFor(() => expect(result.current).toBe(false))
  })
})
