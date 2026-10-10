/** File semantics shared by hosts and injected providers; no transport is prescribed. */
export interface FsStat {
  kind: 'file' | 'directory'
  size?: number
  mtime?: number
}
export interface FsDirEntry extends FsStat { name: string }
export interface FsProvider {
  readonly readOnly?: boolean
  stat(path: string): Promise<FsStat>
  readdir(path: string): Promise<FsDirEntry[]>
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, content: Uint8Array): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  remove(path: string, options?: { recursive?: boolean }): Promise<void>
  rename?(from: string, to: string): Promise<void>
  dispose?(): void
}

export type FsErrorCode = 'ENOENT' | 'EEXIST' | 'ENOTDIR' | 'EISDIR' | 'ENOTEMPTY' | 'EINVAL' | 'EROFS' | 'EACCES' | 'ENOTCONN'
export class FsError extends Error {
  constructor(readonly code: FsErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'FsError'
  }
}

/** Paths are relative POSIX paths. Empty string denotes the provider root. */
export function normalizeProviderPath(path: string): string {
  if (typeof path !== 'string' || path.includes('\0') || path.includes('\\') || path.startsWith('/')) {
    throw new FsError('EINVAL', 'Expected a relative POSIX path')
  }
  const parts = path.split('/').filter(Boolean)
  if (parts.some(part => part === '.' || part === '..')) throw new FsError('EINVAL', 'Path traversal is forbidden')
  return parts.join('/')
}

export interface ProviderRegistration {
  version: 1
  /** Stable identity, separate from the requested directory name. */
  id: string
  name: string
  mountName: string
  factory(): FsProvider | Promise<FsProvider>
  /** Cheap availability hint. Operations remain authoritative and may fail. */
  isAlive(): boolean
}
export const PROVIDER_ANNOUNCE_EVENT = 'creatorweave:fs:announce'
export const PROVIDER_REQUEST_EVENT = 'creatorweave:fs:request'

export function isProviderRegistration(value: unknown): value is ProviderRegistration {
  if (!value || typeof value !== 'object') return false
  const r = value as Partial<ProviderRegistration>
  return r.version === 1 && typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 256 &&
    typeof r.name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(r.mountName ?? '') &&
    typeof r.factory === 'function' && typeof r.isAlive === 'function'
}

/** Call from the page's JS context. The provider owns injection and communication. */
export function announceProvider(registration: ProviderRegistration, target: EventTarget = window): () => void {
  if (!isProviderRegistration(registration)) throw new FsError('EINVAL', 'Invalid provider registration')
  const detail = Object.freeze({ ...registration })
  const announce = () => target.dispatchEvent(new CustomEvent(PROVIDER_ANNOUNCE_EVENT, { detail }))
  target.addEventListener(PROVIDER_REQUEST_EVENT, announce)
  announce()
  return () => target.removeEventListener(PROVIDER_REQUEST_EVENT, announce)
}

export function listenForProviders(receive: (registration: ProviderRegistration) => void, target: EventTarget = window): () => void {
  const listener = (event: Event) => {
    const detail: unknown = (event as CustomEvent).detail
    if (isProviderRegistration(detail)) receive(detail)
  }
  target.addEventListener(PROVIDER_ANNOUNCE_EVENT, listener)
  target.dispatchEvent(new Event(PROVIDER_REQUEST_EVENT))
  return () => target.removeEventListener(PROVIDER_ANNOUNCE_EVENT, listener)
}
