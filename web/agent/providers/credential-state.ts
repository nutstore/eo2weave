/**
 * One credential state per provider identity (#281).
 *
 * Today "can this provider be used" is represented five times: `hasApiKey`,
 * `hasApiKeyLoaded`, `modelCredentialStatus`, a module-level api-key cache, and
 * the gateway's own status mirror. Every bug in this area has been two of them
 * disagreeing (#172, #179/#180, #214, #277).
 *
 * This module is the single owner: one value per provider key, one writer, one
 * async resolver per key, and an epoch that makes a cached verdict unusable the
 * moment the credential changes. Nothing here knows how a particular provider
 * gets its credential — resolvers are registered by the provider's own module,
 * so this file stays free of auth imports and cannot create an import cycle.
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
  /** True when this is the last known verdict, served because an attempt timed out. */
  readonly stale?: boolean
}

export type CredentialVerdict = Omit<CredentialState, 'epoch' | 'observedAt'>

/** Aborted when the registry abandons an attempt (#286 review). */
export interface CredentialResolverContext {
  signal: AbortSignal
  /**
   * True when the caller needs a verdict from the server rather than from the
   * local store (e.g. the previous attempt was rejected). A resolver that
   * cannot force a refresh may ignore it.
   */
  refresh: boolean
}

export type CredentialResolver = (context: CredentialResolverContext) => Promise<CredentialVerdict>

export type CredentialListener = (state: CredentialState) => void

/**
 * How long a resolve may keep its CALLER waiting before it gets the last known
 * verdict (or `temporary`). This is not a cancellation: the attempt keeps
 * running and its result still lands if nothing newer committed meanwhile —
 * aborting a token refresh mid-flight is worse than answering late.
 * "Neutral" is only allowed to be brief (#281 decision comment).
 */
export const CREDENTIAL_RESOLVE_TIMEOUT_MS = 1800

interface InflightAttempt {
  readonly promise: Promise<CredentialState>
  readonly refresh: boolean
  readonly startedAt: number
  readonly version: number
  readonly controller: AbortController
}

export class CredentialRegistry {
  private readonly states = new Map<string, CredentialState>()

  private readonly resolvers = new Map<string, CredentialResolver>()

  private readonly inflight = new Map<string, InflightAttempt>()

  private readonly listeners = new Map<string, Set<CredentialListener>>()

  /** Per-key counter bumped only by authoritative commits, never by timeout hints. */
  private readonly versions = new Map<string, number>()

  private readonly snapshots = new Map<string, CredentialState>()

  private snapshotEpoch = -1

  private epoch = 0

  constructor(
    private readonly timeoutMs: number = CREDENTIAL_RESOLVE_TIMEOUT_MS,
    /**
     * How long an attempt may stay in flight before it is abandoned and a new
     * one may start. Preserving the in-flight promise is what stops duplicate
     * refreshes, but a resolver that never settles must not be able to block
     * every later call forever (#286 review).
     */
    private readonly abandonAfterMs: number = 10_000,
  ) {}

  /**
   * Clear every verdict. Tests use this to keep the module-level singleton from
   * leaking state between cases; the app never calls it.
   */
  reset(): void {
    this.states.clear()
    this.versions.clear()
    this.inflight.clear()
    this.epoch += 1
  }

  /** The current verdict. Never throws; unknown until something resolves or commits. */
  getState(providerKey: string): CredentialState {
    // One snapshot per (key, epoch): callers may hand this straight to
    // `useSyncExternalStore`, which re-renders whenever the reference changes
    // (#286 review).
    if (this.snapshotEpoch !== this.epoch) {
      this.snapshots.clear()
      this.snapshotEpoch = this.epoch
    }
    const cached = this.snapshots.get(providerKey)
    if (cached) return cached

    const known = this.states.get(providerKey)
    // Stamp the CURRENT epoch, not the one this verdict was published under:
    // otherwise a fresh read of a key that has not changed still compares
    // older-than-global and reads as stale forever (#286 review).
    const snapshot: CredentialState = known
      ? { ...known, epoch: this.epoch }
      : { kind: 'unknown', epoch: this.epoch, observedAt: 0 }
    this.snapshots.set(providerKey, snapshot)
    return snapshot
  }

  /** True when a consumer's cached verdict is still current. */
  isCurrent(epoch: number): boolean {
    return this.epoch === epoch
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
   *
   * Registering does NOT resolve: the provider calls `resolve()` right after
   * registration (its registration path already knows a credential may exist).
   * A key without a resolver answers `unknown` rather than inventing a verdict.
   */
  registerResolver(providerKey: string, resolver: CredentialResolver): () => void {
    this.resolvers.set(providerKey, resolver)
    return () => {
      if (this.resolvers.get(providerKey) === resolver) this.resolvers.delete(providerKey)
    }
  }

  hasResolver(providerKey: string): boolean {
    return this.resolvers.has(providerKey)
  }

  /**
   * Record a verdict from an authoritative path (login, refresh, logout).
   *
   * This is the only writer. It bumps the epoch (so cached copies are visibly
   * stale) and the key's version (so a resolve that started earlier cannot
   * overwrite it).
   */
  commit(providerKey: string, verdict: CredentialVerdict): CredentialState {
    this.versions.set(providerKey, this.versionOf(providerKey) + 1)
    return this.publish(providerKey, verdict)
  }

  /**
   * Ask the provider's resolver for a verdict.
   *
   * - Single-flight per key: a second caller joins the attempt in progress.
   * - `refresh: true` is never satisfied by a non-refreshing attempt: it waits
   *   for that attempt and then runs its own.
   * - The caller is bounded by the registry's timeout; the attempt is not
   *   cancelled, and its verdict is discarded if anything authoritative
   *   committed while it was running.
   */
  async resolve(providerKey: string, options: { refresh?: boolean } = {}): Promise<CredentialState> {
    // One deadline for the WHOLE call: waiting for a plain attempt and then
    // running a refreshing one must not add up to twice the contract (#286
    // review).
    return this.resolveWithin(providerKey, options.refresh === true, Date.now() + this.timeoutMs)
  }

  private async resolveWithin(
    providerKey: string,
    refresh: boolean,
    deadline: number,
  ): Promise<CredentialState> {
    const running = this.takeInflight(providerKey)

    if (running) {
      if (!refresh || running.refresh) {
        return (await this.wait(providerKey, running, deadline)).state
      }
      // The attempt in flight cannot satisfy a forced refresh. Wait for it —
      // but bounded, like every other caller: queueing without a deadline
      // behind an attempt that never settles is an unbounded wait
      // (#286 review).
      const waited = await this.wait(providerKey, running, deadline)
      if (waited.timedOut) return waited.state
      return this.resolveWithin(providerKey, true, deadline)
    }

    const resolver = this.resolvers.get(providerKey)
    if (!resolver) return this.getState(providerKey)

    const version = this.versionOf(providerKey)
    const controller = new AbortController()
    const attempt: InflightAttempt = {
      refresh,
      version,
      startedAt: Date.now(),
      controller,
      promise: this.runResolver(providerKey, resolver, refresh, version, controller.signal),
    }
    this.inflight.set(providerKey, attempt)
    // Keep the entry until the RESOLVER settles, not until the caller's
    // deadline: dropping it earlier would let the next call start a second
    // resolver (and a second refresh) while the first is still running.
    void attempt.promise
      .finally(() => {
        if (this.inflight.get(providerKey) === attempt) this.inflight.delete(providerKey)
      })
      .catch(() => undefined)

    return (await this.wait(providerKey, attempt, deadline)).state
  }

  /**
   * The in-flight attempt, unless it has outlived the abandon horizon — a
   * resolver that never settles must not permanently block new attempts. The
   * abandoned attempt still runs; its verdict is version-guarded like any
   * other late result.
   */
  private takeInflight(providerKey: string): InflightAttempt | undefined {
    const attempt = this.inflight.get(providerKey)
    if (!attempt) return undefined
    if (Date.now() - attempt.startedAt < this.abandonAfterMs) return attempt
    this.inflight.delete(providerKey)
    // The abandoned attempt is VOID: bump the version so its late verdict can
    // never beat the attempt that replaces it, and abort so a resolver that
    // can stop does (#286 review).
    this.versions.set(providerKey, this.versionOf(providerKey) + 1)
    attempt.controller.abort()
    return undefined
  }

  private async runResolver(
    providerKey: string,
    resolver: CredentialResolver,
    refresh: boolean,
    version: number,
    signal: AbortSignal,
  ): Promise<CredentialState> {
    let verdict: CredentialVerdict
    try {
      verdict = await resolver({ refresh, signal })
    } catch (error) {
      return this.land(providerKey, version, { kind: 'temporary', error })
    }
    return this.land(providerKey, version, verdict)
  }

  /**
   * Commit a resolver result unless something authoritative happened while it
   * was running: an old verdict must never resurrect a logout or a newer login.
   */
  private land(providerKey: string, version: number, verdict: CredentialVerdict): CredentialState {
    if (this.versionOf(providerKey) !== version) return this.getState(providerKey)
    return this.commit(providerKey, verdict)
  }

  private async wait(
    providerKey: string,
    attempt: InflightAttempt,
    deadlineAt: number,
  ): Promise<{ state: CredentialState; timedOut: boolean }> {
    const remaining = Math.max(0, deadlineAt - Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), remaining)
    })
    try {
      const outcome = await Promise.race([attempt.promise, deadline])
      if (outcome !== 'timeout') return { state: outcome, timedOut: false }
      return { state: this.publishTimeout(providerKey, attempt.version), timedOut: true }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Tell readers the attempt timed out. Published (epoch bumped, subscribers
   * notified) so a UI driven by `subscribe` learns it too — but it does NOT
   * bump the version, because it is a hint about our patience, not a statement
   * about the credential; the attempt still in flight may land right after.
   */
  private publishTimeout(providerKey: string, startVersion: number): CredentialState {
    // A commit that landed while this attempt was waiting is newer than the
    // attempt: stamping THAT verdict stale would mislabel a fresh login
    // (#286 review).
    if (this.versionOf(providerKey) !== startVersion) return this.getState(providerKey)
    const known = this.states.get(providerKey)
    if (known && known.kind !== 'unknown') {
      if (known.stale) return known
      return this.publish(providerKey, { ...known, stale: true })
    }
    return this.publish(providerKey, {
      kind: 'temporary',
      error: new Error('credential resolve timed out'),
    })
  }

  private versionOf(providerKey: string): number {
    return this.versions.get(providerKey) ?? 0
  }

  private publish(providerKey: string, verdict: CredentialVerdict): CredentialState {
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
