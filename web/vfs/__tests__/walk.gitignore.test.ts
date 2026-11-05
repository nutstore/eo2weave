import { describe, expect, it } from 'vitest'
import type { VfsBackend, VfsDirEntry } from '@/agent/tools/vfs-backend'
import { walkBackend } from '@/vfs/walk'

const files: Record<string, string> = {
  '.gitignore': '*.log\noutput/\n',
  'src/.gitignore': '*.tmp\n',
  'src/keep.ts': 'hello',
  'src/private.tmp': 'hidden',
  'src/debug.log': 'hidden',
  'debug.log': 'hidden',
  'output/generated.js': 'hidden',
}

const backend = {
  label: 'workspace',
  async readFile(path: string) {
    if (!(path in files)) throw new Error('not found')
    return { content: files[path], size: files[path].length, mimeType: 'text/plain' }
  },
  async listDir(path: string): Promise<VfsDirEntry[]> {
    const prefix = path ? `${path}/` : ''
    const entries = new Map<string, VfsDirEntry>()
    for (const file of Object.keys(files)) {
      if (!file.startsWith(prefix)) continue
      const [name, ...rest] = file.slice(prefix.length).split('/')
      if (name) entries.set(name, { name, path: prefix + name, kind: rest.length ? 'directory' : 'file' })
    }
    return [...entries.values()]
  },
} as VfsBackend

async function walk(includeIgnored = false): Promise<string[]> {
  const paths: string[] = []
  for await (const entry of walkBackend(backend, '', { maxDepth: 10, deadlineAt: Date.now() + 5000, includeIgnored })) paths.push(entry.relativePath)
  return paths
}

describe('workspace discovery .gitignore', () => {
  it('filters ignored files and directories using root and nested rules', async () => {
    const paths = await walk()
    expect(paths).toContain('src/keep.ts')
    expect(paths).not.toContain('debug.log')
    expect(paths).not.toContain('src/private.tmp')
    expect(paths).not.toContain('output')
  })

  it('includes ignored paths when requested', async () => {
    expect(await walk(true)).toEqual(expect.arrayContaining(['debug.log', 'src/private.tmp', 'output/generated.js']))
  })

  it('applies parent ignore rules when starting in a subdirectory', async () => {
    const paths: string[] = []
    for await (const entry of walkBackend(backend, 'src', { maxDepth: 10, deadlineAt: Date.now() + 5000 })) paths.push(entry.relativePath)
    expect(paths).toContain('keep.ts')
    expect(paths).not.toContain('debug.log')
  })
})
