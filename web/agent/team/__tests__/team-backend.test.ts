import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteExecutor } from '../../tools/delete.tool'
import type { ToolContext } from '../../tools/tool-types'
import type { VfsBackend } from '../../tools/vfs-backend'
import { resolveVfsTarget } from '../../tools/vfs-resolver'
import { TeamBackend } from '../team-backend'

const { getTeamDir } = vi.hoisted(() => ({ getTeamDir: vi.fn() }))

vi.mock('@/opfs', () => ({
  ProjectManager: { create: async () => ({ getTeamDir }) },
}))
vi.mock('@/store/opfs.store', () => ({
  useOPFSStore: { getState: () => ({ getPendingChanges: () => [] }) },
}))

type Tree = { [name: string]: Tree | string }

/** A mutable handle tree that enforces directory removal semantics. */
function directory(tree: Tree, name = 'root'): FileSystemDirectoryHandle {
  return {
    name,
    kind: 'directory',
    async *entries() {
      for (const [entryName, entry] of Object.entries(tree)) {
        yield [entryName, typeof entry === 'string'
          ? { name: entryName, kind: 'file' }
          : directory(entry, entryName)]
      }
    },
    async getDirectoryHandle(entryName: string) {
      const entry = tree[entryName]
      if (entry === undefined) throw new DOMException('Missing entry', 'NotFoundError')
      if (typeof entry === 'string') throw new DOMException('Not a directory', 'TypeMismatchError')
      return directory(entry, entryName)
    },
    async getFileHandle(entryName: string) {
      const entry = tree[entryName]
      if (entry === undefined) throw new DOMException('Missing entry', 'NotFoundError')
      if (typeof entry !== 'string') throw new DOMException('Not a file', 'TypeMismatchError')
      return { name: entryName, kind: 'file', getFile: async () => new File([entry], entryName) }
    },
    async removeEntry(entryName: string, options?: { recursive?: boolean }) {
      const entry = tree[entryName]
      if (entry === undefined) throw new DOMException('Missing entry', 'NotFoundError')
      if (typeof entry !== 'string' && Object.keys(entry).length && !options?.recursive) {
        throw new DOMException('Directory is not empty', 'InvalidModificationError')
      }
      delete tree[entryName]
    },
  } as unknown as FileSystemDirectoryHandle
}

const runKey = 'conv-1-turn-1'
const context: ToolContext = {
  directoryHandle: null,
  projectId: 'project-1',
  currentAgentId: 'member-a',
  teamRunKey: runKey,
  isSubagent: true,
}

describe('TeamBackend directory operations', () => {
  let tree: Tree
  let backend: TeamBackend

  beforeEach(() => {
    tree = {
      'manifest.json': '{}',
      by: {
        'member-a': {
          drafts: { 'outline.md': 'outline', nested: { 'notes.md': 'notes', empty: {} } },
          'keep.md': 'keep',
        },
        'member-b': { 'keep.md': 'keep' },
      },
    }
    const root = directory(tree, runKey)
    backend = TeamBackend.fromDirectory(root)
    getTeamDir.mockResolvedValue(directory({ [runKey]: tree }))
  })

  it('recursively deletes nested files and directories through the delete executor', async () => {
    const result = JSON.parse(await deleteExecutor({
      path: `vfs://team/${runKey}/by/member-a/drafts`,
      recursive: true,
    }, context))

    expect(result.success).toBe(true)
    expect(result.deleted).toEqual(['by/member-a/drafts/outline.md', 'by/member-a/drafts/nested/notes.md'])
    expect(result.deletedDirs).toEqual([
      'by/member-a/drafts/nested/empty',
      'by/member-a/drafts/nested',
      'by/member-a/drafts',
    ])
    expect(tree).toEqual({
      'manifest.json': '{}',
      by: { 'member-a': { 'keep.md': 'keep' }, 'member-b': { 'keep.md': 'keep' } },
    })
  })

  it('expands all nested dry-run targets without deleting them', async () => {
    const result = JSON.parse(await deleteExecutor({
      path: `vfs://team/${runKey}/by/member-a/drafts`,
      recursive: true,
      dry_run: true,
    }, context))

    expect(result.targets).toEqual(expect.arrayContaining([
      'by/member-a/drafts/outline.md',
      'by/member-a/drafts/nested/notes.md',
      'by/member-a/drafts/nested/empty',
      'by/member-a/drafts/nested',
      `vfs://team/${runKey}/by/member-a/drafts`,
    ]))
    await expect(backend.readFile('by/member-a/drafts/nested/notes.md')).resolves.toMatchObject({ content: 'notes' })
  })

  it('keeps shallow listings shallow and respects recursive maximum depth', async () => {
    const path = 'by/member-a/drafts'
    expect((await backend.listDir(path)).map(entry => entry.path)).toEqual([
      `${path}/outline.md`, `${path}/nested`,
    ])
    expect((await backend.listDir(path, { recursive: true, maxDepth: 1 })).map(entry => entry.path))
      .toEqual([`${path}/outline.md`, `${path}/nested`])
    expect((await backend.listDir(path, { recursive: true, maxDepth: 2 })).map(entry => entry.path))
      .toEqual([`${path}/outline.md`, `${path}/nested`, `${path}/nested/notes.md`, `${path}/nested/empty`])
  })

  it('supports deleting a file through the deleteDir contract', async () => {
    await expect((backend as VfsBackend).deleteDir!('by/member-a/keep.md')).resolves.toEqual({
      deletedFiles: ['by/member-a/keep.md'], deletedDirs: [],
    })
    await expect(backend.readFile('by/member-a/keep.md')).rejects.toThrow('Missing entry')
  })

  it('refuses direct deletion of the backend root', async () => {
    await expect((backend as VfsBackend).deleteDir!('')).rejects.toThrow(/root/i)
    expect(tree['manifest.json']).toBe('{}')
  })

  it('rejects recursive deletion outside a member slot before touching storage', async () => {
    getTeamDir.mockClear()
    const result = JSON.parse(await deleteExecutor({
      path: `vfs://team/${runKey}/by/member-b`, recursive: true,
    }, context))

    expect(result.success).toBe(false)
    expect(result.failed[0].error).toContain('PERMISSION_DENIED')
    expect(getTeamDir).not.toHaveBeenCalled()
  })

  it('rejects deleting a run root even when empty paths are explicitly allowed', async () => {
    getTeamDir.mockClear()
    await expect(resolveVfsTarget(`vfs://team/${runKey}`, { ...context, isSubagent: false }, 'delete', {
      allowEmptyPath: true,
    })).rejects.toThrow('PERMISSION_DENIED')
    expect(getTeamDir).not.toHaveBeenCalled()
  })
})
