import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const route = vi.hoisted(() => ({ pathname: '/projects/project-a/workspaces/first' }))
vi.mock('next/navigation', () => ({
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(),
}))

describe('side-panel navigation', () => {
  beforeEach(() => {
    vi.resetModules()
    sessionStorage.clear()
    route.pathname = '/projects/project-a/workspaces/first'
    window.history.replaceState({}, '', '/?source=side_panel&binding=panel-binding')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  it('keeps navigation inside the web app without reconfiguring the panel URL', async () => {
    const registeredPaths: string[] = []
    vi.stubGlobal('__agentWeb', {
      settleSidePanelPath: async (path: string) => {
        registeredPaths.push(path)
        return { ok: true }
      },
    })
    const { useSidePanelSessionRecovery } = await import('../useSidePanelSessionRecovery')
    const { getSidePanelBindingId } = await import('@/agent/workspace-assistant-context')
    const { rerender } = renderHook(() => useSidePanelSessionRecovery())
    await act(async () => { await Promise.resolve() })

    route.pathname = '/projects/project-a/workspaces/new-conversation'
    rerender()
    await act(async () => { await Promise.resolve() })

    expect(getSidePanelBindingId()).toBe('panel-binding')
    expect(registeredPaths).toEqual([])
  })

  it('recovers the binding when the panel reloads on a clean URL', async () => {
    window.history.replaceState({}, '', '/projects/project-a/workspaces/first')
    vi.stubGlobal('__agentWeb', {
      getSidePanelLaunchMetadata: async () => ({
        ok: true, binding: 'recovered-binding', hostname: 'docs.example.com',
      }),
    })
    const { useSidePanelSessionRecovery } = await import('../useSidePanelSessionRecovery')
    const { getSidePanelBindingId, getSidePanelHostname } = await import('@/agent/workspace-assistant-context')
    renderHook(() => useSidePanelSessionRecovery())

    await waitFor(() => expect(getSidePanelBindingId()).toBe('recovered-binding'))
    expect(getSidePanelHostname()).toBe('docs.example.com')
  })
})
