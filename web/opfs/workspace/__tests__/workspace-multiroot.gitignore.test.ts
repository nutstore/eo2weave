import { describe, expect, it, vi } from 'vitest'
import { scanDiskTreeImpl, type WorkspaceRuntimeInternals } from '@/opfs/workspace/workspace-multiroot'

const disk = {
  listDir: vi.fn(async (_root: string, path: string) => {
    if (!path) return [
      { name: '.gitignore', kind: 'file' },
      { name: 'debug.log', kind: 'file' },
      { name: 'src', kind: 'directory' },
    ]
    return [{ name: 'ok.ts', kind: 'file' }, { name: 'nested.log', kind: 'file' }]
  }),
  read: vi.fn(async () => ({ content: '*.log\n' })),
}

const runtime = {
  initialized: true,
  resolvePath: async () => ({ backend: 'native-host', rootId: 'root', relativePath: '' }),
  diskExec: disk,
} as unknown as WorkspaceRuntimeInternals

describe('native host discovery .gitignore', () => {
  it('filters ignored paths when requested and leaves other callers unchanged', async () => {
    const filtered = await scanDiskTreeImpl(runtime, '', 5, null, { respectGitignore: true })
    expect(filtered?.map((entry) => entry.path)).toEqual(['.gitignore', 'src', 'src/ok.ts'])
    const unfiltered = await scanDiskTreeImpl(runtime, '', 5)
    expect(unfiltered?.map((entry) => entry.path)).toContain('debug.log')
  })
})
