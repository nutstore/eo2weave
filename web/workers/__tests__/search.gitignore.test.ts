import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())

it('searches workspace files with .gitignore rules and honors include_ignored', async () => {
  const files: Record<string, string> = { '.gitignore': '*.log\n', 'app.ts': 'needle', 'debug.log': 'needle' }
  const handles = Object.entries(files).map(([name, content]) => ({
    name, kind: 'file', getFile: async () => new File([content], name),
  }))
  const root = { name: 'root', values: async function* () { yield* handles } }
  const postMessage = vi.fn()
  const worker = { postMessage, onmessage: null as null | ((event: unknown) => Promise<void>) }
  vi.stubGlobal('self', worker)
  vi.resetModules()
  await import('@/workers/search.worker')
  await worker.onmessage!({ data: { type: 'SEARCH', payload: { directoryHandle: root, query: 'needle' } } })
  const first = postMessage.mock.calls.at(-1)![0]
  expect(first.payload.results.map((hit: { path: string }) => hit.path)).toEqual(['app.ts'])

  await worker.onmessage!({ data: { type: 'SEARCH', payload: { directoryHandle: root, query: 'needle', includeIgnored: true } } })
  const second = postMessage.mock.calls.at(-1)![0]
  expect(second.payload.results.map((hit: { path: string }) => hit.path)).toEqual(['app.ts', 'debug.log'])
})

it('applies root rules when searching a pending-only directory', async () => {
  const root = {
    name: 'root',
    getFileHandle: async () => ({ getFile: async () => new File(['*.log\n'], '.gitignore') }),
    getDirectoryHandle: async () => { throw new DOMException('missing', 'NotFoundError') },
  }
  const postMessage = vi.fn()
  const worker = { postMessage, onmessage: null as null | ((event: unknown) => Promise<void>) }
  vi.stubGlobal('self', worker)
  vi.resetModules()
  await import('@/workers/search.worker')
  await worker.onmessage!({ data: { type: 'SEARCH', payload: {
    directoryHandle: root, path: 'draft', query: 'needle',
    pendingOverlays: { 'draft/debug.log': { content: 'needle' }, 'draft/app.ts': { content: 'needle' } },
  } } })
  const result = postMessage.mock.calls.at(-1)![0]
  expect(result.payload.results.map((hit: { path: string }) => hit.path)).toEqual(['draft/app.ts'])
})

it('uses a pending .gitignore edit when searching', async () => {
  const files: Record<string, string> = { '.gitignore': '*.log\n', 'app.ts': 'needle', 'debug.log': 'needle' }
  const root = { name: 'root', values: async function* () {
    for (const [name, content] of Object.entries(files)) yield { name, kind: 'file', getFile: async () => new File([content], name) }
  } }
  const postMessage = vi.fn()
  const worker = { postMessage, onmessage: null as null | ((event: unknown) => Promise<void>) }
  vi.stubGlobal('self', worker)
  vi.resetModules()
  await import('@/workers/search.worker')
  await worker.onmessage!({ data: { type: 'SEARCH', payload: {
    directoryHandle: root, query: 'needle', pendingOverlays: { '.gitignore': { content: '*.ts\n' } },
  } } })
  expect(postMessage.mock.calls.at(-1)![0].payload.results.map((hit: { path: string }) => hit.path)).toEqual(['debug.log'])
})
