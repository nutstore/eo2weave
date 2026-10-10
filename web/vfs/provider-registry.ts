import { FsError, isProviderRegistration, listenForProviders, type FsProvider, type ProviderRegistration } from '@creatorweave/fs-provider'

interface Mount {
  registration: ProviderRegistration
  instance?: FsProvider
  pending?: Promise<FsProvider>
}

/** Owns mounts, not connections. Factories may implement any transport internally. */
export class ProviderRegistry {
  private mounts = new Map<string, Mount>()

  register(registration: ProviderRegistration): void {
    if (!isProviderRegistration(registration)) throw new FsError('EINVAL', 'Invalid provider registration')
    const existing = this.mounts.get(registration.mountName)
    if (existing?.registration.factory === registration.factory && this.alive(existing)) return
    if (existing && this.alive(existing)) throw new FsError('EEXIST', `Mount ${registration.mountName} already exists`)
    if (existing) this.release(existing)
    this.mounts.set(registration.mountName, { registration })
  }

  names(): string[] {
    return [...this.mounts].filter(([, mount]) => this.alive(mount)).map(([name]) => name).sort()
  }

  async get(name: string): Promise<FsProvider> {
    const mount = this.mounts.get(name)
    if (!mount) throw new FsError('ENOENT', `Unknown mount ${name}`)
    if (!this.alive(mount)) {
      this.release(mount)
      throw new FsError('ENOTCONN', `Mount ${name} is unavailable`)
    }
    if (mount.instance) return mount.instance
    if (!mount.pending) {
      const pending = Promise.resolve().then(() => mount.registration.factory()).then(provider => {
        if (this.mounts.get(name) !== mount || !this.alive(mount) || mount.pending !== pending) {
          provider.dispose?.()
          throw new FsError('ENOTCONN', `Mount ${name} changed during creation`)
        }
        for (const method of ['stat', 'readdir', 'readFile', 'writeFile', 'mkdir', 'remove'] as const) {
          if (typeof provider?.[method] !== 'function') throw new FsError('EINVAL', `Provider missing ${method}`)
        }
        mount.instance = provider
        return provider
      }).finally(() => { if (mount.pending === pending) mount.pending = undefined })
      mount.pending = pending
    }
    return mount.pending
  }

  clear(): void {
    for (const mount of this.mounts.values()) this.release(mount)
    this.mounts.clear()
  }

  private alive(mount: Mount): boolean {
    try { return mount.registration.isAlive() === true } catch { return false }
  }
  private release(mount: Mount): void {
    mount.instance?.dispose?.()
    mount.instance = undefined
    mount.pending = undefined
  }
}

export const providerRegistry = new ProviderRegistry()
export function startProviderDiscovery(): () => void {
  return listenForProviders(registration => {
    try { providerRegistry.register(registration) }
    catch (error) { console.warn('[VFS provider]', error) }
  })
}
