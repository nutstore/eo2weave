import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useProjectStore } from '@/store/project.store'
import { WorkspaceEntry } from '@/components/project/WorkspaceEntry'

const replace = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }))
vi.mock('@/agent/workspace-assistant-context', () => ({ hasPendingSidePanelProjectRoute: () => false }))

describe('workspace entry', () => {
  beforeEach(() => { replace.mockClear(); localStorage.clear(); sessionStorage.clear() })
  it('opens an automatically created project on first entry', async () => {
    localStorage.setItem('creatorweave:auto-default-project-created', '1')
    sessionStorage.setItem('creatorweave:auto-default-pending-entry', '1')
    useProjectStore.setState({ initialized: true, initError: null, projects: [{ id: 'fresh', name: 'Fresh', status: 'active', createdAt: 1, updatedAt: 1 }] })
    render(<WorkspaceEntry />)
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/projects/fresh'))
  })
  it('keeps the project list when a returning user has one default project', () => {
    localStorage.setItem('creatorweave:auto-default-project-created', '1')
    useProjectStore.setState({ initialized: true, initError: null, projects: [{ id: 'existing', name: 'Existing', status: 'active', createdAt: 1, updatedAt: 1 }] })
    render(<WorkspaceEntry />)
    expect(replace).not.toHaveBeenCalled()
  })
  it('keeps the project list for returning users', () => {
    useProjectStore.setState({ initialized: true, initError: null, projects: [] })
    render(<WorkspaceEntry />)
    expect(replace).not.toHaveBeenCalled()
  })
})
