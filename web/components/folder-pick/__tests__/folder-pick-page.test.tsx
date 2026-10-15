import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  save: vi.fn(),
  park: vi.fn(),
  postMessage: vi.fn(),
  closeChannel: vi.fn(),
  projectId: 'project-folder-test' as string | null,
}))

vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mocks.projectId ? { projectId: mocks.projectId } : {}),
}))
vi.mock('@/i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('@/services/fsAccess.service', () => ({ selectFolderReadWrite: mocks.pick }))
vi.mock('@/services/folder-access.repository', () => ({
  folderAccessRepo: { save: mocks.save, saveParkedHandle: mocks.park },
}))

import FolderPickPage from '@/app/(app)/folder-pick/page'

function directory(readError?: Error): FileSystemDirectoryHandle {
  return {
    name: 'photos',
    async *entries() {
      if (readError) throw readError
      yield ['cover.png', { kind: 'file' }] as const
    },
  } as unknown as FileSystemDirectoryHandle
}

describe('folder-pick page handoff', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.projectId = 'project-folder-test'
    mocks.save.mockResolvedValue(undefined)
    mocks.park.mockResolvedValue('pick-photos')
    vi.stubGlobal('BroadcastChannel', class {
      postMessage = mocks.postMessage
      close = mocks.closeChannel
    })
    vi.spyOn(window, 'close').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps the granting tab open after a readable directory is parked and broadcast without replacing a mounted root', async () => {
    const handle = directory()
    mocks.pick.mockResolvedValue(handle)
    const timeout = vi.spyOn(window, 'setTimeout')
    render(<FolderPickPage />)
    await userEvent.setup().click(screen.getByText('folderPick.choose'))

    expect(await screen.findByText('folderPick.done')).toBeInTheDocument()
    expect(mocks.park).toHaveBeenCalledWith(handle, 'project-folder-test')
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.postMessage).toHaveBeenCalledWith({ type: 'folder-picked', name: 'photos', pickId: 'pick-photos', projectId: 'project-folder-test' })
    expect(mocks.closeChannel).toHaveBeenCalledOnce()
    expect(window.close).not.toHaveBeenCalled()
    expect(timeout.mock.calls.some(([, delay]) => delay === 300)).toBe(false)
  })

  it('does not persist or broadcast an unreadable picked directory', async () => {
    mocks.pick.mockResolvedValue(directory(new DOMException('Directory access denied', 'NotAllowedError')))
    render(<FolderPickPage />)
    await userEvent.setup().click(screen.getByText('folderPick.choose'))

    expect(await screen.findByText('folderPick.failedTitle')).toBeInTheDocument()
    expect(screen.getByText('NotAllowedError: Directory access denied')).toBeInTheDocument()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.park).not.toHaveBeenCalled()
    expect(mocks.postMessage).not.toHaveBeenCalled()
    expect(screen.queryByText('folderPick.done')).not.toBeInTheDocument()
  })

  it('does not claim success or notify the panel when handle persistence fails', async () => {
    mocks.pick.mockResolvedValue(directory())
    mocks.park.mockRejectedValue(new Error('Handle storage failed'))
    render(<FolderPickPage />)
    await userEvent.setup().click(screen.getByText('folderPick.choose'))

    expect(await screen.findByText('folderPick.failedTitle')).toBeInTheDocument()
    expect(mocks.postMessage).not.toHaveBeenCalled()
    expect(screen.queryByText('folderPick.done')).not.toBeInTheDocument()
    expect(window.close).not.toHaveBeenCalled()
  })

  it('reports broadcast failure rather than displaying completion', async () => {
    mocks.pick.mockResolvedValue(directory())
    mocks.postMessage.mockImplementation(() => { throw new Error('Channel unavailable') })
    render(<FolderPickPage />)
    await userEvent.setup().click(screen.getByText('folderPick.choose'))

    expect(await screen.findByText('folderPick.failedTitle')).toBeInTheDocument()
    expect(screen.queryByText('folderPick.done')).not.toBeInTheDocument()
  })

  it('parks the validated handle when no project is specified', async () => {
    mocks.projectId = null
    const handle = directory()
    mocks.pick.mockResolvedValue(handle)
    render(<FolderPickPage />)
    await userEvent.setup().click(screen.getByText('folderPick.choose'))

    await waitFor(() => expect(mocks.park).toHaveBeenCalledWith(handle, null))
    expect(mocks.save).not.toHaveBeenCalled()
    expect(await screen.findByText('folderPick.done')).toBeInTheDocument()
  })
})
