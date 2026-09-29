import { describe, expect, it } from 'vitest'
import { WorkerVfsBridgeFs } from '../bash-worker/worker-vfs-bridge'
import type { VfsRpcRequest, VfsRpcResponse } from '../bash-worker/protocol'
import { latin1StringToBytes, bytesToLatin1String } from '../bash-worker/bridge-shared'

// ---------------------------------------------------------------------------
// Mock RPC invoker — captures requests and returns canned responses
// ---------------------------------------------------------------------------

function makeMockRpc(
  handlers: Partial<Record<string, (req: VfsRpcRequest) => VfsRpcResponse['result']>> = {},
) {
  const calls: VfsRpcRequest[] = []
  const invoker = async (req: VfsRpcRequest): Promise<VfsRpcResponse> => {
    calls.push(req)
    const handler = handlers[req.method]
    if (handler) {
      const result = handler(req)
      return { type: 'vfs-result', rpcId: req.rpcId, ok: true, result }
    }
    return { type: 'vfs-result', rpcId: req.rpcId, ok: false, error: `no mock for ${req.method}` }
  }
  return { invoker, calls }
}

// ---------------------------------------------------------------------------
// Round-trip mock RPC — mirrors vfs-rpc-handler.ts encoding semantics
// ---------------------------------------------------------------------------
//
// Reproduces the main-thread handler's real encoding behavior so binary
// corruption regressions are caught here rather than in production:
// - readFile     → handler forces encoding:'text' (lossy TextDecoder → U+FFFD
//                   replacement chars for non-UTF-8 bytes)
// - readFileBuffer → handler reads binary and returns a latin1-shaped string
//                   (byte-safe channel)
// - writeFile    → handler honors encoding:'binary' (latin1 → bytes);
//                   otherwise UTF-8-encodes the string

function makeRoundTripRpc(
  stores: Partial<Record<'workspace' | 'assets' | 'agent', Map<string, Uint8Array>>>,
) {
  const decoder = new TextDecoder() // non-fatal: invalid bytes → U+FFFD (like decodeToString)
  const calls: VfsRpcRequest[] = []
  const invoker = async (req: VfsRpcRequest): Promise<VfsRpcResponse> => {
    calls.push(req)
    const store = stores[req.backend]
    if (!store) {
      return { type: 'vfs-result', rpcId: req.rpcId, ok: false, error: `no store for ${req.backend}` }
    }
    switch (req.method) {
      case 'readFile': {
        const bytes = store.get(req.path)
        if (!bytes) return { type: 'vfs-result', rpcId: req.rpcId, ok: false, error: 'ENOENT' }
        return { type: 'vfs-result', rpcId: req.rpcId, ok: true, result: decoder.decode(bytes) }
      }
      case 'readFileBuffer': {
        const bytes = store.get(req.path)
        if (!bytes) return { type: 'vfs-result', rpcId: req.rpcId, ok: false, error: 'ENOENT' }
        return { type: 'vfs-result', rpcId: req.rpcId, ok: true, result: bytesToLatin1String(bytes) }
      }
      case 'writeFile': {
        const content = req.content ?? ''
        store.set(
          req.path,
          req.encoding === 'binary'
            ? latin1StringToBytes(content)
            : new TextEncoder().encode(content),
        )
        return { type: 'vfs-result', rpcId: req.rpcId, ok: true, result: undefined }
      }
      case 'stat': {
        const isFile = store.has(req.path)
        return {
          type: 'vfs-result',
          rpcId: req.rpcId,
          ok: true,
          result: {
            isFile,
            isDirectory: !isFile,
            isSymbolicLink: false,
            mode: 0o644,
            size: isFile ? store.get(req.path)!.length : 0,
            mtime: Date.now(),
          },
        }
      }
      case 'readdirWithFileTypes': {
        const prefix = req.path ? `${req.path}/` : ''
        const names = new Set<string>()
        for (const key of store.keys()) {
          if (!key.startsWith(prefix)) continue
          const name = key.slice(prefix.length).split('/')[0]
          if (name) names.add(name)
        }
        const entries = Array.from(names).map(name => {
          const isDir = Array.from(store.keys()).some(k => k.startsWith(`${prefix}${name}/`))
          return { name, isFile: !isDir, isDirectory: isDir, isSymbolicLink: false }
        })
        return { type: 'vfs-result', rpcId: req.rpcId, ok: true, result: entries }
      }
      case 'rm': {
        store.delete(req.path)
        return { type: 'vfs-result', rpcId: req.rpcId, ok: true, result: undefined }
      }
      default:
        return { type: 'vfs-result', rpcId: req.rpcId, ok: false, error: `no mock for ${req.method}` }
    }
  }
  return { invoker, calls }
}

describe('WorkerVfsBridgeFs', () => {
  // -------------------------------------------------------------------------
  // System filesystem (in-memory)
  // -------------------------------------------------------------------------

  it('reads and writes system files locally (no RPC)', async () => {
    const { invoker, calls } = makeMockRpc()
    const fs = new WorkerVfsBridgeFs(invoker, ['root'], false, false, {
      readOnly: false,
      restrictAgentCoreFiles: false,
    })

    fs.writeFileSync('/bin/echo', 'echo stub')
    const content = await fs.readFile('/bin/echo')
    expect(content).toBe('echo stub')
    expect(calls.length).toBe(0) // no RPC needed
  })

  it('creates /dev/null as a black hole', async () => {
    const { invoker } = makeMockRpc()
    const fs = new WorkerVfsBridgeFs(invoker, ['root'], false, false, {
      readOnly: false,
      restrictAgentCoreFiles: false,
    })

    // Write to /dev/null is silently consumed
    await fs.writeFile('/dev/null', 'anything')
    // /dev/null exists in sysFs
    expect(await fs.exists('/dev/null')).toBe(true)
    const content = await fs.readFile('/dev/null')
    expect(content).toBe('')
  })

  it('lists system directories', async () => {
    const { invoker } = makeMockRpc()
    const fs = new WorkerVfsBridgeFs(invoker, ['root'], false, false, {
      readOnly: false,
      restrictAgentCoreFiles: false,
    })

    const entries = await fs.readdirWithFileTypes('/bin')
    // /bin exists (created in constructor)
    expect(entries.some(e => e.name === 'bin')).toBe(false) // /bin itself
    // Root listing
    const rootEntries = await fs.readdirWithFileTypes('/')
    expect(rootEntries.some(e => e.name === 'bin')).toBe(true)
    expect(rootEntries.some(e => e.name === 'workspace')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Workspace routing (RPC)
  // -------------------------------------------------------------------------

  it('routes workspace reads to RPC with correct relative path', async () => {
    const { invoker, calls } = makeMockRpc({
      readFile: (req) => `content of ${req.path}`,
    })
    const fs = new WorkerVfsBridgeFs(invoker, ['myroot'], false, false, {
      readOnly: false,
      restrictAgentCoreFiles: false,
    })

    const content = await fs.readFile('/workspace/myroot/src/app.ts')
    expect(content).toBe('content of myroot/src/app.ts')
    expect(calls[0].backend).toBe('workspace')
    expect(calls[0].path).toBe('myroot/src/app.ts')
  })

  it('lists workspace root names from readdir', async () => {
    const { invoker } = makeMockRpc()
    const fs = new WorkerVfsBridgeFs(invoker, ['rootA', 'rootB'], false, false, {
      readOnly: false,
      restrictAgentCoreFiles: false,
    })

    const entries = await fs.readdirWithFileTypes('/workspace')
    const names = entries.map(e => e.name)
    expect(names).toContain('rootA')
    expect(names).toContain('rootB')
  })

  it('routes workspace writes to RPC with content', async () => {
    const { invoker, calls } = makeMockRpc({
      writeFile: () => undefined,
    })
    const fs = new WorkerVfsBridgeFs(invoker, ['root'], false, false, {
      readOnly: false,
      restrictAgentCoreFiles: false,
    })

    await fs.writeFile('/workspace/root/file.txt', 'hello')
    expect(calls[0].backend).toBe('workspace')
    expect(calls[0].path).toBe('root/file.txt')
    expect(calls[0].content).toBe('hello')
    expect(calls[0].encoding).toBe('text')
  })

  // -------------------------------------------------------------------------
  // Assets routing
  // -------------------------------------------------------------------------

  it('routes assets paths to assets backend', async () => {
    const { invoker, calls } = makeMockRpc({
      readFile: (req) => `asset:${req.path}`,
    })
    const fs = new WorkerVfsBridgeFs(invoker, ['root'], true, false, {
      readOnly: false,
      restrictAgentCoreFiles: false,
    })

    const content = await fs.readFile('/assets/data.csv')
    expect(content).toBe('asset:data.csv')
    expect(calls[0].backend).toBe('assets')
    expect(calls[0].path).toBe('data.csv')
  })

  // -------------------------------------------------------------------------
  // Agent routing + permission checks
  // -------------------------------------------------------------------------

  it('routes agent paths to agent backend', async () => {
    const { invoker, calls } = makeMockRpc({
      readFile: (req) => `agent:${req.path}`,
    })
    const fs = new WorkerVfsBridgeFs(invoker, ['root'], false, true, {
      readOnly: false,
      restrictAgentCoreFiles: false,
    })

    const content = await fs.readFile('/agents/IDENTITY.md')
    expect(content).toBe('agent:IDENTITY.md')
    expect(calls[0].backend).toBe('agent')
  })

  it('routes WebMCP files to the WebMCP backend', async () => {
    const { invoker, calls } = makeMockRpc({ readFile: (req) => `webmcp:${req.path}` })
    const fs = new WorkerVfsBridgeFs(invoker, ['root'], false, false, {
      readOnly: false,
      restrictAgentCoreFiles: false,
    })

    expect(await fs.readFile('/webmcp/reports/result.txt')).toBe('webmcp:reports/result.txt')
    expect(calls[0].backend).toBe('webmcp')
    expect(calls[0].path).toBe('reports/result.txt')
  })

  it('blocks subagent access to protected core files', async () => {
    const { invoker } = makeMockRpc()
    const fs = new WorkerVfsBridgeFs(invoker, ['root'], false, true, {
      readOnly: false,
      restrictAgentCoreFiles: true,
    })

    await expect(fs.readFile('/agents/SOUL.md')).rejects.toThrow(/protected agent path/)
  })

  // -------------------------------------------------------------------------
  // Read-only mode (Plan mode)
  // -------------------------------------------------------------------------

  it('blocks workspace writes in read-only mode', async () => {
    const { invoker } = makeMockRpc()
    const fs = new WorkerVfsBridgeFs(invoker, ['root'], false, false, {
      readOnly: true,
      restrictAgentCoreFiles: false,
    })

    await expect(fs.writeFile('/workspace/root/file.txt', 'x')).rejects.toThrow(
      /read-only mode/,
    )
  })

  it('allows system writes in read-only mode', async () => {
    const { invoker } = makeMockRpc()
    const fs = new WorkerVfsBridgeFs(invoker, ['root'], false, false, {
      readOnly: true,
      restrictAgentCoreFiles: false,
    })

    // System file writes are local — read-only only affects workspace/assets/agent
    fs.writeFileSync('/tmp/test', 'data')
    expect(await fs.readFile('/tmp/test')).toBe('data')
  })

  // -------------------------------------------------------------------------
  // Binary encoding (latin1 roundtrip)
  // -------------------------------------------------------------------------

  it('serializes binary content as latin1 string for RPC', async () => {
    const { invoker, calls } = makeMockRpc({
      writeFile: () => undefined,
    })
    const fs = new WorkerVfsBridgeFs(invoker, ['root'], false, false, {
      readOnly: false,
      restrictAgentCoreFiles: false,
    })

    // Bytes with high-bit values (0x80-0xFF) that UTF-8 would mangle
    const bytes = new Uint8Array([0x48, 0xe9, 0x6c, 0x6c, 0xf6])
    await fs.writeFile('/workspace/root/bin.dat', bytes, { encoding: 'binary' })

    expect(calls[0].encoding).toBe('binary')
    // latin1-shaped string: each char's code = one byte
    expect(calls[0].content).toBe(String.fromCharCode(0x48, 0xe9, 0x6c, 0x6c, 0xf6))
  })

  it('deserializes readFileBuffer latin1 response back to bytes', async () => {
    const latin1 = String.fromCharCode(0x48, 0xe9, 0x6c, 0x6c, 0xf6)
    const { invoker } = makeMockRpc({
      readFileBuffer: () => latin1,
    })
    const fs = new WorkerVfsBridgeFs(invoker, ['root'], false, false, {
      readOnly: false,
      restrictAgentCoreFiles: false,
    })

    const bytes = await fs.readFileBuffer('/workspace/root/bin.dat')
    expect(bytes).toEqual(new Uint8Array([0x48, 0xe9, 0x6c, 0x6c, 0xf6]))
  })

  // -------------------------------------------------------------------------
  // Path normalization
  // -------------------------------------------------------------------------

  it('normalizes .. and . in paths', async () => {
    const { invoker, calls } = makeMockRpc({
      readFile: (req) => `ok:${req.path}`,
    })
    const fs = new WorkerVfsBridgeFs(invoker, ['root'], false, false, {
      readOnly: false,
      restrictAgentCoreFiles: false,
    })

    await fs.readFile('/workspace/root/sub/../app.ts')
    expect(calls[0].path).toBe('root/app.ts')
  })

  // -------------------------------------------------------------------------
  // appendFile read-only guard (BUG 5 regression)
  // -------------------------------------------------------------------------

  it('blocks append in read-only mode', async () => {
    const { invoker } = makeMockRpc()
    const fs = new WorkerVfsBridgeFs(invoker, ['root'], false, false, {
      readOnly: true,
      restrictAgentCoreFiles: false,
    })

    await expect(fs.appendFile('/workspace/root/file.txt', 'more')).rejects.toThrow(
      /read-only mode/,
    )
  })

  // -------------------------------------------------------------------------
  // cp delegates to RPC with recursive flag (BUG 3 regression)
  // -------------------------------------------------------------------------

  it('delegates cp to RPC with recursive flag', async () => {
    const { invoker, calls } = makeMockRpc({
      cp: () => undefined,
    })
    const fs = new WorkerVfsBridgeFs(invoker, ['root'], false, false, {
      readOnly: false,
      restrictAgentCoreFiles: false,
    })

    await fs.cp('/workspace/root/src', '/workspace/root/dest', { recursive: true })
    expect(calls[0].method).toBe('cp')
    expect(calls[0].path).toBe('root/src')
    expect(calls[0].dest).toBe('root/dest')
    expect(calls[0].recursive).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Cross-backend cp (BUG 8 regression)
  // -------------------------------------------------------------------------

  it('copies single file across backends (workspace → assets)', async () => {
    const { invoker, calls } = makeMockRpc({
      readFileBuffer: (req) => `file:${req.path}`,
      writeFile: () => undefined,
    })
    const fs = new WorkerVfsBridgeFs(invoker, ['root'], true, false, {
      readOnly: false,
      restrictAgentCoreFiles: false,
    })

    // Source in workspace, dest in assets — different backends
    await fs.cp('/workspace/root/src.txt', '/assets/backup.txt')

    // Should do readFileBuffer from workspace + binary writeFile to assets
    // (NOT a single cp RPC, and NOT the lossy text readFile channel)
    const readCall = calls.find(c => c.method === 'readFileBuffer')
    const writeCall = calls.find(c => c.method === 'writeFile')
    expect(readCall).toBeDefined()
    expect(readCall!.backend).toBe('workspace')
    expect(readCall!.path).toBe('root/src.txt')
    expect(writeCall).toBeDefined()
    expect(writeCall!.backend).toBe('assets')
    expect(writeCall!.path).toBe('backup.txt')
    expect(writeCall!.encoding).toBe('binary')
    expect(writeCall!.content).toBe('file:root/src.txt')

    // Should NOT send a single 'cp' RPC, nor use the lossy readFile channel
    expect(calls.some(c => c.method === 'cp')).toBe(false)
    expect(calls.some(c => c.method === 'readFile')).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Cross-backend cp read-only guard (known-limitation fix)
  // -------------------------------------------------------------------------

  it('blocks cross-backend cp write in read-only mode', async () => {
    const { invoker, calls } = makeMockRpc({
      readFile: () => 'data',
      writeFile: () => undefined,
    })
    const fs = new WorkerVfsBridgeFs(invoker, ['root'], true, false, {
      readOnly: true,
      restrictAgentCoreFiles: false,
    })

    // Even cross-backend cp must be blocked in read-only mode
    await expect(
      fs.cp('/workspace/root/src.txt', '/assets/backup.txt'),
    ).rejects.toThrow(/read-only mode/)

    // No RPC should have fired (not even the readFile)
    expect(calls.length).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Cross-backend cp/mv binary safety (UTF-8 mangling regression)
  //
  // Regression test for the post481 incident: `cp /assets/images/x.jpg
  // featured-image.jpg` corrupted the JPEG (ffd8ffe0 header became
  // efbfbd-efbfbd-... U+FFFD replacement chars) because the cross-backend
  // copy used the readFile RPC, whose main-thread handler forces
  // encoding:'text' and lossily UTF-8-decodes arbitrary bytes.
  // -------------------------------------------------------------------------

  describe('cross-backend binary safety', () => {
    // Realistic JPEG-ish bytes: SOI (ffd8ff) + JFIF APP0 header + high-bit data
    const jpegBytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0xc9, 0x03, 0x7f, 0xe2, 0x82, 0xac, 0x80, 0xfe,
    ])

    function makeStores() {
      const assets = new Map<string, Uint8Array>([['images/featured.jpg', jpegBytes]])
      const workspace = new Map<string, Uint8Array>()
      return { assets, workspace }
    }

    it('single-file cp /assets → /workspace preserves binary bytes', async () => {
      const stores = makeStores()
      const { invoker, calls } = makeRoundTripRpc(stores)
      const fs = new WorkerVfsBridgeFs(invoker, ['root'], true, false, {
        readOnly: false,
        restrictAgentCoreFiles: false,
      })

      await fs.cp('/assets/images/featured.jpg', '/workspace/root/featured-image.jpg')

      const copied = stores.workspace.get('root/featured-image.jpg')
      expect(copied).toBeDefined()
      expect(Array.from(copied!)).toEqual(Array.from(jpegBytes))

      // Mechanism check: binary channel only — no lossy readFile RPC
      expect(calls.some(c => c.method === 'readFile')).toBe(false)
      const writeCall = calls.find(c => c.method === 'writeFile')
      expect(writeCall?.encoding).toBe('binary')
    })

    it('recursive cp /assets → /workspace preserves nested binary files', async () => {
      const stores = makeStores()
      const { invoker } = makeRoundTripRpc(stores)
      const fs = new WorkerVfsBridgeFs(invoker, ['root'], true, false, {
        readOnly: false,
        restrictAgentCoreFiles: false,
      })

      await fs.cp('/assets/images', '/workspace/root/images', { recursive: true })

      const copied = stores.workspace.get('root/images/featured.jpg')
      expect(copied).toBeDefined()
      expect(Array.from(copied!)).toEqual(Array.from(jpegBytes))
    })

    it('mv /assets → /workspace preserves binary bytes and removes source', async () => {
      const stores = makeStores()
      const { invoker } = makeRoundTripRpc(stores)
      const fs = new WorkerVfsBridgeFs(invoker, ['root'], true, false, {
        readOnly: false,
        restrictAgentCoreFiles: false,
      })

      await fs.mv('/assets/images/featured.jpg', '/workspace/root/moved.jpg')

      const moved = stores.workspace.get('root/moved.jpg')
      expect(moved).toBeDefined()
      expect(Array.from(moved!)).toEqual(Array.from(jpegBytes))
      expect(stores.assets.has('images/featured.jpg')).toBe(false)
    })

    it('binary cp still corrupts if reverted to readFile channel (guard comment)', async () => {
      // Documents WHY the binary channel is required: simulating the OLD
      // implementation's behavior (readFile + text writeFile) against the
      // same handler semantics demonstrably corrupts the bytes. If someone
      // reverts the fix, the tests above will catch it — this test pins the
      // mechanism itself.
      const stores = makeStores()
      const decoder = new TextDecoder()
      const oldStyleInvoker = async (req: VfsRpcRequest): Promise<VfsRpcResponse> => {
        const store = stores[req.backend as 'assets' | 'workspace']!
        if (req.method === 'readFile') {
          return { type: 'vfs-result', rpcId: req.rpcId, ok: true, result: decoder.decode(store.get(req.path)!) }
        }
        if (req.method === 'writeFile') {
          store.set(req.path, new TextEncoder().encode(req.content ?? ''))
          return { type: 'vfs-result', rpcId: req.rpcId, ok: true, result: undefined }
        }
        return { type: 'vfs-result', rpcId: req.rpcId, ok: false, error: 'unexpected' }
      }

      // Old path: text read + text write
      const readResp = await oldStyleInvoker({
        type: 'vfs', rpcId: 1, backend: 'assets', method: 'readFile', path: 'images/featured.jpg',
      })
      await oldStyleInvoker({
        type: 'vfs', rpcId: 2, backend: 'workspace', method: 'writeFile',
        path: 'root/corrupted.jpg', content: readResp.result as string,
      })

      const corrupted = stores.workspace.get('root/corrupted.jpg')!
      // ffd8ff... becomes efbfbd efbfbd efbfbd... (U+FFFD × 4 then 0010JF...)
      expect(Array.from(corrupted.slice(0, 4))).toEqual([0xef, 0xbf, 0xbd, 0xef])
      expect(corrupted.length).toBeGreaterThan(jpegBytes.length)
    })
  })
})
