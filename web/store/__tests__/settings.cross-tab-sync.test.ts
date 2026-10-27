/**
 * Cross-tab settings sync regression tests (Sourcery round-3 findings)
 *
 * Covers:
 * - TDZ: the storage listener must actually install during synchronous
 *   rehydration (crossTabSyncInstalled / suppressPersistWrites are read
 *   during module init — declared after the store they crashed with a
 *   ReferenceError that zustand swallowed silently).
 * - Write-order guard: ordering uses the monotonic revision embedded in the
 *   payload, not StorageEvent.timeStamp — a stale snapshot must never
 *   overwrite a newer one, even when its event fires LATER.
 * - Schema-version guard: a v3 snapshot from an old tab must not overwrite
 *   this tab's v4 settings AND must not leave the stale v3 snapshot in
 *   shared localStorage (a reload would migrate it back in).
 * - Credential refresh: applying a peer's provider/model switch must
 *   re-evaluate hasApiKey and reset modelCredentialStatus.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const STORAGE_KEY = 'bfosa-settings'

const loadApiKeyMock = vi.fn<(providerKey?: string) => Promise<string | null>>()

vi.mock('@/security/api-key-store', () => ({
  loadApiKey: (providerKey?: string) => loadApiKeyMock(providerKey),
  saveApiKey: async () => undefined,
  deleteApiKey: async () => undefined,
}))

interface PersistedShape {
  enableThinking?: boolean
  thinkingLevel?: string
  temperature?: number
  [key: string]: unknown
}

function seedStorage(value: PersistedShape | null, version = 4, revision?: number) {
  if (value === null) {
    localStorage.removeItem(STORAGE_KEY)
  } else {
    const state = revision == null ? value : { ...value, __settingsWriteRevision: revision }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, version }))
  }
}

function dispatchStorageEvent(timeStamp: number, rawValue: string | null) {
  const event = new Event('storage') as Event & { key: string | null; newValue: string | null; timeStamp: number }
  Object.defineProperties(event, {
    key: { value: STORAGE_KEY },
    newValue: { value: rawValue },
    timeStamp: { value: timeStamp },
  })
  window.dispatchEvent(event)
}

/** Snapshot envelope with an embedded write revision, as v4 tabs write it. */
function revSnapshot(value: Record<string, unknown>, revision: number, version = 4): string {
  return JSON.stringify({ state: { ...value, __settingsWriteRevision: revision }, version })
}

async function importStore() {
  return import('@/store/settings.store')
}

describe('cross-tab settings sync (round-3 findings)', () => {
  beforeEach(() => {
    localStorage.clear()
    loadApiKeyMock.mockReset()
    loadApiKeyMock.mockResolvedValue('sk-test')
    vi.resetModules()
  })

  afterEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('installs the storage listener during synchronous rehydration (no TDZ)', async () => {
    // Rehydration happens during module init; if the sync state were still
    // declared after the store, this import would silently fail to register
    // the listener and the event below would be ignored.
    seedStorage({ enableThinking: false })
    const { useSettingsStore } = await importStore()

    const raw = JSON.stringify({
      state: { temperature: 0.42 },
      version: 4,
    })
    dispatchStorageEvent(performance.now() + 5, raw)

    expect(useSettingsStore.getState().temperature).toBe(0.42)
  })

  it('ignores a queued snapshot with an OLDER revision even when its event fires later (write-order guard)', async () => {
    // Pre-fix this test ordered by StorageEvent.timeStamp, which measures
    // receiving-tab timing: the stale snapshot's event fired LAST and the
    // stale temperature 0.7 clobbered the newer 0.5. The revision embedded
    // in the payload must order these correctly regardless of event timing.
    seedStorage({ temperature: 0.7 })
    const { useSettingsStore } = await importStore()

    // Peer tab A writes revision 5 (temperature 0.5) and its event is
    // delivered; then peer tab B — which started from an older state —
    // writes revision 3 (temperature 0.7) and its event is delivered AFTER
    // A's despite being the OLDER write.
    dispatchStorageEvent(performance.now() + 10, revSnapshot({ temperature: 0.5 }, 5))
    expect(useSettingsStore.getState().temperature).toBe(0.5)

    dispatchStorageEvent(performance.now() + 20, revSnapshot({ temperature: 0.7 }, 3))
    // The older revision must NOT replace the newer settings.
    expect(useSettingsStore.getState().temperature).toBe(0.5)
  })

  it('applies a snapshot with a NEWER revision than the last applied one', async () => {
    seedStorage({ temperature: 0.7 })
    const { useSettingsStore } = await importStore()

    dispatchStorageEvent(performance.now() + 10, revSnapshot({ temperature: 0.5 }, 4))
    expect(useSettingsStore.getState().temperature).toBe(0.5)

    dispatchStorageEvent(performance.now() + 20, revSnapshot({ temperature: 0.3, maxIterations: 42 }, 9))
    expect(useSettingsStore.getState().temperature).toBe(0.3)
    expect(useSettingsStore.getState().maxIterations).toBe(42)
  })

  it('ignores a queued revision older than this tab\'s own write (concurrent edit)', async () => {
    seedStorage({ enableThinking: true, temperature: 0.7 }, 4, 2)
    const { useSettingsStore } = await importStore()

    // This tab edits and persists — the storage wrapper stamps its write
    // with the next revision.
    useSettingsStore.getState().setTemperature(0.9)
    expect(useSettingsStore.getState().temperature).toBe(0.9)

    // The other tab wrote BEFORE our write (the module is fresh, so this
    // tab's own persist was stamped revision 1); its event arrives carrying
    // the stale pre-write snapshot (temperature 0.7) at the same/older
    // revision.
    dispatchStorageEvent(performance.now() + 30, revSnapshot({ enableThinking: true, temperature: 0.7 }, 1))

    // The local edit must survive.
    expect(useSettingsStore.getState().temperature).toBe(0.9)
  })

  it('applies a newer snapshot after our own write (freshness not over-blocked)', async () => {
    seedStorage({ temperature: 0.7 }, 4, 1)
    const { useSettingsStore } = await importStore()

    useSettingsStore.getState().setTemperature(0.9)

    // The other tab wrote AFTER our write (higher revision) — must apply.
    dispatchStorageEvent(performance.now() + 1000, revSnapshot({ temperature: 0.5, maxIterations: 42 }, 50))

    expect(useSettingsStore.getState().temperature).toBe(0.5)
    expect(useSettingsStore.getState().maxIterations).toBe(42)
  })

  it('rejects a v3 snapshot from an old tab and repairs shared localStorage (schema-version guard)', async () => {
    seedStorage({ enableThinking: false, temperature: 0.7 })
    const { useSettingsStore } = await importStore()
    expect(useSettingsStore.getState().enableThinking).toBe(false)

    // A pre-deploy v3 tab writes its stale full snapshot (thinking true).
    const v3Raw = JSON.stringify({
      state: { enableThinking: true, temperature: 0.3 },
      version: 3,
    })
    // The old tab's write REPLACED the shared value before its event fired —
    // mirror that here, otherwise a regression that removes the repair call
    // still passes (the assertions would read the untouched v4 seed).
    localStorage.setItem(STORAGE_KEY, v3Raw)
    dispatchStorageEvent(performance.now() + 5, v3Raw)

    // v4 state must not be reverted by the older-schema snapshot...
    expect(useSettingsStore.getState().enableThinking).toBe(false)
    expect(useSettingsStore.getState().temperature).toBe(0.7)

    // ...AND the stale v3 snapshot must not remain in shared localStorage —
    // a reload would migrate it back in and "newer settings disappear after
    // reload". The handler must re-persist the current v4 snapshot.
    const repaired = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as {
      version: number
      state: { enableThinking: boolean; temperature: number }
    }
    expect(repaired.version).toBe(4)
    expect(repaired.state.enableThinking).toBe(false)
    expect(repaired.state.temperature).toBe(0.7)
  })

  it('applies a v4 peer snapshot with a changed setting (baseline behavior)', async () => {
    seedStorage({ enableThinking: false })
    const { useSettingsStore } = await importStore()

    dispatchStorageEvent(performance.now() + 5, revSnapshot({ enableThinking: true, thinkingLevel: 'low' }, 7))

    expect(useSettingsStore.getState().enableThinking).toBe(true)
    expect(useSettingsStore.getState().thinkingLevel).toBe('low')
  })

  it('refreshes hasApiKey when a peer snapshot switches the provider (credential refresh)', async () => {
    // Runtime-only hasApiKey is not part of the persisted snapshot: applying
    // a peer's provider switch used to leave this tab holding the PREVIOUS
    // provider's key status, so sendMessage rejected sends against the
    // now-active provider. The apply path must re-run checkHasApiKey.
    seedStorage({ providerType: 'anthropic', modelName: 'claude-sonnet' })
    const { useSettingsStore } = await importStore()
    expect(useSettingsStore.getState().providerType).toBe('anthropic')

    // Start from a stale key state as if this tab last checked 'anthropic'.
    useSettingsStore.setState({ hasApiKey: false, hasApiKeyLoaded: true })

    dispatchStorageEvent(
      performance.now() + 5,
      revSnapshot({ providerType: 'openai', modelName: 'gpt-test' }, 11),
    )

    expect(useSettingsStore.getState().providerType).toBe('openai')
    // The key lookup for the NEW provider must run; it resolves with a key,
    // so the reactive hasApiKey must end up true (not stay false).
    await vi.waitFor(() => expect(loadApiKeyMock).toHaveBeenCalledWith('openai'))
    await vi.waitFor(() => expect(useSettingsStore.getState().hasApiKey).toBe(true))
  })

  it('resets modelCredentialStatus when a peer snapshot switches the provider', async () => {
    // The expired/unauthorized flag describes the PREVIOUS provider's auth.
    // A cross-tab provider switch must clear it (same rule as the local
    // switchProviderAndModel) or the send path keeps marking the new, valid
    // selection unusable.
    seedStorage({ providerType: 'llm-gateway', modelName: 'gateway-model' })
    const { useSettingsStore } = await importStore()
    useSettingsStore.setState({ modelCredentialStatus: 'expired' })

    dispatchStorageEvent(
      performance.now() + 5,
      revSnapshot({ providerType: 'openai', modelName: 'gpt-test' }, 12),
    )

    expect(useSettingsStore.getState().providerType).toBe('openai')
    expect(useSettingsStore.getState().modelCredentialStatus).toBe('unknown')
  })

  it('keeps modelCredentialStatus on a same-provider cross-tab model switch', async () => {
    // Within llm-gateway the credential still applies — the new model hits
    // the same expired credential, mirroring switchProviderAndModel.
    seedStorage({ providerType: 'llm-gateway', modelName: 'gateway-model' })
    const { useSettingsStore } = await importStore()
    useSettingsStore.setState({ modelCredentialStatus: 'expired' })

    dispatchStorageEvent(
      performance.now() + 5,
      revSnapshot({ providerType: 'llm-gateway', modelName: 'gateway-model-2' }, 13),
    )

    expect(useSettingsStore.getState().modelName).toBe('gateway-model-2')
    expect(useSettingsStore.getState().modelCredentialStatus).toBe('expired')
  })
})
