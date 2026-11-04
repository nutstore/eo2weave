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
