/**
 * Conversation load pipeline
 *
 * Everything the conversation store does to bring itself up: the bounded
 * SQLite/OPFS bootstrap, the legacy-migration recovery passes, the active
 * transcript read, the active workspace ensure, and the targeted retry
 * machinery with its generation guards.
 *
 * Extracted from `conversation.store.sqlite.ts` (issue #245). The pipeline is
 * driven entirely through `set`/`get`, so the move is mechanical: no store
 * internals are touched, and the store keeps owning only its state, its
 * guarded writes and the eviction wiring.
 */
import type { Conversation, Message } from '@/agent/message-types'
import { createToolMessage } from '@/agent/message-types'
import { getMessageRepository, getSQLiteDB, initSQLiteDB } from '@/sqlite'
import {
  beginConversationLoadGeneration,
  isCurrentConversationLoadGeneration,
  loadConversationsMeta,
  persistMessageReplace,
  primePersistBaseline,
  resetInflightLoadForTests,
} from '@/store/conversation-persist'
import { CONVERSATION_STORE_LOAD_ERROR_KEY } from '@/lib/app-storage-keys'
import {
  DEFAULT_CONVERSATION_NAME,
  healCompressionBaseline,
  makeSyntheticAskUserResult,
} from './conversation-message-ops'
import { useConversationContextStore } from './conversation-context.store'

/**
 * The state slice the load pipeline reads and writes. `ConversationState` in
 * the store extends it, so the same `set`/`get` pair is passed straight
 * through.
 */
export interface ConversationLoadState {
  conversations: Conversation[]
  activeConversationId: string | null
  loaded: boolean
  /** Last loadFromDB error, if any. Metadata failures keep `loaded` false;
   * workspace and transcript failures keep the loaded conversation list. */
  loadError: string | null
  /** Scope of `loadError`:
   *  - 'metadata' — the conversation LIST itself failed to load. No rows are
   *    available, so the UI must not pretend the history is empty-but-fine.
   *  - 'transcript' — the list loaded fine, only the ACTIVE conversation's
   *    transcript read failed. The rows are usable: the user must still be
   *    able to pick a different conversation (issue #147, PR #149 review).
   *  - 'workspace' — the list loaded, but the active OPFS workspace could
   *    not be opened. Keep the rows visible and offer Retry.
   *  - null — no error (or an error of unknown scope). */
  loadErrorScope: 'metadata' | 'transcript' | 'workspace' | null
  /** The conversation whose transcript read produced the current
   * `loadError` (when `loadErrorScope === 'transcript'`). The persisted
   * failure record may only be marked resolved after the transcript of THIS
   * conversation re-read successfully — switching to any other conversation
   * (different, absent or cached) proves nothing about the failed one
   * (issue #147, PR #149 review). */
  loadFailedConversationId: string | null
  loadFailedWorkspaceId: string | null
  /** Follow-up suggestions (not persisted) - per conversation. */
  suggestedFollowUps: Map<string, string>
  /** Run IDs cancelled by the user (not persisted). */
  cancelledRunIds: Set<string>
}

type LoadSet<S extends ConversationLoadState> = (recipe: (state: S) => void) => void
type LoadGet<S extends ConversationLoadState> = () => S

/**
 * Reject after `ms` even if the wrapped promise never settles. The losing
 * promise is left running (no cancellation) but its result is discarded.
 */
class LoadTimeoutError extends Error {
  constructor(readonly operation: string, ms: number) {
    super(`${operation} timed out after ${ms}ms`)
    this.name = 'LoadTimeoutError'
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new LoadTimeoutError(what, ms))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * How long the fallback metadata re-read inside loadFromDB's failure path may
 * take before it is abandoned as a retryable failure (PR #149 round-6 review,
 * "Fallback hang hides retry"). A hung read must surface as an error so the
 * sidebar's Retry stays available.
 */
const FALLBACK_META_TIMEOUT_MS = 10_000

/**
 * Bound for the unbounded-promise legs of the INITIAL load: SQLite/OPFS
 * initialization, the legacy migration pass, the workspace-manager ensure,
 * and the primary metadata read. Before this bound, a leg whose promise
 * never settled kept `runLoadFromDB` pending forever — the fallback timeout
 * was never reached and `loadError` was never recorded, so the sidebar
 * stayed blank with no Retry (PR #149 round-7 review, "Hung startup offers
 * no retry"). A hung leg now rejects into the existing catch, which records
 * a retryable failure and runs the bounded one-shot fallback.
 */
export const INITIAL_LOAD_TIMEOUT_MS = 15_000
/**
 * Same bound as above, but overridable per test file via
 * `globalThis.__CONVERSATION_LOAD_TIMEOUT_MS__` (set in a `beforeAll`).
 * Production code reads it once at module init; tests that exercise the
 * load-timeout→fallback path (created-conversation merge, stale-banner
 * cleanup) need the 15s bound compressed or those runs would outlast the
 * vitest default 10s test timeout.
 */
const TEST_INITIAL_LOAD_TIMEOUT_MS = (): number =>
  Number(
    (globalThis as Record<string, unknown>).__CONVERSATION_LOAD_TIMEOUT_MS__ ?? INITIAL_LOAD_TIMEOUT_MS
  )

/**
 * Persist a load failure for Diagnostics (issue #147 — same pattern as the
 * project store's sessionStorage init-error record). `conversationId` records
 * WHICH conversation's transcript failed so recovery can later be verified
 * against that exact conversation (PR #149 round-4 review) — a transcript read
 * of any other conversation proves nothing about this one. `workspaceId`
 * similarly identifies an OPFS workspace ensure failure.
 */
export function persistLoadErrorRecord(
  message: string,
  error: unknown,
  conversationId?: string | null,
  workspaceId?: string | null
): void {
  try {
    sessionStorage.setItem(
      CONVERSATION_STORE_LOAD_ERROR_KEY,
      JSON.stringify({
        message,
        stack: error instanceof Error ? error.stack : undefined,
        at: new Date().toISOString(),
        ...(conversationId ? { conversationId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      })
    )
  } catch {
    // sessionStorage unavailable (SSR / disabled storage) — console is enough.
  }
}

/**
 * Success MARKS the previous load-failure record resolved instead of deleting
 * it (mirrors project.store, issue #147) — a user who reloaded into a working
 * app must still be able to attach the ORIGINAL failure to a bug report via
 * Diagnostics.
 *
 * `resolvedForConversationId` identifies the conversation or workspace just
 * verified. A record naming a different `conversationId` or `workspaceId`
 * stays unresolved. Legacy records written
 * before the id was persisted (and metadata-scope records, which name no
 * conversation) keep the old behavior: a fully successful load resolves them.
 *
 * `requireNamedConversation` (PR #149 round-5 review, "Transcript read
 * resolves metadata failure"): callers whose proof is a TRANSCRIPT read of a
 * single conversation (setActive) must pass it — a metadata-scope/legacy
 * record names a failure of the metadata layer, which such a read never
 * exercises, so it may only be resolved by a full loadFromDB where the
 * metadata layer itself re-read successfully.
 *
 * `requireWorkspaceEnsure` (PR #152 review, "Workspace failure reported as
 * recovered"): callers whose proof is a transcript read must pass true — a
 * WORKSPACE-scope record names an OPFS ensure failure, which no transcript
 * read exercises, so it may only be resolved by a path where the workspace
 * ensure itself succeeded (which passes false or omits the option).
 *
 * `workspaceEnsureVerified` (PR #152 review, "Skipped workspace ensure is
 * reported recovered" / "Wrong workspace failure is resolved"): full-load
 * callers pass whether THIS run's ensureActiveWorkspace verified the active
 * workspace (opened or already loaded). A WORKSPACE-scope record is only
 * resolved when that proof is true — an ensure that skipped its target
 * (null/absent active id) proves nothing about the OPFS layer, and a record
 * naming workspace B must not be resolved by an ensure of workspace A.
 */
export function markPersistedFailureResolved(
  resolvedForConversationId?: string | null,
  options?: {
    requireNamedConversation?: boolean
    requireWorkspaceEnsure?: boolean
    workspaceEnsureVerified?: boolean
    ensuredWorkspaceId?: string | null
  }
): void {
  try {
    const raw = sessionStorage.getItem(CONVERSATION_STORE_LOAD_ERROR_KEY)
    if (raw) {
      const record = JSON.parse(raw) as {
        resolved?: boolean
        conversationId?: string
        workspaceId?: string
      }
      if (
        record.conversationId &&
        record.conversationId !== resolvedForConversationId
      ) {
        // The recorded failure belongs to a conversation that was NOT the
        // one just re-read — leave it unresolved so Diagnostics keeps
        // reporting it until its own transcript loads.
        return
      }
      if (record.workspaceId && record.workspaceId !== resolvedForConversationId) return
      if (options?.requireNamedConversation && !record.conversationId) {
        // A metadata-scope/legacy record: this transcript-only read proves
        // nothing about the metadata layer — leave it unresolved until a
        // full load (metadata re-read included) succeeds.
        return
      }
      if (record.workspaceId && options?.requireWorkspaceEnsure) {
        // A workspace-scoped record and this caller's proof is a transcript
        // read only: the read does NOT prove the OPFS workspace opened —
        // leave it unresolved until a path that ran ensureActiveWorkspace
        // successfully resolves it (PR #152 review).
        return
      }
      if (
        record.workspaceId &&
        options?.workspaceEnsureVerified === false
      ) {
        // A workspace-scoped record and THIS run's ensure skipped its target
        // (null/absent active id): the run never verified any workspace, so
        // it cannot prove this record's workspace recovered
        // (PR #152 review, "Skipped workspace ensure is reported recovered").
        return
      }
      if (
        record.workspaceId &&
        options?.ensuredWorkspaceId != null &&
        record.workspaceId !== options.ensuredWorkspaceId
      ) {
        // Selection changed while the ensure was in flight: this run verified
        // a DIFFERENT workspace than the one the record names, so the record's
        // OPFS layer is still unproven — leave it unresolved
        // (PR #152 review, "Wrong workspace failure is resolved").
        return
      }
      sessionStorage.setItem(
        CONVERSATION_STORE_LOAD_ERROR_KEY,
        JSON.stringify({ ...record, resolved: true })
      )
    }
  } catch {
    // sessionStorage unavailable / malformed — leave the record as is.
  }
}

type WorkspaceEnsureStatus =
  | 'ensured'
  | 'already-loaded'
  | 'missing-target'

/**
 * Ensure the OPFS workspace for `activeId` exists. The return value tells the
 * caller WHICH proof it obtained: a workspace-scoped failure record may only
 * be marked resolved after the workspace it names was genuinely ensured (or
 * was already loaded) by this call — a missing target proves nothing
 * (PR #152 review, "Skipped workspace ensure is reported recovered" and
 * "Missing workspace treated as recovered").
 */
async function ensureActiveWorkspace(
  conversations: Array<Pick<Conversation, 'id' | 'title'>>,
  activeId: string | null
): Promise<WorkspaceEnsureStatus> {
  const target = conversations.find((conversation) => conversation.id === activeId)
  if (!target) return 'missing-target'

  const { getWorkspaceManager } = await import('@/opfs')
  const manager = await withTimeout(
    getWorkspaceManager(),
    INITIAL_LOAD_TIMEOUT_MS,
    'workspace manager initialization'
  )
  if (manager.isWorkspaceLoaded(target.id)) return 'already-loaded'

  await withTimeout(
    manager.createWorkspace(
      `workspaces/${target.id}`,
      target.id,
      target.title || DEFAULT_CONVERSATION_NAME,
    ),
    INITIAL_LOAD_TIMEOUT_MS,
    'active workspace ensure'
  )
  return 'ensured'
}

function selectActiveConversationId(conversations: Array<Pick<Conversation, 'id'>>): string | null {
  const workspaceStore = useConversationContextStore.getState()
  const preferredId = workspaceStore.activeWorkspaceId
  if (preferredId && conversations.some((conversation) => conversation.id === preferredId)) {
    return preferredId
  }
  return workspaceStore.workspaces.find((workspace) =>
    conversations.some((conversation) => conversation.id === workspace.id)
  )?.id || null
}

let activeSelectionGeneration = 0
const transcriptReadGenerations = new Map<string, number>()
/**
 * Per-conversation transcript mutation watermark. Bumped by every in-memory
 * transcript mutation below (add/replace/delete/branch/compact/reload) so a
 * pending read can detect concurrent changes by version instead of comparing
 * message counts, which misses same-length edits, deletes, and reorders
 * (PR #152 review, "Concurrent transcript edits disappear").
 */
const conversationTranscriptVersions = new Map<string, number>()

export function bumpTranscriptVersion(conversationId: string): void {
  conversationTranscriptVersions.set(
    conversationId,
    (conversationTranscriptVersions.get(conversationId) ?? 0) + 1
  )
}


export function claimTranscriptRead(id: string): number {
  const generation = (transcriptReadGenerations.get(id) || 0) + 1
  transcriptReadGenerations.set(id, generation)
  return generation
}

export function isCurrentTranscriptRead(id: string, generation: number): boolean {
  return transcriptReadGenerations.get(id) === generation
}

/**
 * One targeted retry at a time per conversation: `withTimeout` rejects this
 * store's await but leaves the underlying `findByConversation` request /
 * workspace ensure running, so an immediate re-retry must not queue a second
 * outstanding operation behind a still-stalled first one. While a retry for
 * a conversation is in flight, further targeted retries return immediately
 * (the visible error stays, so the sidebar's Retry remains available once
 * the in-flight operation settles) (PR #152 review, "Timed-out reads
 * accumulate").
 */
const inflightRetries = new Map<string, Promise<void>>()

/**
 * Test-only: a test that deliberately leaves a retry hung (e.g. the
 * timed-out-retry scenario) keeps its slot in the maps above, and every
 * later test retrying the same conversation would silently no-op. Test
 * setups call this between scenarios.
 */
/**
 * Test-only: the current watermark version for a conversation.
 * Returns `undefined` when the conversation has NO entry (as opposed to a
 * version of 0), so a test can tell "never mutated" from "mutated and reset".
 */
export function getTranscriptVersionEntryForTests(conversationId: string): number | undefined {
  return conversationTranscriptVersions.get(conversationId)
}

export function resetConversationRetryStateForTests(): void {
  inflightRetries.clear()
  inflightRetryRefs.clear()
  // Reset the transcript watermark too: scenario A that mutated a seeded
  // conversation's transcript must not leave a higher version behind that
  // would change scenario B's install-guard arithmetic
  // (PR #152 review, "Recent transcript changes disappear").
  conversationTranscriptVersions.clear()
  transcriptReadGenerations.clear()
  // Also release the withInflightLoad slot: a prior scenario's deliberately
  // hung leg (e.g. a never-settling workspace ensure) keeps the slot forever,
  // and the next test's loadFromDB would silently no-op behind it
  // (PR #152 review, serial-run orphan in-flight load).
  resetInflightLoadForTests()
}

/**
 * Owner of an in-flight targeted retry's slot. `withTimeout` rejects the
 * retry's await while the underlying read/ensure keeps running, so releasing
 * the slot when the RETRY promise settles (at timeout) would let the next
 * Retry start a second operation behind the still-pending first one —
 * exactly the unbounded queueing "Timed-out retries queue more work"
 * describes. The run promise therefore resolves only when the UNDERLYING
 * operation settles (via settleUnderlying below); the slot's release in its
 * `finally` keeps the entry occupied across timeouts, and a later retry
 * awaits the SAME run instead of queueing new work.
 */
const inflightRetryRefs = new Map<string, { released: boolean }>()

function holdInflightRetrySlot(id: string): {
  run?: Promise<void>
  release: () => void
} {
  const ref: { released: boolean; run?: Promise<void> } = { released: false }
  inflightRetryRefs.set(id, ref)
  return {
    get run() {
      return ref.run
    },
    set run(p: Promise<void> | undefined) {
      ref.run = p
    },
    release: () => {
      ref.released = true
      if (inflightRetryRefs.get(id) === ref) inflightRetryRefs.delete(id)
    },
  }
}

export async function retryLoadedFailure<S extends ConversationLoadState>(
  set: LoadSet<S>,
  get: LoadGet<S>
): Promise<void> {
  const scope = get().loadErrorScope
  const errorAtStart = get().loadError
  const id = scope === 'transcript' ? get().loadFailedConversationId : get().loadFailedWorkspaceId
  if (!id || !errorAtStart || (scope !== 'transcript' && scope !== 'workspace')) return

  const inflight = inflightRetries.get(id)
  if (inflight) return inflight.catch(() => {})

  const slot = holdInflightRetrySlot(id)
  // Resolved when the UNDERLYING read/ensure settles — even if withTimeout
  // already rejected the retry's await at its bound. The run promise (and
  // with it the in-flight entry) waits for this gate, so a stalled operation
  // keeps the slot occupied and re-retries dedupe onto the SAME run instead
  // of queueing more work against the stalled worker
  // (PR #152 review, "Timed-out retries queue more work").
  let settleUnderlying: () => void = () => {}
  const underlyingSettled = new Promise<void>((resolve) => {
    settleUnderlying = resolve
  })
  // Hard cap: an operation that has not settled within twice its own timeout
  // bound will never settle (stalled worker). Release the slot anyway so the
  // sidebar's Retry becomes available again — a fresh retry is then the only
  // recovery path left, and the alternative (holding the entry forever)
  // would make recovery permanently unavailable.
  const slotCapTimer = setTimeout(
    settleUnderlying,
    2 * TEST_INITIAL_LOAD_TIMEOUT_MS()
  )
  const retryLeg = runRetryLoadedFailure(
    set, get, scope, errorAtStart, id, settleUnderlying
  )
  const run: Promise<void> = (async () => {
    try {
      await Promise.all([retryLeg.catch(() => {}), underlyingSettled])
    } finally {
      clearTimeout(slotCapTimer)
      slot.release()
      if (inflightRetries.get(id) === slot.run) inflightRetries.delete(id)
    }
  })()
  slot.run = run
  inflightRetries.set(id, run)
  // The CALLER returns as soon as the retry itself settles (success, failure,
  // or timeout rejection — already recorded in the store by the retry's own
  // catch). Only later re-retries (and slot release) wait for the underlying
  // operation via `run`.
  try {
    await retryLeg
  } catch {
    // Failure already recorded; nothing to add.
  }
}

/**
 * Wraps an optional callback so it fires at most once, and never throws.
 */
function once(fn?: () => void): () => void {
  if (!fn) return () => {}
  let called = false
  return () => {
    if (called) return
    called = true
    try {
      fn()
    } catch {
      // A gate callback must never break the retry path.
    }
  }
}

async function runRetryLoadedFailure<S extends ConversationLoadState>(
  set: LoadSet<S>,
  get: LoadGet<S>,
  scope: 'transcript' | 'workspace',
  errorAtStart: string,
  id: string,
  onUnderlyingSettled?: () => void
): Promise<void> {
  const generation = beginConversationLoadGeneration()
  const stillCurrent = () => isCurrentConversationLoadGeneration(generation)
  // Guarantees the run-level gate resolves even if the underlying operation
  // never does — otherwise a timed-out-but-still-pending read would hold the
  // in-flight slot forever.
  const settleOnce = once(onUnderlyingSettled)
  try {
    if (scope === 'transcript') {
      const transcriptGeneration = claimTranscriptRead(id)
      // Mutation watermark captured BEFORE the read: any in-memory transcript
      // mutation (add/edit/delete/reorder/compact) during the pending read
      // bumps it, so an older DB snapshot can be detected by version, not by
      // count — count misses same-length edits, deletes, and reorders
      // (PR #152 review, "Concurrent transcript edits disappear").
      const transcriptVersionAtReadStart = conversationTranscriptVersions.get(id) ?? 0
      // Overridable bound (TEST_INITIAL_LOAD_TIMEOUT_MS) rather than the fixed
      // 15s: tests exercising the timeout→retryable-failure path compress it,
      // and a deliberately-hung retry must settle quickly so its in-flight
      // slot (and the load-level dedupe slot) is released for later tests.
      // The RAW promise (not withTimeout's wrapper) signals the gate: the
      // wrapper rejects at the bound while the underlying request keeps
      // running, and the slot must stay occupied until the request itself
      // settles (PR #152 review, "Timed-out retries queue more work").
      const underlyingRead = getMessageRepository().findByConversation(id)
      underlyingRead.then(settleOnce, settleOnce)
      const messages = await withTimeout(
        underlyingRead,
        TEST_INITIAL_LOAD_TIMEOUT_MS(),
        'conversation transcript read'
      )
      if (!stillCurrent() || !isCurrentTranscriptRead(id, transcriptGeneration)) return
      const conversationBeforeInstall = get().conversations.find((item) => item.id === id)
      // If this conversation's in-memory transcript was mutated while the
      // read was pending, the freshly-read snapshot is older than what the
      // user already sees — installing it would make those edits disappear,
      // and priming it as the persist baseline could lose them from storage
      // (PR #152 review, "Concurrent transcript edits disappear"). Skip the
      // install; the in-memory state (already synced to the DB by the
      // writers) stays authoritative.
      // The watermark comparison is UNCONDITIONAL here: the guard must fire
      // even when the conversation row is metadata-only. A concurrent read
      // that installed newer content moved the watermark, and installing an
      // older snapshot over it would lose that content
      // (PR #152 review, "Stale snapshot can still win").
      const changedDuringRead =
        conversationBeforeInstall !== undefined &&
        (conversationTranscriptVersions.get(id) ?? 0) !== transcriptVersionAtReadStart
      if (!changedDuringRead) {
        primePersistBaseline(id, messages as Message[])
        set((state) => {
          const conversation = state.conversations.find((item) => item.id === id)
          if (conversation) {
            conversation.messages = messages as Message[]
            conversation.messagesLoaded = true
            healCompressionBaseline(conversation)
          }
        })
        // Installing the snapshot IS a transcript mutation: another read that
        // is pending right now must not accept its older snapshot over these
        // messages (and must not prime that older snapshot as the persistence
        // baseline) — the watermark has to move even though no user edit was
        // involved (PR #152 review, "Stale snapshot can still win").
        bumpTranscriptVersion(id)
      }
    } else {
      // A 'missing-target' result (the failed conversation was removed from
      // the store before the retry) proves nothing about the workspace the
      // record names — keep the failure visible and unresolved instead of
      // reporting recovery (PR #152 review, "Missing workspace treated as
      // recovered"). The ensure is therefore inlined here instead of going
      // through ensureActiveWorkspace: it must (a) treat an absent target as
      // NO proof, and (b) signal the settle gate from the RAW promises so a
      // timed-out-but-still-running manager init or workspace open keeps the
      // in-flight slot occupied (see the transcript branch above).
      const target = get().conversations.find((c) => c.id === id)
      if (!target) {
        settleOnce()
        return
      }
      const { getWorkspaceManager } = await import('@/opfs')
      const managerInit = getWorkspaceManager()
      managerInit.then(settleOnce, settleOnce)
      const manager = await withTimeout(
        managerInit,
        TEST_INITIAL_LOAD_TIMEOUT_MS(),
        'workspace manager initialization'
      )
      if (manager.isWorkspaceLoaded(id)) {
        // Already loaded IS the recovery proof — the underlying "operation"
        // is trivially done, so the gate releases with it.
        settleOnce()
      } else {
        const ensureOp = manager.createWorkspace(
          `workspaces/${id}`,
          id,
          target.title || DEFAULT_CONVERSATION_NAME,
        )
        ensureOp.then(settleOnce, settleOnce)
        await withTimeout(
          ensureOp,
          TEST_INITIAL_LOAD_TIMEOUT_MS(),
          'active workspace ensure'
        )
      }
      if (!stillCurrent()) return
    }

    if (get().loadError === errorAtStart && get().loadErrorScope === scope &&
        (scope === 'transcript' ? get().loadFailedConversationId === id :
          get().loadFailedWorkspaceId === id)) {
      // A workspace retry ran ensureActiveWorkspace itself — its success is
      // exactly the proof a workspace-scoped record requires, so it may
      // resolve it. A transcript retry never exercised the workspace layer
      // and must NOT (PR #152 review).
      markPersistedFailureResolved(id, { requireWorkspaceEnsure: scope === 'transcript' })
      const workspaceStillFailing =
        scope === 'transcript' ? get().loadFailedWorkspaceId : null
      set((state) => {
        if (workspaceStillFailing) {
          // The transcript recovered but this state also carried a
          // workspace-ensure failure (both legs failed during the same load).
          // The persisted record correctly stayed unresolved — the OPFS layer
          // is still unproven. Clearing the banner entirely would leave the
          // workspace unavailable with NO retry affordance, so keep (promote)
          // the workspace failure visible instead
          // (PR #152 review, "Workspace retry disappears after transcript
          // recovery").
          state.loadError = `Failed to open active workspace (conversation transcript recovered)`
          state.loadErrorScope = 'workspace'
          state.loadFailedConversationId = null
          state.loadFailedWorkspaceId = workspaceStillFailing
        } else {
          state.loadError = null
          state.loadErrorScope = null
          state.loadFailedConversationId = null
          state.loadFailedWorkspaceId = null
        }
      })
    }
  } catch (error) {
    // All three must match THIS retry: a stale run's caught error must not
    // overwrite a newer failure — including a failure recorded for a
    // DIFFERENT conversation while this retry was pending (PR #152 review,
    // "Wrong conversation failure is shown").
    if (!stillCurrent() || get().loadError !== errorAtStart || get().loadErrorScope !== scope ||
        (scope === 'transcript'
          ? get().loadFailedConversationId !== id
          : get().loadFailedWorkspaceId !== id)) return
    const message = error instanceof Error ? error.message : String(error)
    const loadMessage = scope === 'transcript'
      ? `Failed to load messages for active conversation: ${message}`
      : `Failed to open active workspace: ${message}`
    set((state) => {
      state.loadError = loadMessage
      state.loadErrorScope = scope
      state.loadFailedConversationId = scope === 'transcript' ? id : null
      state.loadFailedWorkspaceId = scope === 'workspace' ? id : null
    })
    persistLoadErrorRecord(
      loadMessage, error, scope === 'transcript' ? id : null,
      scope === 'workspace' ? id : null
    )
  }
}

/**
 * The full load implementation, shared by `loadFromDB` (guarded by the
 * in-flight dedupe) and `retryLoadFromDB` (forced, guard bypassed).
 */
export async function runLoadFromDB<S extends ConversationLoadState>(
  set: LoadSet<S>,
  get: LoadGet<S>
): Promise<void> {
  const t0 = performance.now()
  // Claim this run's generation NOW. If a forced retry (retryLoadFromDB)
  // starts later, it claims a newer generation and every guarded write below
  // (store state AND diagnostics records) becomes a no-op for THIS run when
  // it eventually settles — a stale run can no longer overwrite the state a
  // recovered retry installed (PR #149 round-6 review, "Stale retries
  // overwrite recovered state").
  const loadGeneration = beginConversationLoadGeneration()
  const isCurrentRun = () => isCurrentConversationLoadGeneration(loadGeneration)
  // Snapshot the selection generation BEFORE this run can yield or install
  // its own active id. Anything that changes the active selection while the
  // load is pending (setActive, createNew with activate) bumps the counter,
  // so the post-await checks below can preserve the user's newer choice
  // instead of overwriting it with this run's context-preferred id
  // (PR #152 review, "User selection is replaced").
  const selectionGenerationAtStart = activeSelectionGeneration
      try {
        // Initialize SQLite first. Bounded: a hung OPFS/SQLite handshake must
        // not wedge startup before the fallback timeout is ever reached
        // (PR #149 round-7 review, "Hung startup offers no retry").
        await withTimeout(initSQLiteDB(), TEST_INITIAL_LOAD_TIMEOUT_MS(), 'SQLite initialization')
        const tSqlite = performance.now()
        // Force one legacy message migration pass in main thread.
        // This repairs cases where worker-side migration was skipped in previous versions.
        try {
          const msgRepo = getMessageRepository()
          const migrated = await withTimeout(
            msgRepo.migrateFromJsonBlob(),
            TEST_INITIAL_LOAD_TIMEOUT_MS(),
            'legacy message migration'
          )
          if (migrated.messages > 0) {
            console.log(
              `[conversation.store] Recovered ${migrated.messages} legacy messages across ${migrated.conversations} conversations`
            )
          }
          const db = getSQLiteDB()
          const missingConversations = await withTimeout(
            db.queryFirst<{ count: number }>(
              `SELECT COUNT(*) as count
               FROM conversations c
               WHERE NOT EXISTS (
                 SELECT 1 FROM messages m WHERE m.conversation_id = c.id LIMIT 1
               )`,
            ),
            TEST_INITIAL_LOAD_TIMEOUT_MS(),
            'migration missing-conversation probe'
          )
          if ((missingConversations?.count ?? 0) > 0) {
            const recovered = await withTimeout(
              msgRepo.recoverFromAppSessions(),
              TEST_INITIAL_LOAD_TIMEOUT_MS(),
              'AppSessions message recovery'
            )
            if (recovered.messages > 0) {
              console.log(
                `[conversation.store] Recovered ${recovered.messages} messages from AppSessions (${recovered.conversations} conversations, ${recovered.sessions} snapshots)`
              )
            }
          }
        } catch (migrationError) {
          if (migrationError instanceof LoadTimeoutError) throw migrationError
          console.warn('[conversation.store] Legacy message migration pass failed:', migrationError)
        }
        const tMigrate = performance.now()

        const conversations = await withTimeout(
          loadConversationsMeta(),
          TEST_INITIAL_LOAD_TIMEOUT_MS(),
          'conversation metadata read'
        )
        const tLoadMeta = performance.now()

        // Orphan recovery: find ask_user_question tool_calls in committed messages
        // that have no matching tool result. This happens when the user refreshed
        // the page (or the browser closed) while a question was waiting for input —
        // the in-memory Promise is lost, but the committed draft is restored from
        // SQLite without a tool result. Without this pass, the user sees nothing
        // for that question and has no way to continue. We inject a synthetic
        // tool result using the tool_call's default_answer so QuestionCard shows
        // the question in "answered" state with a clear interrupted warning.
        try {
          let recoveredCount = 0
          for (const conv of conversations) {
            if (!conv.messages || conv.messages.length === 0) continue
            // Build set of answered toolCallIds for fast lookup
            const answeredIds = new Set<string>()
            for (const m of conv.messages) {
              if (m.role === 'tool' && typeof m.toolCallId === 'string') {
                answeredIds.add(m.toolCallId)
              }
            }
            // Walk messages, find orphaned ask_user_question tool_calls,
            // inject synthetic tool result right after the assistant message.
            // Use a single pass + index-based insertion to avoid mutating during iteration.
            const newMessages: typeof conv.messages = []
            let mutated = false
            for (const m of conv.messages) {
              newMessages.push(m)
              if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
                for (const tc of m.toolCalls) {
                  if (tc.function.name !== 'ask_user_question') continue
                  if (answeredIds.has(tc.id)) continue
                  // Orphaned ask_user_question — synthesize a tool result.
                  newMessages.push(
                    createToolMessage({
                      toolCallId: tc.id,
                      name: tc.function.name,
                      content: makeSyntheticAskUserResult(tc.function.arguments),
                    }),
                  )
                  // Avoid double-injection if another message somehow already references it.
                  answeredIds.add(tc.id)
                  recoveredCount++
                  mutated = true
                }
              }
            }
            if (mutated) {
              conv.messages = newMessages
              // A pre-install in-memory mutation: bump the watermark so the
              // pending active-transcript read of THIS conversation does not
              // later overwrite the repaired list with its older snapshot
              // (PR #152 review, "Recent transcript changes disappear").
              bumpTranscriptVersion(conv.id)
              // Persist the recovered messages so the next load doesn't re-run the same work.
              await persistMessageReplace(conv.id, newMessages).catch((err) => {
                console.warn(
                  `[conversation.store] Failed to persist recovered orphan for ${conv.id}:`,
                  err,
                )
              })
            }
          }
          if (recoveredCount > 0) {
            console.info(
              `[conversation.store] Recovered ${recoveredCount} orphaned ask_user_question call(s) from a previous session (page refresh / browser close).`,
            )
          }
        } catch (orphanRecoveryError) {
          console.warn('[conversation.store] Orphan ask_user_question recovery pass failed:', orphanRecoveryError)
        }

        // Ensure OPFS conversations exist — but ONLY for the active workspace.
        // switchWorkspace already has lazy self-healing (workspace.store.ts:
        // "Workspace exists in SQLite but OPFS missing → recreate"), so
        // iterating all N conversations on every page load was redoing O(N)
        // SQLite/OPFS probes for no benefit. Measured impact: 4.9s for 119
        // conversations before this fix.
        const tManager = performance.now()
        let ensuredCount = 0
        let ensuredSkipped = 0
        let workspaceEnsureError: unknown = null
        // Which proof this run's ensure obtained for the captured active
        // workspace. Resolution of a workspace-scoped record below requires
        // the recorded workspace to be VERIFIED by this run — a skipped or
        // missing-target ensure proves nothing about the OPFS layer
        // (PR #152 review, "Skipped workspace ensure is reported recovered").
        let workspaceEnsureVerified = false
        // The workspace id THIS run's ensure actually targeted and verified.
        // Selection can change while the ensure is in flight, so the id used
        // at resolution time (activeIdToInstall) may differ from the id whose
        // OPFS layer this run proved — a workspace-scoped failure record is
        // only resolved when it names THE verified workspace
        // (PR #152 review, "Wrong workspace failure is resolved").
        let ensuredWorkspaceId: string | null = null
        const activeWsId = useConversationContextStore.getState().activeWorkspaceId
        try {
          const ensureStatus = await ensureActiveWorkspace(conversations, activeWsId)
          if (ensureStatus !== 'missing-target') {
            workspaceEnsureVerified = true
            ensuredWorkspaceId = activeWsId
            ensuredCount++
          } else {
            ensuredSkipped = conversations.length
          }
        } catch (e) {
          workspaceEnsureError = e
          console.warn('[conversation.store] Active workspace ensure failed:', e)
        }
        const tEnsure = performance.now()
        console.log(
          `[conversation.store] loadFromDB phase timings (${Math.round(performance.now() - t0)}ms total)`,
          {
            sqliteInitMs: Math.round(tSqlite - t0),
            migrateMs: Math.round(tMigrate - tSqlite),
            loadMetaMs: Math.round(tLoadMeta - tMigrate),
            ensureOpfsMs: Math.round(tEnsure - tManager),
            conversationCount: conversations.length,
            ensuredActive: ensuredCount,
            lazyDeferred: ensuredSkipped,
          }
        )

        // NOTE: workspace switching is handled by syncFromRoute in App.tsx.
        // loadFromDB only loads conversation data; it does NOT call refreshWorkspaces or switchWorkspace.

        // Determine the active conversation ID from workspace store's current state.
        const activeId = selectActiveConversationId(conversations)
        // If the user changed the active selection while this load was pending,
        // keep their choice — this run installs its context-preferred id only
        // when the selection is unchanged (PR #152 review).
        const selectionChangedDuringLoad =
          selectionGenerationAtStart !== activeSelectionGeneration
        const activeIdToInstall = selectionChangedDuringLoad
          ? get().activeConversationId
          : activeId
        // Conversations created while this metadata read was pending are not
        // in the snapshot. A user may be looking at one of them right now
        // (createNew { activate: true }); installing the snapshot verbatim
        // would leave the active ID without a matching conversation row and
        // hide the new conversation from the sidebar (PR #152 review, "New
        // conversations disappear from sidebar").
        const conversationsCreatedDuringLoad = get().conversations.filter(
          (conversation) =>
            !conversations.some((meta) => meta.id === conversation.id)
        )

        // Stale-run gate: if a newer load (e.g. a forced retry) has started,
        // this run must not write anything it loaded — skip both the store
        // update and the transcript read that follows (PR #149 round-6).
        if (!isCurrentRun()) return

        set((state) => {
          const existingRows: Conversation[] = conversations.map((conv) => ({
              ...conv,
              status: 'idle',
              streamingContent: '',
              streamingReasoning: '',
              isReasoningStreaming: false,
              completedReasoning: null,
              isContentStreaming: false,
              completedContent: null,
              currentToolCall: null,
              activeToolCalls: [],
              streamingToolArgs: '',
              streamingToolArgsByCallId: {},
              error: null,
              activeRunId: null,
              runEpoch: 0,
              draftAssistant: null,
              contextWindowUsage: conv.lastContextWindowUsage || null,
              lastContextWindowUsage: conv.lastContextWindowUsage || null,
              mountRefCount: 0,
              compressionConvertCallCount: conv.compressionConvertCallCount ?? 0,
              compressionLastSummaryConvertCall:
                conv.compressionLastSummaryConvertCall ?? Number.NEGATIVE_INFINITY,
              collectedAssets: [],
            }))
          state.conversations = [...conversationsCreatedDuringLoad, ...existingRows]
          state.activeConversationId = activeIdToInstall
          state.loaded = true
          state.suggestedFollowUps.clear()
          state.cancelledRunIds.clear()
        })
        const selectionGenerationAtLoad = activeSelectionGeneration

        if (workspaceEnsureError !== null) {
          // The ensure targeted the workspace captured BEFORE the ensure was
          // pending. If the active selection changed meanwhile (and this run
          // preserved the user's newer choice), the failed workspace is no
          // longer the visible one — recording its failure would leave a
          // stale retry banner over a successfully loaded selection
          // (PR #152 review, "Old workspace failure stays visible").
          if (get().activeConversationId === activeWsId) {
            const workspaceLoadMessage = workspaceEnsureError instanceof Error
              ? `Failed to open active workspace: ${workspaceEnsureError.message}`
              : 'Failed to open active workspace'
            set((state) => {
              state.loadError = workspaceLoadMessage
              state.loadErrorScope = 'workspace'
              state.loadFailedConversationId = null
              state.loadFailedWorkspaceId = activeWsId
            })
            persistLoadErrorRecord(workspaceLoadMessage, workspaceEnsureError, null, activeWsId)
          }
        }

        // NOTE: the persisted load-failure record is marked resolved only
        // AFTER the active-transcript load below succeeds — a failure there
        // is still a load failure (PR #149 review) and must stay unresolved.
        // For the same reason `loadError` is NOT cleared here: the metadata
        // is installed before the transcript read finishes, and clearing the
        // error at that point would make a retry look successful while the
        // conversation area still renders empty messages (issue #147,
        // PR #149 review).

        // Load messages for the active conversation (it's about to be displayed).
        // An active-transcript failure is a real load failure too (issue #147,
        // PR #149 review): swallowing it here would leave the conversation
        // looking empty with `loaded = true`, so the retry effect never fires.
        // Route it through the same loadError + diagnostics flow as the
        // metadata pass — but keep `loaded = true` (metadata is present; the
        // lazy path in setActive can still recover the transcript later).
        let activeTranscriptLoaded = true
        if (activeIdToInstall) {
          try {
            const msgRepo = getMessageRepository()
            // Mutation watermark captured BEFORE the read (same rule as the
            // targeted retry): a transcript mutated in memory while this read
            // was pending must not be replaced by the older DB snapshot
            // (PR #152 review, "New transcript edits disappear").
            const transcriptVersionAtReadStart =
              conversationTranscriptVersions.get(activeIdToInstall) ?? 0
            const activeMessages = await withTimeout(
              msgRepo.findByConversation(activeIdToInstall),
              TEST_INITIAL_LOAD_TIMEOUT_MS(),
              'active conversation transcript read'
            )
            if (!isCurrentRun()) return
            const conversationBeforeInstall = get().conversations.find(
              (c) => c.id === activeIdToInstall
            )
            // Unconditional watermark comparison (see the targeted-retry
            // guard): the load replaces the conversation list, so the row it
            // installs into is metadata-only — but a concurrent read may have
            // installed newer content and moved the watermark
            // (PR #152 review, "Stale snapshot can still win").
            const transcriptChangedDuringRead =
              conversationBeforeInstall !== undefined &&
              (conversationTranscriptVersions.get(activeIdToInstall) ?? 0) !==
                transcriptVersionAtReadStart
            if (!transcriptChangedDuringRead) {
              primePersistBaseline(activeIdToInstall, activeMessages as Message[])
              set((state) => {
                const conv = state.conversations.find((c) => c.id === activeIdToInstall)
                if (conv) {
                  conv.messages = activeMessages as Message[]
                  conv.messagesLoaded = true
                  // Auto-heal: restore compression baseline from context_summary messages
                  healCompressionBaseline(conv)
                }
              })
              // Installing the snapshot IS a transcript mutation — bump the
              // watermark so a concurrently pending read cannot accept its
              // older snapshot over these messages
              // (PR #152 review, "Stale snapshot can still win").
              bumpTranscriptVersion(activeIdToInstall)
            }
          } catch (error) {
            // A stale run's failure must not clobber the recovered state a
            // newer load already installed (PR #149 round-6 review).
            // Neither may it clobber the CURRENT selection's state: if the
            // user switched conversations while this read was pending, this
            // run proves nothing about the conversation now on screen
            // (PR #152 review, "User selection is replaced").
            if (!isCurrentRun() || selectionGenerationAtLoad !== activeSelectionGeneration) return
            activeTranscriptLoaded = false
            const activeLoadMessage =
              error instanceof Error
                ? `Failed to load messages for active conversation: ${error.message}`
                : 'Failed to load messages for active conversation'
            console.error(
              '[conversation.store] Failed to load messages for active conversation:',
              error
            )
            // If this run's workspace ensure ALSO failed, remember it: nulling
            // loadFailedWorkspaceId here would let a later TRANSCRIPT retry
            // clear a workspace failure it never exercised (PR #152 review,
            // "Workspace failure is reported recovered").
            const failedWorkspaceId = workspaceEnsureError !== null ? activeWsId : null
            set((state) => {
              state.loadError = activeLoadMessage
              // The conversation LIST loaded fine — only this conversation's
              // transcript failed, so the sidebar can keep the rows usable
              // (issue #147, PR #149 review).
              state.loadErrorScope = 'transcript'
              // Remember WHICH conversation failed: the persisted record may
              // only be marked resolved after THIS conversation's transcript
              // re-read successfully (issue #147, PR #149 review).
              state.loadFailedConversationId = activeIdToInstall
              state.loadFailedWorkspaceId = failedWorkspaceId
            })
            // Record the failing conversation id (and a workspace-ensure
            // failure from the same run) in the diagnostics record too —
            // resolution is verified against them later (PR #149 round-4
            // review, "Unverified failures appear recovered"; PR #152 review,
            // "Workspace failure is reported recovered").
            persistLoadErrorRecord(activeLoadMessage, error, activeIdToInstall, failedWorkspaceId)
          }
        }

        // Success (metadata, workspace, and active transcript) MARKS the previous
        // load-failure record resolved instead of deleting it (mirrors
        // project.store, issue #147) — a user who reloaded into a working
        // app must still be able to attach the ORIGINAL failure to a bug
        // report via Diagnostics. It is called ONLY after the active
        // transcript load succeeded: a failed transcript load is still an
        // unresolved failure (issue #147, PR #149 review) and must not be
        // reported as recovered.
        if (activeTranscriptLoaded && workspaceEnsureError === null &&
            selectionGenerationAtLoad === activeSelectionGeneration) {
          // Pass the id whose transcript actually re-read this run: a record
          // naming a DIFFERENT conversation stays unresolved — this load
          // proves nothing about that one (PR #149 round-4 review, "Unverified
          // failures appear recovered"). A run with no active conversation
          // reads no transcript and proves even less, so resolution still
          // requires the record to name no conversation at all. The
          // workspaceEnsureVerified proof below additionally keeps a
          // WORKSPACE-scoped record unresolved unless THIS run verified the
          // active workspace (opened or already loaded) — a skipped ensure
          // proves nothing about the OPFS layer (PR #152 review, "Skipped
          // workspace ensure is reported recovered" / "Wrong workspace
          // failure is resolved").
          markPersistedFailureResolved(activeIdToInstall, {
            workspaceEnsureVerified,
            ensuredWorkspaceId,
          })
          // The error (and the sidebar's Retry affordance) stays visible
          // until the transcript read actually succeeded.
          set((state) => {
            state.loadError = null
            state.loadErrorScope = null
            state.loadFailedConversationId = null
            state.loadFailedWorkspaceId = null
          })
        }
      } catch (error) {
        // A stale run must not write its failure into the store or diagnostics
        // — a newer load may have already recovered the app (PR #149 round-6).
        if (!isCurrentRun()) return
        console.error('[conversation.store] Failed to load conversations:', error)
        // Persist the INITIAL failure BEFORE the fallback attempt: when the
        // fallback retry then succeeds, markPersistedFailureResolved needs a
        // record to flag recovered — without this write the recovered failure
        // would vanish from Diagnostics entirely (PR #149 round-4 review,
        // "Recovered failures vanish from diagnostics"). If the fallback
        // also fails, the final catch below overwrites this record with the
        // (more specific) retry failure.
        persistLoadErrorRecord(
          error instanceof Error ? error.message : 'Failed to load conversations',
          error
        )
        // Surface the failure in memory BEFORE the fallback attempt: the
        // fallback metadata read can hang or take seconds, and without an
        // in-memory `loadError` the sidebar's alert + Retry stay hidden while
        // history looks permanently empty (PR #149 round-6 review, "Fallback
        // hang hides retry"). If the fallback recovers, the success path
        // below clears this error; if it fails, the final catch overwrites it.
        set((state) => {
          state.loaded = false
          state.loadError =
            error instanceof Error ? error.message : 'Failed to load conversations'
          state.loadErrorScope = 'metadata'
        })
        // A timed-out migration may still be writing messages. A metadata-only
        // fallback cannot prove history is complete, so keep the load failed.
        if (
          error instanceof LoadTimeoutError &&
          [
            'legacy message migration',
            'migration missing-conversation probe',
            'AppSessions message recovery',
          ].includes(error.operation)
        ) return
        // One-shot retry, mirroring workspace.store's initialize retry.
        // A transient failure (e.g. SQLite/OPFS hydration race on cold start)
        // previously fell through to `loaded = true` with `conversations: []`,
        // which looks like "success with no data" to the rest of the app —
        // the sidebar then renders permanently empty because the only effect
        // that re-triggers loadFromDB (`if (!loaded) loadFromDB()`) never
        // fires again. Retry once before recording the error.
        try {
          await new Promise((r) => setTimeout(r, 300))
          // Bound the fallback read: a hung metadata read must not leave the
          // in-flight state unobservable forever — the timeout rejects into
          // the catch below, which records a retryable metadata failure
          // (PR #149 round-6 review, "Fallback hang hides retry").
          const retryConversations = await withTimeout(
            loadConversationsMeta(),
            FALLBACK_META_TIMEOUT_MS,
            'conversation metadata fallback read'
          )
          if (!isCurrentRun()) return
          // Same selection-preservation rule as the primary install, but
          // measured against the RUN-START snapshot: the user may have changed
          // the selection during the failed primary legs OR during the
          // fallback metadata read — either way their newer choice wins over
          // this run's context-preferred id (PR #152 review).
          const selectionChangedAtFallback =
            selectionGenerationAtStart !== activeSelectionGeneration
          // Same created-during-load merge as the primary install: a
          // conversation created while the (failed) primary legs or the
          // fallback metadata read were pending is not in the fallback
          // snapshot — installing it verbatim would leave the preserved
          // active ID without a matching row and hide the new conversation
          // from the sidebar (PR #152 review, "New conversations disappear
          // from sidebar").
          const conversationsCreatedDuringLoad = get().conversations.filter(
            (conversation) =>
              !retryConversations.some((meta) => meta.id === conversation.id)
          )
          set((state) => {
            state.conversations = [
              ...conversationsCreatedDuringLoad,
              ...retryConversations.map((conv) => ({
                ...conv,
                mountRefCount: 0,
                collectedAssets: [],
              })),
            ]
            state.activeConversationId = selectionChangedAtFallback
              ? get().activeConversationId
              : selectActiveConversationId(retryConversations)
            state.loaded = true
            state.suggestedFollowUps.clear()
            state.cancelledRunIds.clear()
          })
          console.log(
            '[conversation.store] loadFromDB fallback metadata read succeeded',
            { conversationCount: retryConversations.length },
          )
          // The fallback is recovered only after metadata, the active OPFS
          // workspace, and its transcript have all loaded successfully — and
          // the ensure must have VERIFIED its target: a skipped/missing-target
          // ensure proves nothing about a workspace-scoped record, which would
          // otherwise be resolved against the WRONG workspace (the one the
          // selection changed to) while the recorded one was never ensured
          // (PR #152 review, "Wrong workspace failure is resolved").
          const retryActiveId = get().activeConversationId
          const selectionGenerationAtFallback = activeSelectionGeneration
          let retryWorkspaceLoaded = true
          let retryWorkspaceVerified = false
          // The workspace id this fallback ensure actually verified — passed
          // to resolution so a record naming a DIFFERENT workspace (the
          // selection changed while the ensure was pending) stays unresolved
          // (PR #152 review, "Wrong workspace failure is resolved").
          let retryEnsuredWorkspaceId: string | null = null
          try {
            const ensureStatus = await ensureActiveWorkspace(retryConversations, retryActiveId)
            retryWorkspaceVerified = ensureStatus !== 'missing-target'
            if (retryWorkspaceVerified) retryEnsuredWorkspaceId = retryActiveId
            if (!isCurrentRun()) return
          } catch (workspaceErr) {
            if (!isCurrentRun()) return
            retryWorkspaceLoaded = false
            const workspaceLoadMessage = workspaceErr instanceof Error
              ? `Failed to open active workspace: ${workspaceErr.message}`
              : 'Failed to open active workspace'
            console.warn('[conversation.store] Fallback active workspace ensure failed:', workspaceErr)
            // The ensure targeted the id captured when the fallback began. If
            // the active selection changed while it was pending, the failed
            // workspace is no longer the visible one — recording its failure
            // would leave a stale retry banner over the user's newer choice
            // (PR #152 review, "Old workspace failure stays visible").
            if (get().activeConversationId === retryActiveId) {
              set((state) => {
                state.loadError = workspaceLoadMessage
                state.loadErrorScope = 'workspace'
                state.loadFailedConversationId = null
                state.loadFailedWorkspaceId = retryActiveId
              })
              persistLoadErrorRecord(workspaceLoadMessage, workspaceErr, null, retryActiveId)
            }
          }
          let retryTranscriptLoaded = true
          if (retryActiveId) {
            try {
              const msgRepo = getMessageRepository()
              // Mutation watermark captured BEFORE the read (same rule as the
              // targeted retry and the primary install): a transcript mutated
              // in memory while this read was pending must not be replaced by
              // the older DB snapshot (PR #152 review, "New transcript edits
              // disappear").
              const retryVersionAtReadStart =
                conversationTranscriptVersions.get(retryActiveId) ?? 0
              const retryMessages = await withTimeout(
                msgRepo.findByConversation(retryActiveId),
                TEST_INITIAL_LOAD_TIMEOUT_MS(),
                'active conversation transcript read'
              )
              if (!isCurrentRun()) return
              const retryConversationBeforeInstall = get().conversations.find(
                (c) => c.id === retryActiveId
              )
              // Unconditional watermark comparison (see the targeted-retry
              // guard) (PR #152 review, "Stale snapshot can still win").
              const retryTranscriptChangedDuringRead =
                retryConversationBeforeInstall !== undefined &&
                (conversationTranscriptVersions.get(retryActiveId) ?? 0) !==
                  retryVersionAtReadStart
              if (selectionGenerationAtFallback !== activeSelectionGeneration) {
                // The user switched conversations while this read was pending:
                // this run proves nothing about the conversation now on screen,
                // so its messages must not be installed into it
                // (PR #152 review, "User selection is replaced").
              } else if (retryTranscriptChangedDuringRead) {
                // The conversation's transcript was mutated in memory while the
                // read was pending — keep the newer in-memory state
                // (PR #152 review, "New transcript edits disappear").
              } else {
                primePersistBaseline(retryActiveId, retryMessages as Message[])
                set((state) => {
                  const conv = state.conversations.find((c) => c.id === retryActiveId)
                  if (conv) {
                    conv.messages = retryMessages as Message[]
                    conv.messagesLoaded = true
                    healCompressionBaseline(conv)
                  }
                })
                // Installing the snapshot IS a transcript mutation — bump the
                // watermark so a concurrently pending read cannot accept its
                // older snapshot over these messages
                // (PR #152 review, "Stale snapshot can still win").
                bumpTranscriptVersion(retryActiveId)
              }
            } catch (transcriptErr) {
              // Stale-run gate (PR #149 round-6 review): a superseded run must
              // not clobber the state a newer load already wrote.
              if (!isCurrentRun()) return
              if (selectionGenerationAtFallback !== activeSelectionGeneration) {
                // The failed read targeted a conversation the user already
                // left — do not display its failure over their newer choice
                // (PR #152 review, "User selection is replaced").
              } else {
                retryTranscriptLoaded = false
                const retryTranscriptMessage =
                  transcriptErr instanceof Error
                    ? `Failed to load messages for active conversation: ${transcriptErr.message}`
                    : 'Failed to load messages for active conversation'
                console.error(
                  '[conversation.store] Failed to load messages for active conversation:',
                  transcriptErr
                )
                // If this run's fallback workspace ensure ALSO failed, remember
                // it: nulling loadFailedWorkspaceId here would let a later
                // TRANSCRIPT retry resolve a workspace failure it never
                // exercised (PR #152 review, "Workspace failure is forgotten").
                const retryFailedWorkspaceId = retryWorkspaceLoaded
                  ? null
                  : retryActiveId
                set((state) => {
                  state.loadError = retryTranscriptMessage
                  // Only the transcript failed — the conversation list is loaded.
                  state.loadErrorScope = 'transcript'
                  // Remember WHICH conversation failed (issue #147, PR #149 review).
                  state.loadFailedConversationId = retryActiveId
                  state.loadFailedWorkspaceId = retryFailedWorkspaceId
                })
                // A transcript failure after the fallback retry is still a real
                // load failure — persist it for Diagnostics like the
                // initial-load catch does, or a bug report carries no trace of
                // it (issue #147, PR #149 review). The co-failed workspace id
                // rides along so a transcript-only retry cannot resolve the
                // workspace-scoped failure later (PR #152 review, "Workspace
                // failure is forgotten").
                persistLoadErrorRecord(
                  retryTranscriptMessage, transcriptErr, retryActiveId,
                  retryFailedWorkspaceId
                )
              }
            }
          }
          if (retryTranscriptLoaded && retryWorkspaceLoaded &&
              selectionGenerationAtFallback === activeSelectionGeneration) {
            // Same verification as the primary path: only the transcript of
            // the conversation actually re-read by this retry counts as
            // proof (PR #149 round-4 review). retryWorkspaceVerified keeps a
            // WORKSPACE-scoped record unresolved unless THIS run verified the
            // active workspace — a skipped/missing-target ensure proves
            // nothing about the OPFS layer, so a record naming workspace B
            // must not be resolved by an ensure of (or a skip of) workspace A
            // (PR #152 review, "Wrong workspace failure is resolved").
            markPersistedFailureResolved(retryActiveId, {
              workspaceEnsureVerified: retryWorkspaceVerified,
              ensuredWorkspaceId: retryEnsuredWorkspaceId,
            })
            // The error stays visible until the transcript read succeeded.
            set((state) => {
              state.loadError = null
              state.loadErrorScope = null
              state.loadFailedConversationId = null
              state.loadFailedWorkspaceId = null
            })
          } else if (retryTranscriptLoaded && retryWorkspaceLoaded) {
            // Metadata, workspace, and transcript all succeeded, but the user
            // switched selections while the ensure/read were pending. The
            // reads proved the BACKEND layer healthy — only the per-conversation
            // install and resolution are selection-scoped and were skipped
            // above. The stale metadata loadError must NOT stay displayed: the
            // user's newer selection loaded through the same healthy layers,
            // so the banner describes a failure that no longer exists
            // (PR #152 review, "Stale retry error remains visible"). Only a
            // VERIFIED ensure participates: an unverified one must not clear a
            // workspace-scoped failure either (see "Wrong workspace failure is
            // resolved" above).
            set((state) => {
              if (state.loadErrorScope === 'metadata') {
                state.loadError = null
                state.loadErrorScope = null
                state.loadFailedConversationId = null
                state.loadFailedWorkspaceId = null
              }
            })
          }
        } catch (retryErr) {
          // Stale-run gate: a superseded run must not flag a failure the
          // current run already recovered (PR #149 round-6 review).
          if (!isCurrentRun()) return
          console.error(
            '[conversation.store] loadFromDB retry also failed:',
            retryErr instanceof Error ? retryErr.message : retryErr,
          )
          // Do NOT set loaded=true here. Keeping loaded=false lets the
          // WorkspaceLayout effect re-run loadFromDB (e.g. on the next store
          // change) instead of permanently locking in an empty list.
          const retryMessage =
            retryErr instanceof Error ? retryErr.message : 'Failed to load conversations'
          set((state) => {
            state.loaded = false
            state.loadError = retryMessage
            // The conversation LIST itself is unavailable — the UI must not
            // render the (empty) list as if the history were loaded.
            state.loadErrorScope = 'metadata'
          })
          // Persist the failure for diagnostics (issue #147) — same pattern as
          // the project store's sessionStorage init-error record. Without this,
          // a "history is empty" report carries no trace of the failed load.
          persistLoadErrorRecord(retryMessage, retryErr)
        }
      }
}

/**
 * Active-selection generation. Bumped by every call that changes which
 * conversation the user is looking at (setActive, createNew with activate,
 * retry installs), read by a pending load so it can preserve a newer choice
 * instead of overwriting it. The counter lives here because the load
 * pipeline owns every read of it; the store bumps it through the accessor
 * below.
 */
/**
 * The transcript mutation watermark for a conversation. `undefined` means the
 * conversation has no entry (never mutated), which the selection path and the
 * retry guards both compare against a snapshot taken before an await.
 */
export function getTranscriptVersion(conversationId: string): number | undefined {
  return conversationTranscriptVersions.get(conversationId)
}

/**
 * Drop both per-conversation maps when the conversation itself is deleted.
 * The maps live for the page's lifetime, so a long-lived session that
 * creates/mutates/deletes many conversations would otherwise grow them
 * without bound (PR #152 review, "Deleted conversations retain watermark
 * entries").
 */
export function forgetTranscriptState(conversationId: string): void {
  conversationTranscriptVersions.delete(conversationId)
  transcriptReadGenerations.delete(conversationId)
}

export function getActiveSelectionGeneration(): number {
  return activeSelectionGeneration
}

/** Bump the active-selection generation and return the new value. */
export function bumpActiveSelectionGeneration(): number {
  return ++activeSelectionGeneration
}
