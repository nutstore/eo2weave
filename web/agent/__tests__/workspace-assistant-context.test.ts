import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createProject } = vi.hoisted(() => ({
  createProject: vi.fn(),
}))

vi.mock('@/store/project.store', () => ({
  useProjectStore: {
    getState: () => ({
      projects: [{ id: 'docs-project', name: 'docs.example.com' }],
      createProject,
    }),
  },
}))

describe('workspace assistant side-panel state', () => {
  const binding = '7e30f3b0-d790-4d42-9e05-8f3d38e90be4'
  const launchUrl = `/?source=side_panel&binding=${binding}&origin=https%3A%2F%2Fdocs.example.com`

  beforeEach(() => {
    vi.resetModules()
    createProject.mockReset()
    sessionStorage.clear()
    localStorage.clear()
    window.history.replaceState({}, document.title, launchUrl)
  })

  afterEach(() => {
    window.history.replaceState({}, document.title, '/')
  })

  it('consumes normal-query launch metadata and restores the opaque binding from session storage', async () => {
    const context = await import('../workspace-assistant-context')

    expect(context.isSidePanelMode()).toBe(true)
    expect(context.getSidePanelBindingId()).toBe(binding)
    expect(context.hasPendingSidePanelProjectRoute()).toBe(true)
    expect(window.location.search).toBe('')
    expect(window.location.hash).toBe('')

    vi.resetModules()
    const refreshedContext = await import('../workspace-assistant-context')
    expect(refreshedContext.isSidePanelMode()).toBe(true)
    expect(refreshedContext.getSidePanelBindingId()).toBe(binding)
    expect(refreshedContext.hasPendingSidePanelProjectRoute()).toBe(true)
  })

  it('continues to accept legacy hash-query launch URLs during extension rollout', async () => {
    vi.resetModules()
    sessionStorage.clear()
    window.history.replaceState({}, document.title, `/#/?source=side_panel&binding=${binding}&origin=https%3A%2F%2Fdocs.example.com`)

    const context = await import('../workspace-assistant-context')

    expect(context.isSidePanelMode()).toBe(true)
    expect(context.getSidePanelBindingId()).toBe(binding)
    expect(context.hasPendingSidePanelProjectRoute()).toBe(true)
    expect(window.location.search).toBe('')
    expect(window.location.hash).toBe('#/')
  })

  it('restores the hostname after project routing is consumed and the panel reloads', async () => {
    const context = await import('../workspace-assistant-context')
    const navigate = vi.fn((path: string) => {
      window.history.replaceState({}, document.title, path)
    })

    await context.handleWorkspaceAssistantOnReady(navigate)

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('/projects/docs-project')
    expect(createProject).not.toHaveBeenCalled()
    expect(context.hasPendingSidePanelProjectRoute()).toBe(false)

    vi.resetModules()
    const refreshedContext = await import('../workspace-assistant-context')

    expect(refreshedContext.isSidePanelMode()).toBe(true)
    expect(refreshedContext.getSidePanelBindingId()).toBe(binding)
    expect(refreshedContext.getSidePanelHostname()).toBe('docs.example.com')
    expect(refreshedContext.hasPendingSidePanelProjectRoute()).toBe(false)

    await refreshedContext.handleWorkspaceAssistantOnReady(navigate)
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it('clears the previous hostname when a new launch has no upstream origin', async () => {
    await import('../workspace-assistant-context')
    const nextBinding = '7ec1b838-46c5-4613-98b7-164ed240e671'
    window.history.replaceState({}, document.title, `/?source=side_panel&binding=${nextBinding}`)

    vi.resetModules()
    const context = await import('../workspace-assistant-context')

    expect(context.getSidePanelBindingId()).toBe(nextBinding)
    expect(context.getSidePanelHostname()).toBeNull()
    expect(context.hasPendingSidePanelProjectRoute()).toBe(false)

    vi.resetModules()
    const refreshedContext = await import('../workspace-assistant-context')
    expect(refreshedContext.getSidePanelBindingId()).toBe(nextBinding)
    expect(refreshedContext.getSidePanelHostname()).toBeNull()
  })
})
