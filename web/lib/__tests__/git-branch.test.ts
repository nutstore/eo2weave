import { describe, expect, it, vi } from 'vitest'
import { isSameGitBranch, parseGitHead, readGitBranch, readGitBranchViaExecutor } from '@/lib/git-branch'
import type { GitHeadReader } from '@/lib/git-branch'

/** 40-char and 64-char object ids, as git writes them into `.git/HEAD`. */
const SHA1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const SHA256 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'

describe('parseGitHead', () => {
  it('reads a branch checkout', () => {
    expect(parseGitHead('ref: refs/heads/main\n')).toEqual({ kind: 'branch', name: 'main' })
    expect(parseGitHead('ref: refs/heads/feat/xyz')).toEqual({ kind: 'branch', name: 'feat/xyz' })
  })

  it('reads a detached HEAD as a short SHA', () => {
    expect(parseGitHead(`${SHA1}\n`)).toEqual({ kind: 'detached', sha: 'a1b2c3d' })
  })

  it('reads a detached HEAD in a SHA-256 repository', () => {
    expect(parseGitHead(`${SHA256}\n`)).toEqual({ kind: 'detached', sha: 'a1b2c3d' })
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
    expect(parseGitHead('a1b2c3d4')).toBeNull()
  })
})

describe('isSameGitBranch', () => {
  const main = { kind: 'branch', name: 'main' } as const
  const dev = { kind: 'branch', name: 'dev' } as const
  const sha = { kind: 'detached', sha: 'a1b2c3d' } as const

  it('matches equal results across separate reads', () => {
    expect(isSameGitBranch({ kind: 'branch', name: 'main' }, main)).toBe(true)
    expect(isSameGitBranch(sha, { kind: 'detached', sha: 'a1b2c3d' })).toBe(true)
    expect(isSameGitBranch(null, null)).toBe(true)
  })

  it('distinguishes kind and value changes', () => {
    expect(isSameGitBranch(main, dev)).toBe(false)
    expect(isSameGitBranch(main, sha)).toBe(false)
    expect(isSameGitBranch(null, main)).toBe(false)
    expect(isSameGitBranch(main, null)).toBe(false)
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

/** A folder that is not a repository at all: `.git` itself is absent. */
function plainFolderHandle(): FileSystemDirectoryHandle {
  return {
    getDirectoryHandle: vi.fn(async () => {
      throw new DOMException('missing', 'NotFoundError')
    }),
  } as unknown as FileSystemDirectoryHandle
}

describe('readGitBranch', () => {
  it('reads the branch of a work tree', async () => {
    const handle = dirHandle({ HEAD: 'ref: refs/heads/main\n' })
    await expect(readGitBranch(handle)).resolves.toEqual({ kind: 'branch', name: 'main' })
  })

  it('returns null for a folder without .git', async () => {
    await expect(readGitBranch(plainFolderHandle())).resolves.toBeNull()
  })

  it('returns null when .git is a file (worktree / submodule)', async () => {
    const handle = {
      getDirectoryHandle: vi.fn(async () => {
        // A worktree or submodule stores `.git` as a file pointing at another
        // gitdir we cannot resolve through a handle.
        throw new DOMException('not a directory', 'TypeMismatchError')
      }),
    } as unknown as FileSystemDirectoryHandle
    await expect(readGitBranch(handle)).resolves.toBeNull()
  })

  it('returns null when .git lacks a HEAD file', async () => {
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

  it('returns null for an oversized HEAD without reading its text', async () => {
    const longHead = `ref: refs/heads/${'x'.repeat(1024)}\n`
    const file = new File([longHead], 'HEAD')
    const getText = vi.spyOn(file, 'text')
    const handle = {
      getDirectoryHandle: vi.fn(async () => ({
        getFileHandle: vi.fn(async () => ({
          getFile: vi.fn(async () => file),
        })),
      })),
    } as unknown as FileSystemDirectoryHandle
    await expect(readGitBranch(handle)).resolves.toBeNull()
    expect(file.size).toBeGreaterThan(512)
    expect(getText).not.toHaveBeenCalled()
  })
})

/** Native Host roots expose no handle — reads go through the executor. */
function executorReturning(content: string | ArrayBuffer): GitHeadReader {
  return {
    read: vi.fn(async () => ({ content, stat: {} })),
  } as unknown as GitHeadReader
}

describe('readGitBranchViaExecutor', () => {
  it('reads the branch through the disk executor', async () => {
    const executor = executorReturning('ref: refs/heads/main\n')
    await expect(readGitBranchViaExecutor(executor, 'scope-1')).resolves.toEqual({
      kind: 'branch',
      name: 'main',
    })
    expect(executor.read).toHaveBeenCalledWith('scope-1', '.git/HEAD')
  })

  it('decodes binary content', async () => {
    const bytes = new TextEncoder().encode('ref: refs/heads/dev\n')
    await expect(
      readGitBranchViaExecutor(executorReturning(bytes.buffer as ArrayBuffer), 'scope-1')
    ).resolves.toEqual({ kind: 'branch', name: 'dev' })
  })

  it('returns null for an over-long string payload', async () => {
    const executor = executorReturning(`ref: refs/heads/${'y'.repeat(1024)}\n`)
    await expect(readGitBranchViaExecutor(executor, 'scope-1')).resolves.toBeNull()
  })

  it('returns null instead of throwing when the read fails', async () => {
    const executor = {
      read: vi.fn(async () => {
        throw new Error('scope not authorized')
      }),
    } as unknown as GitHeadReader
    await expect(readGitBranchViaExecutor(executor, 'scope-1')).resolves.toBeNull()
  })

  it('returns null without an executor', async () => {
    await expect(readGitBranchViaExecutor(null, 'scope-1')).resolves.toBeNull()
  })

  it('returns null without a root id, without reading', async () => {
    const executor = executorReturning('ref: refs/heads/main\n')
    await expect(readGitBranchViaExecutor(executor, null)).resolves.toBeNull()
    expect(executor.read).not.toHaveBeenCalled()
  })
})
