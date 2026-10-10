/**
 * WorkerVfsBridgeFs — just-bash IFileSystem for the bash worker thread.
 *
 * Mirrors the structure of `VfsBridgeFs` (main thread), but instead of
 * delegating workspace/assets/agent file IO to VfsBackend instances, it
 * sends RPC requests back to the main thread via `postMessage`.
 *
 * System directories (/bin, /dev, /tmp, etc.) live in an in-memory Map,
 * exactly like VfsBridgeFs — just-bash needs these for command stubs,
 * /dev/null, /proc/self/status, etc.
 *
 * Path routing is identical to VfsBridgeFs:
 *   /workspace/<rootName>/...  → RPC (backend: 'workspace')
 *   /assets/...                → RPC (backend: 'assets')
 *   /agents/...                → RPC (backend: 'agent')
 *   /bin, /home...             → in-memory system map (local)
 */

import type {
  VfsRpcRequest,
  VfsRpcResponse,
  VfsRpcMethod,
} from './protocol'
import {
  type FsStat,
  type DirentEntry,
  type SysEntry,
  DEFAULT_FILE_MODE,
  DEFAULT_DIR_MODE,
  WORKSPACE_MOUNT,
  ASSETS_MOUNT,

  AGENTS_MOUNT,
  normalizeAbsolutePath,
  dirnameOf as dirname,
  isSystemPath,

  isAgentsPath,
  toWorkspaceRelative,

  toAgentsRelative,
  normalizeWriteEncoding,
  latin1StringToBytes,
  bytesToLatin1String,
  utf8Encode,
  utf8Decode,
} from './bridge-shared'
import { isProtectedAgentCoreFile } from '../agent-file-protection'

// ---------------------------------------------------------------------------
// RPC transport interface (injected; resolves via worker's postMessage)
// ---------------------------------------------------------------------------

/**
 * Sends a VFS RPC request to the main thread and awaits the response.
 * The worker entrypoint wires this to `self.postMessage` + a pending map.
 */
export type VfsRpcInvoker = (request: VfsRpcRequest) => Promise<VfsRpcResponse>

// ---------------------------------------------------------------------------
// WorkerVfsBridgeFs
// ---------------------------------------------------------------------------

export interface WorkerVfsBridgeFsOptions {
  readOnly: boolean
  restrictAgentCoreFiles: boolean
}

export class WorkerVfsBridgeFs {
  readonly isVfsBridge = true

  /** In-memory system filesystem (just-bash needs /bin stubs, /dev/null, etc.) */
  private sysFs = new Map<string, SysEntry>()

  readonly readOnly: boolean
  readonly restrictAgentCoreFiles: boolean

  constructor(
    private readonly rpc: VfsRpcInvoker,
    rootNames: string[] = [],
    hasAssets: boolean = false,
    hasAgent: boolean = false,
    options: WorkerVfsBridgeFsOptions = { readOnly: false, restrictAgentCoreFiles: false },
  ) {
    this.readOnly = options.readOnly ?? false
    this.restrictAgentCoreFiles = options.restrictAgentCoreFiles ?? false

    // Bootstrap essential system directories
    this.ensureSysDir('/')
    this.ensureSysDir('/bin')
    this.ensureSysDir('/usr')
    this.ensureSysDir('/usr/bin')
    this.ensureSysDir('/home')
    this.ensureSysDir('/home/user')
    this.ensureSysDir('/tmp')
    this.ensureSysDir('/dev')
    this.ensureSysDir('/proc')
    this.ensureSysDir('/proc/self')
    this.ensureSysDir('/proc/self/fd')
    this.ensureSysDir('/etc')
    this.ensureSysDir(WORKSPACE_MOUNT)
    if (hasAssets) this.ensureSysDir(ASSETS_MOUNT)
    this.ensureSysDir('/external')
    this.ensureSysDir('/skills')
    if (hasAgent) this.ensureSysDir(AGENTS_MOUNT)

    // /dev/null — black hole
    this.sysFs.set('/dev/null', {
      type: 'file',
      content: new Uint8Array(0),
      mode: 0o666,
      mtime: new Date(),
    })

    // Stash rootNames for readdir of /workspace
    this._rootNames = rootNames
  }

  private _rootNames: string[]

  // ==========================================================================
  // RPC helper
  // ==========================================================================

  private async rpcCall(
    backend: string,
    method: VfsRpcMethod,
    payload: Partial<VfsRpcRequest> = {},
  ): Promise<VfsRpcResponse> {
    // rpcId is assigned by the injected rpcInvoker (single source of truth).
    return this.rpc({
      type: 'vfs',
      rpcId: 0, // placeholder — overwritten by rpcInvoker
      method,
      ...payload,
      path: `${backend}/${payload.path ?? ''}`,
      ...(payload.dest === undefined ? {} : { dest: `${backend}/${payload.dest}` }),
    })
  }

  // ==========================================================================
  // Core read
  // ==========================================================================

  async readFile(path: string, _options?: { encoding?: string } | string): Promise<string> {
    const sysEntry = this.getSysFile(path)
    if (sysEntry) {
      if (sysEntry.type !== 'file') throw new Error(`EISDIR: '${path}'`)
      return utf8Decode(sysEntry.content)
    }

    const { backend, relPath } = this.route(path)
    const resp = await this.rpcCall(backend, 'readFile', { path: relPath })
    if (!resp.ok) throw new Error(resp.error ?? `readFile failed: '${path}'`)
    return resp.result as string
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const sysEntry = this.getSysFile(path)
    if (sysEntry) {
      if (sysEntry.type !== 'file') throw new Error(`EISDIR: '${path}'`)
      return sysEntry.content
    }

    const { backend, relPath } = this.route(path)
    const resp = await this.rpcCall(backend, 'readFileBuffer', { path: relPath })
    if (!resp.ok) throw new Error(resp.error ?? `readFileBuffer failed: '${path}'`)
    // result is latin1-shaped string; convert back to bytes
    const latin1 = resp.result as string
    return latin1StringToBytes(latin1)
  }

  // ==========================================================================
  // Core write
  // ==========================================================================

  async writeFile(
    path: string,
    content: string | Uint8Array,
    options?: { encoding?: string } | string,
  ): Promise<void> {
    if (path === '/dev/null' || path === '/dev/zero') return

    // System path — write to in-memory map
    if (isSystemPath(path)) {
      const normalized = normalizeAbsolutePath(path)
      this.ensureSysDir(dirname(normalized))
      const encoding = normalizeWriteEncoding(options)
      this.sysFs.set(normalized, {
        type: 'file',
        content:
          typeof content === 'string'
            ? encoding === 'binary'
              ? latin1StringToBytes(content)
              : utf8Encode(content)
            : content,
        mode: DEFAULT_FILE_MODE,
        mtime: new Date(),
      })
      return
    }

    const { backend, relPath } = this.route(path)

    // Read-only guard (Plan mode) — block all non-system writes locally
    // before hitting the RPC round-trip. Main thread handler also checks
    // (defense-in-depth), but failing early avoids needless latency.
    if (this.readOnly) {
      throw new Error(`bash: ${path}: write blocked (read-only mode)`)
    }

    const encoding = normalizeWriteEncoding(options)
    // Serialize content: Uint8Array → latin1 string (binary), string as-is
    const serialized =
      typeof content === 'string'
        ? content
        : encoding === 'binary'
          ? bytesToLatin1String(content)
          : utf8Decode(content)

    const resp = await this.rpcCall(backend, 'writeFile', {
      path: relPath,
      content: serialized,
      encoding,
    })
    if (!resp.ok) throw new Error(resp.error ?? `writeFile failed: '${path}'`)
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    options?: { encoding?: string } | string,
  ): Promise<void> {
    if (path === '/dev/null' || path === '/dev/zero') return

    if (isSystemPath(path)) {
      const normalized = normalizeAbsolutePath(path)
      const existing = this.sysFs.get(normalized)
      const existingContent = existing && existing.type === 'file' ? existing.content : new Uint8Array(0)
      const encoding = normalizeWriteEncoding(options)
      const toAppend =
        typeof content === 'string'
          ? encoding === 'binary'
            ? latin1StringToBytes(content)
            : utf8Encode(content)
          : content
      const combined = new Uint8Array(existingContent.length + toAppend.length)
      combined.set(existingContent)
      combined.set(toAppend, existingContent.length)
      this.sysFs.set(normalized, {
        type: 'file',
        content: combined,
        mode: DEFAULT_FILE_MODE,
        mtime: new Date(),
      })
      return
    }

    // The host implements append using the resolved backend's file semantics.
    const { backend, relPath } = this.route(path)

    // Read-only guard (Plan mode) — same as writeFile
    if (this.readOnly) {
      throw new Error(`bash: ${path}: append blocked (read-only mode)`)
    }

    const encoding = normalizeWriteEncoding(options)

    const appendStr =
      typeof content === 'string'
        ? content
        : encoding === 'binary'
          ? bytesToLatin1String(content)
          : utf8Decode(content)

    const resp = await this.rpcCall(backend, 'appendFile', {
      path: relPath,
      content: appendStr,
      encoding,
    })
    if (!resp.ok) throw new Error(resp.error ?? `appendFile failed: '${path}'`)
  }

  // ==========================================================================
  // File management
  // ==========================================================================

  async exists(path: string): Promise<boolean> {
    const normalized = normalizeAbsolutePath(path)
    if (this.sysFs.has(normalized)) return true

    if (normalized === WORKSPACE_MOUNT) return true

    const { backend, relPath } = this.route(path)
    const resp = await this.rpcCall(backend, 'exists', { path: relPath })
    if (!resp.ok) return false
    return resp.result as boolean
  }

  async stat(path: string): Promise<FsStat> {
    const normalized = normalizeAbsolutePath(path)

    const sysEntry = this.sysFs.get(normalized)
    if (sysEntry) {
      if (sysEntry.type === 'file') {
        return {
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          mode: sysEntry.mode,
          size: sysEntry.content.length,
          mtime: sysEntry.mtime,
        }
      }
      return {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        mode: sysEntry.mode,
        size: 0,
        mtime: sysEntry.mtime,
      }
    }

    const { backend, relPath } = this.route(path)
    const resp = await this.rpcCall(backend, 'stat', { path: relPath })
    if (!resp.ok) throw new Error(resp.error ?? `ENOENT: no such file or directory, stat '${path}'`)
    const s = resp.result as Omit<FsStat, 'mtime'> & { mtime: number }
    return { ...s, mtime: new Date(s.mtime) }
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path)
  }

  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    const normalized = normalizeAbsolutePath(path)
    if (isSystemPath(normalized)) {
      this.ensureSysDir(normalized)
      return
    }
    if (this.readOnly) throw new Error(`bash: ${path}: mkdir blocked (read-only mode)`)
    const { backend, relPath } = this.route(normalized)
    const resp = await this.rpcCall(backend, 'mkdir', { path: relPath, recursive: _options?.recursive })
    if (!resp.ok) throw new Error(resp.error ?? `mkdir failed: '${path}'`)
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.readdirWithFileTypes(path)
    return entries.map(e => e.name)
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const normalized = normalizeAbsolutePath(path)

    // System directory — list from in-memory map
    if (isSystemPath(normalized) || normalized === '/') {
      return this.readdirSys(normalized)
    }

    // /workspace root — list root directory names
    if (normalized === WORKSPACE_MOUNT && this._rootNames.length > 0) {
      // Merge rootNames with any sysFs entries (e.g. mount-point dirs)
      const sysEntries = this.readdirSys(normalized)
      const sysNames = new Set(sysEntries.map(e => e.name))
      const merged = [...sysEntries]
      for (const name of this._rootNames) {
        if (!sysNames.has(name)) {
          merged.push({ name, isFile: false, isDirectory: true, isSymbolicLink: false })
        }
      }
      return merged
    }

    const { backend, relPath } = this.route(path)
    const resp = await this.rpcCall(backend, 'readdirWithFileTypes', { path: relPath })
    if (!resp.ok) throw new Error(`ENOTDIR: not a directory, scandir '${path}'`)
    return resp.result as DirentEntry[]
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const normalized = normalizeAbsolutePath(path)

    if (this.sysFs.has(normalized)) {
      this.sysFs.delete(normalized)
      return
    }

    // Workspace path — read-only guard
    if (this.readOnly && this.isWorkspacePath(normalized)) {
      throw new Error(`bash: ${path}: delete blocked (read-only mode)`)
    }

    const { backend, relPath } = this.route(path)
    const resp = await this.rpcCall(backend, 'rm', {
      path: relPath,
      recursive: options?.recursive,
      force: options?.force,
    })
    if (!resp.ok && !(options?.force && /ENOENT|not found|no such file/i.test(resp.error ?? ''))) {
      throw new Error(resp.error ?? `rm failed: '${path}'`)
    }
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    const srcNorm = normalizeAbsolutePath(src)
    const destNorm = normalizeAbsolutePath(dest)

    // System entry source — handle locally
    const sysEntry = this.sysFs.get(srcNorm)
    if (sysEntry) {
      if (sysEntry.type === 'file') {
        await this.writeFile(dest, sysEntry.content)
        return
      }
      // Directory copy from sysFs — rare, just copy entries
      if (sysEntry.type === 'directory' && options?.recursive) {
        await this.cpSysDir(srcNorm, destNorm)
        return
      }
      throw new Error(`cp: cannot stat '${src}'`)
    }

    // Non-system source: route both src and dest to determine their backends.
    const srcRoute = this.route(srcNorm)
    const destRoute = this.route(destNorm)

    if (srcRoute.backend === destRoute.backend) {
      // Same backend — delegate to RPC so the handler can do recursive
      // directory copy efficiently within a single backend instance.
      const resp = await this.rpcCall(srcRoute.backend, 'cp', {
        path: srcRoute.relPath,
        dest: destRoute.relPath,
        recursive: options?.recursive,
      })
      if (!resp.ok) throw new Error(resp.error ?? `cp: cannot stat '${src}': No such file or directory`)
    } else {
      // Cross-mount copy retains the existing binary channel. Each request
      // resolves and authorizes its canonical path independently.
      //
      // readOnly guard: same as writeFile — the direct rpcCall('writeFile')
      // below bypasses writeFile()'s own check, so we enforce it here.
      if (this.readOnly) {
        throw new Error(`bash: ${dest}: write blocked (read-only mode)`)
      }
      if (options?.recursive) {
        await this.cpCrossBackend(srcRoute, destRoute)
      } else {
        // Single-file cross-backend copy.
        // MUST use the binary channel (readFileBuffer + encoding: 'binary'):
        // the readFile RPC forces encoding:'text' on the main thread, which
        // UTF-8-decodes arbitrary bytes into U+FFFD replacement chars and
        // corrupts binary files (e.g. a JPEG's ffd8ff header becomes efbfbd...).
        const readResp = await this.rpcCall(srcRoute.backend, 'readFileBuffer', { path: srcRoute.relPath })
        if (!readResp.ok) throw new Error(`cp: cannot stat '${src}': No such file or directory`)
        const writeResp = await this.rpcCall(destRoute.backend, 'writeFile', {
          path: destRoute.relPath,
          content: readResp.result as string,
          encoding: 'binary',
        })
        if (!writeResp.ok) throw new Error(`cp: cannot write to '${dest}': ${writeResp.error}`)
      }
    }
  }

  /**
   * Recursively copy across different backends (e.g. workspace → assets).
   * List src entries via RPC, then copy each one to dest (routing independently).
   */
  private async cpCrossBackend(
    srcRoute: { backend: string; relPath: string },
    destRoute: { backend: string; relPath: string },
  ): Promise<void> {
    // Stat source to determine if it's a directory
    const statResp = await this.rpcCall(srcRoute.backend, 'stat', { path: srcRoute.relPath })
    if (!statResp.ok) throw new Error(statResp.error ?? `cp: cannot stat '${srcRoute.relPath}'`)
    if (!(statResp.result as { isDirectory: boolean })?.isDirectory) {
      // Not a directory — fall back to single-file copy (binary channel;
      // see cp() for why a readFile text roundtrip corrupts binary files)
      const readResp = await this.rpcCall(srcRoute.backend, 'readFileBuffer', { path: srcRoute.relPath })
      if (!readResp.ok) throw new Error(`cp: cannot stat '${srcRoute.relPath}'`)
      const writeResp = await this.rpcCall(destRoute.backend, 'writeFile', {
        path: destRoute.relPath,
        content: readResp.result as string,
        encoding: 'binary',
      })
      if (!writeResp.ok) throw new Error(`cp: cannot write: ${writeResp.error}`)
      return
    }

    const mkdirResp = await this.rpcCall(destRoute.backend, 'mkdir', { path: destRoute.relPath, recursive: true })
    if (!mkdirResp.ok) throw new Error(mkdirResp.error ?? `cp: cannot create '${destRoute.relPath}'`)
    // List directory entries and copy recursively, including empty directories.
    const listResp = await this.rpcCall(srcRoute.backend, 'readdirWithFileTypes', { path: srcRoute.relPath })
    if (!listResp.ok) throw new Error(`cp: cannot read directory '${srcRoute.relPath}'`)
    const entries = listResp.result as DirentEntry[]
    for (const entry of entries) {
      const childSrcRel = srcRoute.relPath ? `${srcRoute.relPath}/${entry.name}` : entry.name
      const childDestRel = destRoute.relPath ? `${destRoute.relPath}/${entry.name}` : entry.name
      if (entry.isFile) {
        // Binary channel — see cp() for why a readFile text roundtrip
        // corrupts binary files
        const readResp = await this.rpcCall(srcRoute.backend, 'readFileBuffer', { path: childSrcRel })
        if (!readResp.ok) throw new Error(readResp.error ?? `cp: cannot read '${childSrcRel}'`)
        const writeResp = await this.rpcCall(destRoute.backend, 'writeFile', {
            path: childDestRel,
            content: readResp.result as string,
            encoding: 'binary',
        })
        if (!writeResp.ok) throw new Error(writeResp.error ?? `cp: cannot write '${childDestRel}'`)
      } else if (entry.isDirectory) {
        await this.cpCrossBackend(
          { backend: srcRoute.backend, relPath: childSrcRel },
          { backend: destRoute.backend, relPath: childDestRel },
        )
      }
    }
  }

  private async cpSysDir(srcNorm: string, destNorm: string): Promise<void> {
    const prefix = srcNorm === '/' ? '/' : `${srcNorm}/`
    for (const [p, entry] of this.sysFs.entries()) {
      if (!p.startsWith(prefix) || p === srcNorm) continue
      const relFromSrc = p.slice(prefix.length)
      const destPath = `${destNorm}/${relFromSrc}`
      if (entry.type === 'file') {
        await this.writeFile(destPath, entry.content)
      } else if (entry.type === 'directory') {
        this.ensureSysDir(normalizeAbsolutePath(destPath))
      }
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest, { recursive: true })
    await this.rm(src, { recursive: true, force: true })
  }

  // ==========================================================================
  // Path resolution
  // ==========================================================================

  resolvePath(base: string, path: string): string {
    if (path.startsWith('/')) return normalizeAbsolutePath(path)
    const combined = base === '/' ? `/${path}` : `${base}/${path}`
    return normalizeAbsolutePath(combined)
  }

  getAllPaths(): string[] {
    return Array.from(this.sysFs.keys())
  }

  // ==========================================================================
  // Unsupported (same as VfsBridgeFs)
  // ==========================================================================

  async chmod(_path: string, _mode: number): Promise<void> {}
  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new Error('EOPNOTSUPP: symlinks not supported')
  }
  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error('EOPNOTSUPP: hard links not supported')
  }
  async readlink(_path: string): Promise<string> {
    throw new Error('EINVAL: not a symlink')
  }
  async realpath(path: string): Promise<string> {
    return normalizeAbsolutePath(path)
  }
  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {}

  // ==========================================================================
  // Sync write support (needed by just-bash for /bin command stubs)
  // ==========================================================================

  writeFileSync(path: string, content: string | Uint8Array): void {
    const normalized = normalizeAbsolutePath(path)
    this.ensureSysDir(dirname(normalized))
    this.sysFs.set(normalized, {
      type: 'file',
      content: typeof content === 'string' ? utf8Encode(content) : content,
      mode: DEFAULT_FILE_MODE,
      mtime: new Date(),
    })
  }

  mkdirSync(path: string, _options?: { recursive?: boolean }): void {
    const normalized = normalizeAbsolutePath(path)
    this.ensureSysDir(normalized)
  }

  // ==========================================================================
  // Internal helpers
  // ==========================================================================

  /** Route an absolute path to its backend + relative path. */
  private route(absPath: string): { backend: string; relPath: string } {
    const normalized = normalizeAbsolutePath(absPath)

    this.assertAgentPathAllowed(normalized)
    const [namespace, ...parts] = normalized.split('/').filter(Boolean)
    // Shell mount names are path syntax, not storage implementation labels.
    if (['assets', 'skills', 'external', 'agents'].includes(namespace)) {
      if (namespace === 'external' && parts.length > 0) {
        return { backend: `vfs://external/${parts[0]}`, relPath: parts.slice(1).join('/') }
      }
      return { backend: `vfs://${namespace}`, relPath: parts.join('/') }
    }
    return { backend: 'vfs://workspace', relPath: toWorkspaceRelative(normalized) }
  }

  private isWorkspacePath(normalized: string): boolean {
    return (
      normalized === WORKSPACE_MOUNT ||
      normalized.startsWith(WORKSPACE_MOUNT + '/')
    )
  }

  private assertAgentPathAllowed(path: string, options?: { denyRoot?: boolean }): void {
    if (!this.restrictAgentCoreFiles || !isAgentsPath(path)) return
    const relativePath = toAgentsRelative(path)
    if ((options?.denyRoot && !relativePath) || isProtectedAgentCoreFile(relativePath)) {
      throw new Error(`EACCES: delegated subagent cannot access protected agent path '${path}'`)
    }
  }

  private getSysFile(path: string): SysEntry | null {
    const normalized = normalizeAbsolutePath(path)
    return this.sysFs.get(normalized) ?? null
  }

  private ensureSysDir(path: string): void {
    if (!path || path === '/') {
      if (!this.sysFs.has('/')) {
        this.sysFs.set('/', { type: 'directory', mode: DEFAULT_DIR_MODE, mtime: new Date() })
      }
      return
    }
    const normalized = normalizeAbsolutePath(path)
    if (!this.sysFs.has(normalized)) {
      const parent = dirname(normalized)
      if (parent !== normalized) this.ensureSysDir(parent)
      this.sysFs.set(normalized, { type: 'directory', mode: DEFAULT_DIR_MODE, mtime: new Date() })
    }
  }

  private readdirSys(dirPath: string): DirentEntry[] {
    const prefix = dirPath === '/' ? '/' : `${dirPath}/`
    const entries = new Map<string, DirentEntry>()

    for (const [p, entry] of this.sysFs.entries()) {
      if (p === dirPath) continue
      if (!p.startsWith(prefix)) continue

      const rest = p.slice(prefix.length)
      const name = rest.split('/')[0]
      if (!name || rest.includes('/', name.length)) continue

      if (!entries.has(name)) {
        entries.set(name, {
          name,
          isFile: entry.type === 'file',
          isDirectory: entry.type === 'directory',
          isSymbolicLink: false,
        })
      }
    }

    return Array.from(entries.values()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }
}
