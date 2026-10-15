import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Exercise persistence keys and transactional consumption without adding an IDB dependency.
type Row = Record<string, unknown>
let rows: Map<string, Row>
beforeEach(() => {
  vi.resetModules()
  rows = new Map()
  vi.stubGlobal('indexedDB', {
    open(name: string) {
      const request: any = {}
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: { contains: () => name !== 'app-dir-handle' }, close() {},
          transaction() {
            const tx: any = {}
            let pending = 0
            const operation = (work: () => unknown) => {
              const op: any = {}
              pending++
              queueMicrotask(() => {
                op.result = work()
                op.onsuccess?.()
                if (--pending === 0) queueMicrotask(() => tx.oncomplete?.())
              })
              return op
            }
            tx.objectStore = () => ({
              get: (key: string) => operation(() => rows.get(key)),
              put: (row: Row) => operation(() => rows.set(row._compoundKey as string, row)),
              delete: (key: string) => operation(() => rows.delete(key)),
            })
            return tx
          },
        }
        request.onsuccess?.()
      })
      return request
    },
  })
})
afterEach(() => vi.unstubAllGlobals())

const directory = () => ({ name: 'photos', kind: 'directory' }) as FileSystemDirectoryHandle
describe('pending folder handoff persistence', () => {
  it('keeps the original mounted handle when a same-name pending handle is consumed and rejected', async () => {
    const { folderAccessRepo: repo } = await import('../folder-access.repository')
    const original = directory()
    const picked = directory()
    rows.set('project/photos', { _compoundKey: 'project/photos', projectId: 'project', rootName: 'photos', persistedHandle: original })
    const pickId = await repo.saveParkedHandle(picked, 'project')
    expect((await repo.findByProjectAndRoot('project', 'photos'))?.persistedHandle).toBe(original)
    expect(await repo.takeParkedHandle(pickId, 'project', 'photos')).toBe(picked)
    expect((await repo.findByProjectAndRoot('project', 'photos'))?.persistedHandle).toBe(original)
    expect(await repo.takeParkedHandle(pickId, 'project', 'photos')).toBeNull()
  })

  it('isolates simultaneous picks and leaves mismatched project/name handoffs unconsumed', async () => {
    const { folderAccessRepo: repo } = await import('../folder-access.repository')
    const first = directory()
    const second = directory()
    const firstId = await repo.saveParkedHandle(first, 'project')
    const secondId = await repo.saveParkedHandle(second, 'project')
    expect(firstId).not.toBe(secondId)
    expect(await repo.takeParkedHandle(firstId, 'other-project', 'photos')).toBeNull()
    expect(await repo.takeParkedHandle(firstId, 'project', 'wrong-name')).toBeNull()
    expect(await repo.takeParkedHandle(firstId, 'project', 'photos')).toBe(first)
    expect(await repo.takeParkedHandle(secondId, 'project', 'photos')).toBe(second)
  })

  it('retains root-route picks without assigning them to an existing root record', async () => {
    const { folderAccessRepo: repo } = await import('../folder-access.repository')
    const picked = directory()
    const pickId = await repo.saveParkedHandle(picked, null)
    expect(await repo.takeParkedHandle(pickId, 'project', 'photos')).toBeNull()
    expect(await repo.takeParkedHandle(pickId, null, 'photos')).toBe(picked)
  })
})
