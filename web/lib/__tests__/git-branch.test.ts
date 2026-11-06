import { describe, expect, it, vi } from 'vitest'
import { parseGitHead, readGitBranch } from '@/lib/git-branch'

describe('parseGitHead', () => {
  it('reads a branch checkout', () => {
    expect(parseGitHead('ref: refs/heads/main\n')).toEqual({ kind: 'branch', name: 'main' })
    expect(parseGitHead('ref: refs/heads/feat/xyz')).toEqual({ kind: 'branch', name: 'feat/xyz' })
  })

  it('reads a detached HEAD as a short SHA', () => {
    expect(parseGitHead('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n')).toEqual({
      kind: 'detached',
      sha: 'a1b2c3d',
    })
  })

  it('ignores refs that are not local branches', () => {
    expect(parseGitHead('ref: refs/tags/v1.0.0')).toBeNull()
    expect(parseGitHead('ref: refs/remotes/origin/main')).toBeNull()
  })

  it('returns null for empty or malformed content', () => {
    expect(parseGitHead('')).toBeNull()
    expect(parseGitHead('   \n')).toBeNull()
    expect(parseGitHead('not a ref')).toBeNull()
    expect(parseGitHead('ref: refs/heads/')).toBeNull()
  })
})

/** Minimal stand-in for the File System Access handles the helper touches. */
function dirHandle(files: Record<string, string>): FileSystemDirectoryHandle {
  return {
    getDirectoryHandle: vi.fn(async (name: string) => {
      if (name !== '.git') throw new DOMException('missing', 'NotFoundError')
      return {
        getFileHandle: vi.fn(async (file: string) => {
          if (!(file in files)) throw new DOMException('missing', 'NotFoundError')
          return { getFile: vi.fn(async () => new File([files[file]], file)) }
        }),
      }
    }),
  } as unknown as FileSystemDirectoryHandle
}

describe('readGitBranch', () => {
  it('reads the branch of a work tree', async () => {
    const handle = dirHandle({ HEAD: 'ref: refs/heads/main\n' })
    await expect(readGitBranch(handle)).resolves.toEqual({ kind: 'branch', name: 'main' })
  })

  it('returns null for a folder without .git', async () => {
    await expect(readGitBranch(dirHandle({}))).resolves.toBeNull()
  })

  it('returns null instead of throwing when the permission lapsed', async () => {
    const handle = {
      getDirectoryHandle: vi.fn(async () => {
        throw new DOMException('denied', 'NotAllowedError')
      }),
    } as unknown as FileSystemDirectoryHandle
    await expect(readGitBranch(handle)).resolves.toBeNull()
  })

  it('returns null when there is no handle at all', async () => {
    await expect(readGitBranch(null)).resolves.toBeNull()
  })
})
