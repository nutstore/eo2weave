import { describe, expect, it } from 'vitest'
import { VfsBridgeFs } from '../just-bash-bridge'
import type { VfsBackend, VfsReadResult, VfsDirEntry } from '../vfs-backend'

// ---------------------------------------------------------------------------
// Mock VfsBackend
// ---------------------------------------------------------------------------

function makeMockBackend(files: Record<string, string | Uint8Array> = {}): VfsBackend {
  const fileMap = new Map(Object.entries(files))
  return {
    label: 'workspace' as const,
    async readFile(path: string, options?: { encoding?: 'text' | 'binary' }): Promise<VfsReadResult> {
      const content = fileMap.get(path)
      if (content === undefined) throw new Error(`ENOENT: '${path}'`)
      if (content instanceof Uint8Array) {
        return {
          content: options?.encoding === 'text' ? new TextDecoder().decode(content) : content,
          size: content.length,
          mimeType: 'application/octet-stream',
        }
      }
      return {
        content: options?.encoding === 'binary' ? new TextEncoder().encode(content) : content,
        size: new TextEncoder().encode(content).length,
        mimeType: 'text/plain',
      }
    },
    async writeFile(path: string, content: string | Uint8Array | ArrayBuffer | Blob): Promise<void> {
      if (typeof content === 'string') {
        fileMap.set(path, content)
        return
      }
      if (content instanceof Uint8Array) {
        fileMap.set(path, content)
        return
      }
      if (content instanceof ArrayBuffer) {
        fileMap.set(path, new Uint8Array(content))
        return
      }
      fileMap.set(path, new Uint8Array(await (content as Blob).arrayBuffer()))
    },
    async deleteFile(path: string): Promise<void> {
      if (!fileMap.has(path)) throw new Error(`ENOENT: '${path}'`)
      fileMap.delete(path)
    },
    async listDir(path: string): Promise<VfsDirEntry[]> {
      const prefix = path ? `${path}/` : ''
      const entries = new Map<string, VfsDirEntry>()
      for (const key of fileMap.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const name = rest.split('/')[0]
        if (!name || !rest.includes('/', name.length)) {
          entries.set(name, { name, path: `${prefix}${name}`, kind: 'file' })
        }
      }
      return Array.from(entries.values())
    },
    async exists(path: string): Promise<boolean> {
      return fileMap.has(path)
    },
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe('VfsBridgeFs path routing', () => {
  it('hides ignored files in directory listings while allowing explicit reads', async () => {
    const backend = makeMockBackend({ 'root/.gitignore': '*.log\n', 'root/debug.log': 'secret', 'root/app.ts': 'source' })
    const bridge = new VfsBridgeFs(backend, ['root'])
    expect(await bridge.readdir('/workspace/root')).toEqual(expect.arrayContaining(['app.ts']))
    expect(await bridge.readdir('/workspace/root')).not.toContain('debug.log')
    expect(await bridge.readFile('/workspace/root/debug.log')).toBe('secret')
  })
  it('routes /workspace/<root>/file.txt to backend as "<root>/file.txt"', async () => {
    const backend = makeMockBackend({ 'myroot/src/app.ts': 'content' })
    const bridge = new VfsBridgeFs(backend, ['myroot'])
    const content = await bridge.readFile('/workspace/myroot/src/app.ts')
    expect(content).toBe('content')
  })

  it('lists root names at /workspace', async () => {
    const backend = makeMockBackend()
    const bridge = new VfsBridgeFs(backend, ['rootA', 'rootB'])
    const entries = await bridge.readdir('/workspace')
    expect(entries).toEqual(['rootA', 'rootB'])
  })

  it('routes /assets/file.txt to assetsBackend', async () => {
    const workspaceBackend = makeMockBackend()
    const assetsBackend = makeMockBackend({ 'report.pdf': 'pdf-data' })
    const bridge = new VfsBridgeFs(workspaceBackend, ['root'], assetsBackend)

    const content = await bridge.readFile('/assets/report.pdf')
    expect(content).toBe('pdf-data')
  })

  it('throws ENOENT for /assets when no assetsBackend', async () => {
    const backend = makeMockBackend()
    const bridge = new VfsBridgeFs(backend, ['root'])
    await expect(bridge.readFile('/assets/missing.txt')).rejects.toThrow('ENOENT')
  })

  it('routes /agents/SOUL.md to agentBackend', async () => {
    const workspaceBackend = makeMockBackend()
    const agentBackend = makeMockBackend({ 'SOUL.md': 'agent-soul' })
    const bridge = new VfsBridgeFs(workspaceBackend, ['root'], undefined, agentBackend)

    const content = await bridge.readFile('/agents/SOUL.md')
    expect(content).toBe('agent-soul')
  })

  it('denies subagents access to protected files through the /agents mount', async () => {
    const workspaceBackend = makeMockBackend()
    const agentBackend = makeMockBackend({ 'SOUL.md': 'agent-soul' })
    const bridge = new VfsBridgeFs(
      workspaceBackend,
      ['root'],
      undefined,
      agentBackend,
      { restrictAgentCoreFiles: true }
    )

    await expect(bridge.readFile('/agents/SOUL.md')).rejects.toThrow('EACCES')
    await expect(bridge.readdir('/agents')).rejects.toThrow('EACCES')
  })

  it('throws ENOENT for /agents when no agentBackend', async () => {
    const backend = makeMockBackend()
    const bridge = new VfsBridgeFs(backend, ['root'])
    await expect(bridge.readFile('/agents/SOUL.md')).rejects.toThrow('ENOENT')
  })
})

// ---------------------------------------------------------------------------
// normalizeAbsolutePath (tested indirectly via resolvePath)
// ---------------------------------------------------------------------------

describe('VfsBridgeFs path normalization', () => {
  it('resolves .. correctly', async () => {
    const backend = makeMockBackend({ 'myroot/a.txt': 'hello' })
    const bridge = new VfsBridgeFs(backend, ['myroot'])
    const resolved = bridge.resolvePath('/workspace/myroot/sub', '../a.txt')
    expect(resolved).toBe('/workspace/myroot/a.txt')
  })

  it('resolves absolute paths as-is', async () => {
    const backend = makeMockBackend()
    const bridge = new VfsBridgeFs(backend, ['root'])
    const resolved = bridge.resolvePath('/workspace/root/sub', '/workspace/root/other.txt')
    expect(resolved).toBe('/workspace/root/other.txt')
  })

  it('collapses multiple slashes', () => {
    const backend = makeMockBackend()
    const bridge = new VfsBridgeFs(backend, ['root'])
    const resolved = bridge.resolvePath('/', '//workspace///root//file.txt')
    expect(resolved).toBe('/workspace/root/file.txt')
  })
})

// ---------------------------------------------------------------------------
// System filesystem (in-memory)
// ---------------------------------------------------------------------------

describe('VfsBridgeFs system paths', () => {
  it('reads /dev/null as empty string', async () => {
    const backend = makeMockBackend()
    const bridge = new VfsBridgeFs(backend, ['root'])
    const content = await bridge.readFile('/dev/null')
    expect(content).toBe('')
  })

  it('writes to /tmp stay in memory', async () => {
    const backend = makeMockBackend()
    const bridge = new VfsBridgeFs(backend, ['root'])
    await bridge.writeFile('/tmp/test.txt', 'temp data')
    const content = await bridge.readFile('/tmp/test.txt')
    expect(content).toBe('temp data')
  })

  it('/dev/null silently consumes writes', async () => {
    const backend = makeMockBackend()
    const bridge = new VfsBridgeFs(backend, ['root'])
    await bridge.writeFile('/dev/null', 'should disappear')
    const content = await bridge.readFile('/dev/null')
    expect(content).toBe('')
  })

  it('lists system directories', async () => {
    const backend = makeMockBackend()
    const bridge = new VfsBridgeFs(backend, ['root'])
    await bridge.writeFileSync('/bin/bash', '#!/bin/bash')
    const entries = await bridge.readdir('/bin')
    expect(entries).toContain('bash')
  })
})

// ---------------------------------------------------------------------------
// Read-only mode
// ---------------------------------------------------------------------------

describe('VfsBridgeFs read-only mode', () => {
  it('allows reads in read-only mode', async () => {
    const backend = makeMockBackend({ 'myroot/file.txt': 'data' })
    const bridge = new VfsBridgeFs(backend, ['myroot'], undefined, undefined, { readOnly: true })
    const content = await bridge.readFile('/workspace/myroot/file.txt')
    expect(content).toBe('data')
  })

  it('blocks workspace writes in read-only mode', async () => {
    const backend = makeMockBackend()
    const bridge = new VfsBridgeFs(backend, ['myroot'], undefined, undefined, { readOnly: true })
    await expect(bridge.writeFile('/workspace/myroot/new.txt', 'data'))
      .rejects.toThrow('write blocked')
  })

  it('blocks workspace appends in read-only mode', async () => {
    const backend = makeMockBackend({ 'myroot/file.txt': 'data' })
    const bridge = new VfsBridgeFs(backend, ['myroot'], undefined, undefined, { readOnly: true })
    await expect(bridge.appendFile('/workspace/myroot/file.txt', 'more'))
      .rejects.toThrow('append blocked')
  })

  it('blocks workspace deletes in read-only mode', async () => {
    const backend = makeMockBackend({ 'myroot/file.txt': 'data' })
    const bridge = new VfsBridgeFs(backend, ['myroot'], undefined, undefined, { readOnly: true })
    await expect(bridge.rm('/workspace/myroot/file.txt'))
      .rejects.toThrow('delete blocked')
  })

  it('allows system writes even in read-only mode', async () => {
    const backend = makeMockBackend()
    const bridge = new VfsBridgeFs(backend, ['myroot'], undefined, undefined, { readOnly: true })
    // System paths should still be writable (needed by just-bash internals)
    await bridge.writeFile('/tmp/script.sh', '#!/bin/bash')
    const content = await bridge.readFile('/tmp/script.sh')
    expect(content).toBe('#!/bin/bash')
  })
})

// ---------------------------------------------------------------------------
// appendFile
// ---------------------------------------------------------------------------

describe('VfsBridgeFs appendFile', () => {
  it('appends to existing workspace file', async () => {
    const backend = makeMockBackend({ 'myroot/log.txt': 'line1\n' })
    const bridge = new VfsBridgeFs(backend, ['myroot'])
    await bridge.appendFile('/workspace/myroot/log.txt', 'line2\n')
    const content = await bridge.readFile('/workspace/myroot/log.txt')
    expect(content).toBe('line1\nline2\n')
  })

  it('creates file if not exists', async () => {
    const backend = makeMockBackend()
    const bridge = new VfsBridgeFs(backend, ['myroot'])
    await bridge.appendFile('/workspace/myroot/new.txt', 'first line')
    const content = await bridge.readFile('/workspace/myroot/new.txt')
    expect(content).toBe('first line')
  })

  it('appends latin1-shaped bytes correctly in binary mode', async () => {
    // Binary-mode contract from just-bash: when encoding === 'binary', the
    // string content is latin1-shaped (each char's low byte IS one file byte).
    // '周报\n' in UTF-8 is the bytes [E5 91 A8 E6 8A A5 0A]. To pass that as a
    // latin1-shaped string we use String.fromCharCode so each char's low byte
    // matches the desired file byte.
    const utf8BytesForZhouBao = [0xE5, 0x91, 0xA8, 0xE6, 0x8A, 0xA5, 0x0A]
    const latin1 = String.fromCharCode(...utf8BytesForZhouBao)

    const encoder = new TextEncoder()
    const backend = makeMockBackend({ 'myroot/log.txt': encoder.encode('中文\n') })
    const bridge = new VfsBridgeFs(backend, ['myroot'])

    await bridge.appendFile('/workspace/myroot/log.txt', latin1, 'binary')

    const content = await bridge.readFile('/workspace/myroot/log.txt')
    expect(content).toBe('中文\n周报\n')
  })
})

// ---------------------------------------------------------------------------
// UTF-8 / binary writeback
// ---------------------------------------------------------------------------

describe('VfsBridgeFs UTF-8 binary writeback', () => {
  it('writes latin1-shaped bytes correctly in binary mode', async () => {
    const bridge = new VfsBridgeFs(makeMockBackend(), ['myroot'])

    // See comment above — 'binary' mode receives a latin1-shaped string, not
    // a JS UTF-16 string with multi-byte chars.
    const utf8Bytes = Array.from(new TextEncoder().encode('中文测试 周报\n'))
    const latin1 = String.fromCharCode(...utf8Bytes)

    await bridge.writeFile('/workspace/myroot/report.txt', latin1, 'binary')

    const bytes = await bridge.readFileBuffer('/workspace/myroot/report.txt')
    expect(Array.from(bytes)).toEqual(utf8Bytes)
  })
})

// ---------------------------------------------------------------------------
// End-to-end: just-bash 3.0.2 + VfsBridgeFs UTF-8/CJK roundtrip
// ---------------------------------------------------------------------------
//
// These tests pin down the bash.tool.ts description claim that
// `cat src > dst`, `cat src >> dst`, and `$(cat file)` all preserve UTF-8
// correctly with just-bash 3.0.2. If a future just-bash upgrade regresses,
// these will fail before the agent gets a chance to corrupt user files.

describe('VfsBridgeFs + just-bash end-to-end CJK roundtrip', () => {
  // Load just-bash dynamically — same trick as bash.tool.ts uses to avoid
  // rollup pulling node:zlib into the PWA bundle.
  async function loadBash(): Promise<{ Bash: any }> {
    return (await import('just-bash')) as { Bash: any }
  }

  // Helper: build a bridge with a UTF-8 file pre-loaded.
  function bridgeWith(content: string, file = 'src.txt'): VfsBridgeFs {
    const backend = makeMockBackend({
      [`myroot/${file}`]: new TextEncoder().encode(content),
    })
    return new VfsBridgeFs(backend, ['myroot'])
  }

  it('`cat src > dst` preserves UTF-8 bytes', async () => {
    const { Bash } = await loadBash()
    const bridge = bridgeWith('中文 hello 周报\n')
    const bash = new Bash({ fs: bridge as any, cwd: '/workspace/myroot' })
    const result = await bash.exec('cat src.txt > dst.txt')
    expect(result.exitCode).toBe(0)

    const written = await bridge.readFileBuffer('/workspace/myroot/dst.txt')
    expect(Array.from(written)).toEqual(
      Array.from(new TextEncoder().encode('中文 hello 周报\n'))
    )
  })

  it('`cat src >> dst` appends UTF-8 bytes correctly', async () => {
    const { Bash } = await loadBash()
    const encoder = new TextEncoder()
    const backend = makeMockBackend({
      'myroot/dst.txt': encoder.encode('first 周报\n'),
      'myroot/src.txt': encoder.encode('second 中文\n'),
    })
    const bridge = new VfsBridgeFs(backend, ['myroot'])
    const bash = new Bash({ fs: bridge as any, cwd: '/workspace/myroot' })
    const result = await bash.exec('cat src.txt >> dst.txt')
    expect(result.exitCode).toBe(0)

    const written = await bridge.readFileBuffer('/workspace/myroot/dst.txt')
    expect(Array.from(written)).toEqual(
      Array.from(encoder.encode('first 周报\nsecond 中文\n'))
    )
  })

  it('command substitution `$(cat file)` returns UTF-8 text', async () => {
    const { Bash } = await loadBash()
    const bridge = bridgeWith('中文 周报')
    const bash = new Bash({ fs: bridge as any, cwd: '/workspace/myroot' })
    const result = await bash.exec('echo "$(cat src.txt)"')
    expect(result.exitCode).toBe(0)
    // stdout for echo round-trips correctly: the text was UTF-8 on disk,
    // survived the bash pipeline, and comes back as the same UTF-8 text.
    expect(result.stdout).toBe('中文 周报\n')
  })

  it('`uniq src > dst` (text processing pipeline) preserves UTF-8', async () => {
    // uniq reads lines, dedupes, writes — exercises the text-mode path
    // through cat's output redirect.
    const { Bash } = await loadBash()
    const bridge = bridgeWith('中文\n中文\n周报\n')
    const bash = new Bash({ fs: bridge as any, cwd: '/workspace/myroot' })
    const result = await bash.exec('uniq src.txt > out.txt')
    expect(result.exitCode).toBe(0)

    const written = await bridge.readFileBuffer('/workspace/myroot/out.txt')
    expect(Array.from(written)).toEqual(
      Array.from(new TextEncoder().encode('中文\n周报\n'))
    )
  })
})

// ---------------------------------------------------------------------------
// stat
// ---------------------------------------------------------------------------

describe('VfsBridgeFs stat', () => {
  it('stats a workspace file', async () => {
    const backend = makeMockBackend({ 'myroot/app.ts': 'export default {}' })
    const bridge = new VfsBridgeFs(backend, ['myroot'])
    const stat = await bridge.stat('/workspace/myroot/app.ts')
    expect(stat.isFile).toBe(true)
    expect(stat.isDirectory).toBe(false)
  })

  it('stats a system directory', async () => {
    const backend = makeMockBackend()
    const bridge = new VfsBridgeFs(backend, ['root'])
    const stat = await bridge.stat('/tmp')
    expect(stat.isFile).toBe(false)
    expect(stat.isDirectory).toBe(true)
  })

  it('throws ENOENT for non-existent file', async () => {
    const backend = makeMockBackend()
    const bridge = new VfsBridgeFs(backend, ['root'])
    await expect(bridge.stat('/workspace/root/missing.txt')).rejects.toThrow('ENOENT')
  })
})

// ---------------------------------------------------------------------------
// cp / mv
// ---------------------------------------------------------------------------

describe('VfsBridgeFs cp', () => {
  it('copies workspace file to another path', async () => {
    const backend = makeMockBackend({ 'myroot/a.txt': 'hello' })
    const bridge = new VfsBridgeFs(backend, ['myroot'])
    await bridge.cp('/workspace/myroot/a.txt', '/workspace/myroot/b.txt')
    const content = await bridge.readFile('/workspace/myroot/b.txt')
    expect(content).toBe('hello')
  })

  it('throws when source does not exist', async () => {
    const backend = makeMockBackend()
    const bridge = new VfsBridgeFs(backend, ['myroot'])
    await expect(bridge.cp('/workspace/myroot/missing.txt', '/workspace/myroot/dest.txt'))
      .rejects.toThrow()
  })
})

describe('VfsBridgeFs mv', () => {
  it('moves workspace file (copy + delete)', async () => {
    const backend = makeMockBackend({ 'myroot/a.txt': 'data' })
    const bridge = new VfsBridgeFs(backend, ['myroot'])
    await bridge.mv('/workspace/myroot/a.txt', '/workspace/myroot/b.txt')
    const content = await bridge.readFile('/workspace/myroot/b.txt')
    expect(content).toBe('data')
    await expect(bridge.readFile('/workspace/myroot/a.txt')).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// exists
// ---------------------------------------------------------------------------

describe('VfsBridgeFs exists', () => {
  it('returns true for existing workspace file', async () => {
    const backend = makeMockBackend({ 'myroot/file.txt': 'data' })
    const bridge = new VfsBridgeFs(backend, ['myroot'])
    expect(await bridge.exists('/workspace/myroot/file.txt')).toBe(true)
  })

  it('returns false for non-existent file', async () => {
    const backend = makeMockBackend()
    const bridge = new VfsBridgeFs(backend, ['myroot'])
    expect(await bridge.exists('/workspace/myroot/missing.txt')).toBe(false)
  })

  it('returns true for system directories', async () => {
    const backend = makeMockBackend()
    const bridge = new VfsBridgeFs(backend, ['root'])
    expect(await bridge.exists('/tmp')).toBe(true)
    expect(await bridge.exists('/dev')).toBe(true)
    expect(await bridge.exists('/bin')).toBe(true)
  })
})
