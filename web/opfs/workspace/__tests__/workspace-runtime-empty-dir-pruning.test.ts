import { describe, expect, it, vi } from 'vitest'
import { WorkspaceRuntime } from '../workspace-runtime'

/**
 * Regression: deleteFromFilesDir must prune now-empty parent directories after deleting a file.
 *
 * Background (found during the web/src -> root-level directory migration):
 * - OPFS files/ deletes files but never clears directories -> empty directory trees linger
 * - Empty directories produce no file-level pending op, so the sync layer never sees them
 * - A later flush rebuilds the parent chain from directory entries -> "ghost directories" reappear on disk
 */
describe('deleteFromFilesDir empty-parent pruning', () => {
  type DirEntry = { name: string; kind: 'file' | 'directory' }
  type MockDir = {
    children: Map<string, MockDir | true> // true = 文件
    removeEntry: ReturnType<typeof vi.fn>
    getDirectoryHandle: ReturnType<typeof vi.fn>
    entries: () => AsyncIterable<DirEntry>
  }

  function makeDir(): MockDir {
    const dir = {} as MockDir
    dir.children = new Map()
    dir.removeEntry = vi.fn(async (name: string) => {
      if (!dir.children.has(name)) {
        throw new DOMException('not found', 'NotFoundError')
      }
      dir.children.delete(name)
    })
    dir.getDirectoryHandle = vi.fn(async (name: string) => {
      const child = dir.children.get(name)
      if (child === undefined) {
        throw new DOMException('not found', 'NotFoundError')
      }
      if (child === true) {
        throw new DOMException('type mismatch', 'TypeMismatchError')
      }
      return child
    })
    dir.entries = async function* () {
      for (const [name, node] of dir.children) {
        yield { name, kind: node === true ? ('file' as const) : ('directory' as const) }
      }
    }
    return dir
  }

  function makeRuntime(filesDir: MockDir) {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.filesIndex = new Set<string>(['src/a/b/deep.ts'])
    runtime.getFilesDir = vi.fn(async () => filesDir as unknown as FileSystemDirectoryHandle)
    return runtime
  }

  it('prunes empty parent chain after deleting the deepest file', async () => {
    // files/src/a/b/deep.ts
    const filesDir = makeDir()
    const srcDir = makeDir()
    const aDir = makeDir()
    const bDir = makeDir()
    filesDir.children.set('src', srcDir)
    srcDir.children.set('a', aDir)
    aDir.children.set('b', bDir)
    bDir.children.set('deep.ts', true)

    const runtime = makeRuntime(filesDir)
    await runtime.deleteFromFilesDir('src/a/b/deep.ts')

    expect(filesDir.children.has('src')).toBe(false)
    expect(srcDir.children.size).toBe(0)
    expect(runtime.filesIndex.has('src/a/b/deep.ts')).toBe(false)
  })

  it('stops pruning at the first non-empty ancestor', async () => {
    // files/src/a/b/deep.ts + files/src/a/keep.ts
    const filesDir = makeDir()
    const srcDir = makeDir()
    const aDir = makeDir()
    const bDir = makeDir()
    filesDir.children.set('src', srcDir)
    srcDir.children.set('a', aDir)
    aDir.children.set('b', bDir)
    aDir.children.set('keep.ts', true)
    bDir.children.set('deep.ts', true)

    const runtime = makeRuntime(filesDir)
    await runtime.deleteFromFilesDir('src/a/b/deep.ts')

    // b became empty and is removed; a is kept thanks to keep.ts; the src/a chain survives
    expect(aDir.children.has('b')).toBe(false)
    expect(aDir.children.has('keep.ts')).toBe(true)
    expect(srcDir.children.has('a')).toBe(true)
  })

  it('keeps directories when the deleted file has siblings', async () => {
    // files/src/a.ts + files/src/b.ts
    const filesDir = makeDir()
    const srcDir = makeDir()
    filesDir.children.set('src', srcDir)
    srcDir.children.set('a.ts', true)
    srcDir.children.set('b.ts', true)

    const runtime = makeRuntime(filesDir)
    await runtime.deleteFromFilesDir('src/a.ts')

    expect(srcDir.children.has('a.ts')).toBe(false)
    expect(srcDir.children.has('b.ts')).toBe(true)
    expect(filesDir.children.has('src')).toBe(true)
  })

  it('is a no-op (silently succeeds) when the file does not exist', async () => {
    const filesDir = makeDir()
    const runtime = makeRuntime(filesDir)
    await expect(runtime.deleteFromFilesDir('src/missing.ts')).resolves.toBeUndefined()
    expect(filesDir.children.size).toBe(0)
  })
})
