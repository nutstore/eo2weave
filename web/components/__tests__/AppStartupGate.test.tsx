import { Suspense, useEffect, useRef } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppStartupGate, useStartupReady } from '@/components/AppStartupGate'

const route = vi.hoisted(() => ({ pathname: '/projects/site/workspaces/saved' }))
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }))

function Workspace({ ready, error = false }: { ready: boolean; error?: boolean }) {
  useStartupReady(ready || error)
  return <div>{error ? 'Workspace recovery failed' : ready ? 'Saved conversation' : 'Restoring conversation'}</div>
}

describe('AppStartupGate', () => {
  beforeEach(() => { route.pathname = '/projects/site/workspaces/saved' })

  it('keeps one loading screen through storage and workspace preparation', async () => {
    const loadingScreen = <div role="status">Initializing</div>
    const { rerender } = render(
      <AppStartupGate ready={false} loadingScreen={loadingScreen}>
        <Workspace ready={false} />
      </AppStartupGate>,
    )
    const initialScreen = screen.getByRole('status')
    expect(screen.queryByText('Restoring conversation')).not.toBeInTheDocument()

    rerender(
      <AppStartupGate ready loadingScreen={loadingScreen}>
        <Workspace ready={false} />
      </AppStartupGate>,
    )
    expect(screen.getByRole('status')).toBe(initialScreen)
    expect(screen.getByText('Restoring conversation')).not.toBeVisible()

    rerender(
      <AppStartupGate ready loadingScreen={loadingScreen}>
        <Workspace ready />
      </AppStartupGate>,
    )
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(screen.getByText('Saved conversation')).toBeVisible()

    // Later navigation does not restart the app's initial loading screen.
    rerender(
      <AppStartupGate ready loadingScreen={loadingScreen}>
        <Workspace ready={false} />
      </AppStartupGate>,
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('keeps the prepared workspace mounted when the loading screen is removed', async () => {
    const mounts = vi.fn()
    function PreparedWorkspace() {
      const instance = useRef('Prepared workspace')
      useEffect(() => { mounts() }, [])
      useStartupReady(true)
      return <div>{instance.current}</div>
    }
    render(
      <AppStartupGate ready loadingScreen={<div role="status">Initializing</div>}>
        <PreparedWorkspace />
      </AppStartupGate>,
    )
    await waitFor(() => expect(screen.getByText('Prepared workspace')).toBeVisible())
    expect(mounts).toHaveBeenCalledTimes(1)
  })

  it('keeps startup visible while the destination suspends to load its module', async () => {
    let moduleReady = false
    let resolveModule!: () => void
    const moduleLoading = new Promise<void>((resolve) => { resolveModule = resolve })
    function LazyWorkspace() {
      if (!moduleReady) throw moduleLoading
      return <Workspace ready />
    }
    const view = (ready: boolean) => (
      <Suspense fallback={<div>Outer route fallback</div>}>
        <AppStartupGate ready={ready} loadingScreen={<div role="status">Initializing</div>}>
          <LazyWorkspace />
        </AppStartupGate>
      </Suspense>
    )
    const { rerender } = render(view(false))
    const initialScreen = screen.getByRole('status')

    rerender(view(true))
    expect(initialScreen).toBeVisible()
    expect(screen.queryByText('Outer route fallback')).not.toBeInTheDocument()

    await act(async () => {
      moduleReady = true
      resolveModule()
      await moduleLoading
    })
    expect(screen.getByText('Saved conversation')).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('does not reopen the startup screen when readiness changes after startup', async () => {
    const loadingScreen = <div role="status">Initializing</div>
    const { rerender } = render(
      <AppStartupGate ready loadingScreen={loadingScreen}>
        <Workspace ready />
      </AppStartupGate>,
    )
    await waitFor(() => expect(screen.getByText('Saved conversation')).toBeVisible())
    const conversation = screen.getByText('Saved conversation')

    route.pathname = '/projects/site/workspaces/new'
    rerender(
      <AppStartupGate ready={false} loadingScreen={loadingScreen}>
        <Workspace ready />
      </AppStartupGate>,
    )

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText('Saved conversation')).toBe(conversation)
    expect(conversation).toBeVisible()
  })

  it('reveals workspace recovery errors instead of leaving startup blocked', async () => {
    render(
      <AppStartupGate ready loadingScreen={<div role="status">Initializing</div>}>
        <Workspace ready={false} error />
      </AppStartupGate>,
    )
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(screen.getByText('Workspace recovery failed')).toBeVisible()
  })

  it('lets routes without workspace preparation finish after storage is ready', async () => {
    route.pathname = '/skill-install'
    render(
      <AppStartupGate ready loadingScreen={<div role="status">Initializing</div>}>
        <div>Install skill</div>
      </AppStartupGate>,
    )
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(screen.getByText('Install skill')).toBeVisible()
  })
})
