import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/sqlite/repositories/project.repository'
import type { Workspace } from '@/sqlite/repositories/workspace.repository'

const mocks = vi.hoisted(() => ({
  projects: [] as Project[],
  createProject: vi.fn(),
  findWorkspacesByProject: vi.fn(),
}))

vi.mock('@/store/project.store', () => ({
  useProjectStore: {
    getState: () => ({ projects: mocks.projects, createProject: mocks.createProject }),
  },
}))

vi.mock('@/sqlite/repositories/workspace.repository', () => ({
  getWorkspaceRepository: () => ({ findWorkspacesByProject: mocks.findWorkspacesByProject }),
}))

describe('workspace assistant side-panel state', () => {
  const binding = '7e30f3b0-d790-4d42-9e05-8f3d38e90be4'
  const launchUrl = `/?source=side_panel&binding=${binding}&origin=https%3A%2F%2Fdocs.example.com`

  beforeEach(() => {
    vi.resetModules()
    sessionStorage.clear()
    localStorage.clear()
    mocks.projects = [{
      id: 'docs-project',
      name: 'docs.example.com',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    }]
    mocks.createProject.mockReset()
    mocks.findWorkspacesByProject.mockReset().mockResolvedValue([])
    window.history.replaceState({}, document.title, launchUrl)
  })

  afterEach(() => {
    window.history.replaceState({}, document.title, '/')
  })

  it('consumes normal-query launch metadata and restores the opaque binding from session storage', async () => {
    const context = await import('@/agent/workspace-assistant-context')

    expect(context.isSidePanelMode()).toBe(true)
    expect(context.getSidePanelBindingId()).toBe(binding)
    expect(context.hasPendingSidePanelProjectRoute()).toBe(true)
    expect(window.location.search).toBe('')
    expect(window.location.hash).toBe('')

    vi.resetModules()
    const refreshedContext = await import('@/agent/workspace-assistant-context')
    expect(refreshedContext.isSidePanelMode()).toBe(true)
    expect(refreshedContext.getSidePanelBindingId()).toBe(binding)
    expect(refreshedContext.hasPendingSidePanelProjectRoute()).toBe(true)
  })

  it('continues to accept legacy hash-query launch URLs during extension rollout', async () => {
    vi.resetModules()
    sessionStorage.clear()
    window.history.replaceState({}, document.title, `/#/?source=side_panel&binding=${binding}&origin=https%3A%2F%2Fdocs.example.com`)

    const context = await import('@/agent/workspace-assistant-context')

    expect(context.isSidePanelMode()).toBe(true)
    expect(context.getSidePanelBindingId()).toBe(binding)
    expect(context.hasPendingSidePanelProjectRoute()).toBe(true)
    expect(window.location.search).toBe('')
    expect(window.location.hash).toBe('#/')
  })

  it('opens the hostname project directly at its most recent workspace', async () => {
    const context = await import('@/agent/workspace-assistant-context')
    // The repository returns workspaces in descending lastAccessedAt order.
    mocks.findWorkspacesByProject.mockResolvedValue([
      { id: 'recent-workspace', lastAccessedAt: 200 },
      { id: 'older-workspace', lastAccessedAt: 100 },
    ])
    const navigate = vi.fn()

    await context.handleWorkspaceAssistantOnReady(navigate)

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith(
      '/projects/docs-project/workspaces/recent-workspace',
    )
    expect(mocks.findWorkspacesByProject).toHaveBeenCalledWith('docs-project')
  })

  it('waits for workspace resolution without navigating through the bare project route', async () => {
    const context = await import('@/agent/workspace-assistant-context')
    let resolveWorkspaces!: (workspaces: Pick<Workspace, 'id'>[]) => void
    mocks.findWorkspacesByProject.mockReturnValue(new Promise((resolve) => {
      resolveWorkspaces = resolve
    }))
    const navigate = vi.fn()
    const pending = context.handleWorkspaceAssistantOnReady(navigate)

    await vi.waitFor(() => expect(mocks.findWorkspacesByProject).toHaveBeenCalled())
    expect(navigate).not.toHaveBeenCalled()

    resolveWorkspaces([{ id: 'resolved-workspace' }])
    await pending
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith(
      '/projects/docs-project/workspaces/resolved-workspace',
    )
  })

  it('opens a newly created hostname project at the bare route when it has no workspaces', async () => {
    const context = await import('@/agent/workspace-assistant-context')
    mocks.projects = []
    mocks.createProject.mockResolvedValue({ id: 'new-project' })
    const navigate = vi.fn()

    await context.handleWorkspaceAssistantOnReady(navigate)
    await context.handleWorkspaceAssistantOnReady(navigate)

    expect(mocks.createProject).toHaveBeenCalledTimes(1)
    expect(mocks.createProject).toHaveBeenCalledWith('docs.example.com')
    expect(mocks.findWorkspacesByProject).toHaveBeenCalledWith('new-project')
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('/projects/new-project')
  })

  it('falls back to the project route when workspace lookup fails', async () => {
    const context = await import('@/agent/workspace-assistant-context')
    mocks.findWorkspacesByProject.mockRejectedValue(new Error('SQLite read failed'))
    const navigate = vi.fn()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await context.handleWorkspaceAssistantOnReady(navigate)
      await context.handleWorkspaceAssistantOnReady(navigate)

      expect(navigate).toHaveBeenCalledTimes(1)
      expect(navigate).toHaveBeenCalledWith('/projects/docs-project')
      expect(mocks.findWorkspacesByProject).toHaveBeenCalledTimes(1)
      expect(warning).toHaveBeenCalled()
    } finally {
      warning.mockRestore()
    }
  })
})
