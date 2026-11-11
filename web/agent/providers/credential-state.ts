/**
 * One credential state per provider identity (#281).
 *
 * Today "can this provider be used" is represented five times: `hasApiKey`,
 * `hasApiKeyLoaded`, `modelCredentialStatus`, a module-level api-key cache, and
 * the gateway's own status mirror. Every bug in this area has been two of them
 * disagreeing (#172, #179/#180, #214, #277).
 *
 * This module is the single owner: one value per provider key, one writer, one
 * async resolver, and an epoch that makes a cached verdict unusable the moment
 * the credential changes. Nothing here knows how a particular provider gets its
 * credential — resolvers are registered by the provider's own module, so this
 * file stays free of auth imports and cannot create an import cycle.
 *
 * Step 2 of #281 introduces it without wiring: the store fields stay as they
 * are until the migration step deletes them.
 */

export type CredentialKind = 'unknown' | 'missing' | 'valid' | 'expired' | 'temporary'

export interface CredentialState {
  readonly kind: CredentialKind
  /** Monotonic registry counter; a consumer that cached a verdict must drop it when this changes. */
  readonly epoch: number
  /** When this verdict was observed (ms). */
  readonly observedAt: number
  /** `valid` only: when the credential stops being usable, if the provider knows. */
  readonly expiresAt?: number
  /** `temporary` only: the failure that produced it (never shown verbatim to users). */
  readonly error?: unknown
  /** `expired` only: when the credential was first observed dead in this session (#282). */
  readonly since?: number
  /** True when the value is the last known verdict, served because a resolve timed out. */
  readonly stale?: boolean
}

export type CredentialVerdict = Omit<CredentialState, 'epoch' | 'observedAt'>

export type CredentialResolver = (options: { refresh: boolean }) => Promise<CredentialVerdict>

export type CredentialListener = (state: CredentialState) => void

/**
 * How long a resolve may take before the caller gets the last known verdict (or
 * `temporary`). "Neutral" is only allowed to be brief: a UI that never learns
 * the answer is the silent-dead-UI bug this replaces (#281 decision comment).
 */
export const CREDENTIAL_RESOLVE_TIMEOUT_MS = 1800

export class CredentialRegistry {
  private readonly states = new Map<string, CredentialState>()

  private readonly resolvers = new Map<string, CredentialResolver>()

  private readonly inflight = new Map<string, Promise<CredentialState>>()

  private readonly listeners = new Map<string, Set<CredentialListener>>()

  private epoch = 0

  constructor(private readonly timeoutMs: number = CREDENTIAL_RESOLVE_TIMEOUT_MS) {}

  /** The current verdict. Never throws; unknown until something resolves or commits. */
  getState(providerKey: string): CredentialState {
    return this.states.get(providerKey) ?? {
      kind: 'unknown',
      epoch: this.epoch,
      observedAt: 0,
    }
  }

  /** True when a consumer's cached verdict is still current. */
  isCurrent(providerKey: string, epoch: number): boolean {
    return this.getState(providerKey).epoch === epoch
  }

  subscribe(providerKey: string, listener: CredentialListener): () => void {
    const set = this.listeners.get(providerKey) ?? new Set<CredentialListener>()
    set.add(listener)
    this.listeners.set(providerKey, set)
    return () => {
      const current = this.listeners.get(providerKey)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.listeners.delete(providerKey)
    }
  }

  /**
   * Register how a provider key is resolved. One resolver per key; the
   * provider's own module owns it, so the registry never imports auth code.
   */
  registerResolver(providerKey: string, resolver: CredentialResolver): () => void {
    this.resolvers.set(providerKey, resolver)
    return () => {
      if (this.resolvers.get(providerKey) === resolver) this.resolvers.delete(providerKey)
    }
  }

  /**
   * Record a verdict from an authoritative path (login, refresh, logout).
   * This is the only writer: it bumps the epoch, so every cached copy becomes
   * visibly stale in the same tick.
   */
  commit(providerKey: string, verdict: CredentialVerdict): CredentialState {
    this.epoch += 1
    const next: CredentialState = {
      ...verdict,
      epoch: this.epoch,
      observedAt: Date.now(),
    }
    this.states.set(providerKey, next)
    this.emit(providerKey, next)
    return next
  }

  /**
   * Ask the provider's resolver for a verdict, single-flight per key.
   *
   * On timeout the caller gets the last known verdict (marked `stale`) or
   * `temporary` when there never was one — never `unknown`, and never a
   * promise that outlives the deadline.
   */
  async resolve(providerKey: string, options: { refresh?: boolean } = {}): Promise<CredentialState> {
    const running = this.inflight.get(providerKey)
    if (running) return running

    const resolver = this.resolvers.get(providerKey)
    if (!resolver) return this.getState(providerKey)

    const run = (async (): Promise<CredentialState> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.timeoutMs)
      })
      try {
        const outcome = await Promise.race([
          resolver({ refresh: options.refresh === true }),
          deadline,
        ])
        if (outcome === 'timeout') return this.fallBack(providerKey)
        return this.commit(providerKey, outcome)
      } catch (error) {
        return this.commit(providerKey, { kind: 'temporary', error })
      } finally {
        if (timer) clearTimeout(timer)
        this.inflight.delete(providerKey)
      }
    })()

    this.inflight.set(providerKey, run)
    return run
  }

  private fallBack(providerKey: string): CredentialState {
    const known = this.states.get(providerKey)
    if (known && known.kind !== 'unknown') return { ...known, stale: true }
    return this.commit(providerKey, { kind: 'temporary', error: new Error('credential resolve timed out') })
  }

  private emit(providerKey: string, state: CredentialState): void {
    const set = this.listeners.get(providerKey)
    if (!set) return
    for (const listener of [...set]) {
      try {
        listener(state)
      } catch (error) {
        // A broken subscriber must not stop the others or the commit.
        console.error('[credential-state] listener failed:', error)
      }
    }
  }
}

/** The app-wide registry. Providers register their resolvers at module init. */
export const credentialRegistry = new CredentialRegistry()
