import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebMcpBackend } from '../backends/webmcp-backend'

interface MockFile {
  kind: 'file'
  data: Blob
}

interface MockDirectory {
  kind: 'directory'
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MockDirectory>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{
    getFile(): Promise<File>
    createWritable(): Promise<{ write(content: string | ArrayBuffer | Blob): Promise<void>; close(): Promise<void> }>
  }>
  removeEntry(name: string): Promise<void>
  entries(): AsyncIterableIterator<[string, MockDirectory | MockFile]>
}

function memoryDirectory(): MockDirectory {
  const children = new Map<string, MockDirectory | MockFile>()
  return {
    kind: 'directory' as const,
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
      let child = children.get(name)
      if (!child && options?.create) {
        child = memoryDirectory()
        children.set(name, child)
      }
      if (!child || child.kind !== 'directory') throw new DOMException('Missing directory', 'NotFoundError')
      return child
    },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      let child = children.get(name)
      if (!child && options?.create) {
        child = { kind: 'file', data: new Blob() }
        children.set(name, child)
      }
      if (!child || child.kind !== 'file') throw new DOMException('Missing file', 'NotFoundError')
      const file = child
      return {
        getFile: async () => new File([file.data], name),
        createWritable: async () => ({
          write: async (content: string | ArrayBuffer | Blob) => {
            file.data = content instanceof Blob ? content : new Blob([content])
          },
          close: async () => {},
        }),
      }
    },
    async removeEntry(name: string) {
      if (!children.delete(name)) throw new DOMException('Missing entry', 'NotFoundError')
    },
    async *entries() {
      yield* children.entries()
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('WebMcpBackend', () => {
  it('maps nested files to the OPFS webmcp directory', async () => {
    const root = memoryDirectory()
    const getDirectory = vi.fn(async () => root)
    vi.stubGlobal('navigator', { storage: { getDirectory } })
    const backend = new WebMcpBackend()

    await backend.writeFile('reports/result.txt', 'hello')
    expect(await backend.readFile('reports/result.txt', { encoding: 'text' })).toMatchObject({
      content: 'hello', source: 'webmcp', size: 5,
    })
    expect(await backend.listDir('reports')).toMatchObject([
      { name: 'result.txt', path: 'reports/result.txt', kind: 'file' },
    ])
    expect(await backend.exists('reports/result.txt')).toBe(true)
    expect((await root.getDirectoryHandle('webmcp')).kind).toBe('directory')
    expect(getDirectory).toHaveBeenCalled()

    await backend.deleteDir('reports')
    expect(await backend.listDir('')).toEqual([])
  })

  it('rejects paths that escape the root', async () => {
    const backend = new WebMcpBackend()
    await expect(backend.writeFile('../outside.txt', 'bad')).rejects.toThrow('Invalid WebMCP path')
  })
})
