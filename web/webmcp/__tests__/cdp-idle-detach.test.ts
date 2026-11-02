// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * CDP idle auto-detach: Chrome keeps the "This extension is debugging your
 * browser" banner up until detach, so cdp.ts detaches tabs with no CDP
 * activity for CDP_IDLE_TIMEOUT_MS. The timer must be canceled by new
 * activity, and a suspended/discarded service worker (frozen timers, lost
 * memory) is covered by the alarm sweep + session-storage mirror.
 */
const alarmListeners = new Set<(alarm: { name: string }) => void>()

const storageSession = () => {
  const data = new Map<string, unknown>()
  return {
    get: vi.fn(async (key: string) => (data.has(key) ? { [key]: data.get(key) } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, v) }),
  }
}

async function loadModule() {
  vi.resetModules()
  return await import('../../../browser-extension/lib/bash-commands/browser/cdp')
}

beforeEach(() => {
  vi.useFakeTimers()
  alarmListeners.clear()
  vi.stubGlobal('chrome', {
    runtime: {},
    storage: { session: storageSession() },
    debugger: {
      attach: vi.fn((_t: unknown, _v: string, done: () => void) => done()),
      detach: vi.fn((_t: unknown, done: () => void) => done()),
      sendCommand: vi.fn((_t: unknown, _m: string, _p: unknown, done: (r?: unknown) => void) => done({})),
      getTargets: vi.fn(async () => []),
      onDetach: { addListener: vi.fn() },
    },
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: (fn: (alarm: { name: string }) => void) => { alarmListeners.add(fn) } },
    },
  })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('CDP idle auto-detach', () => {
  it('detaches a tab after the idle timeout and clears its state', async () => {
    const cdp = await loadModule()
    await cdp.ensureAttached(7)
    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3', expect.any(Function))
    expect(cdp.attachedTabs.has(7)).toBe(true)
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(cdp.CDP_IDLE_TIMEOUT_MS + 1000)
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 7 }, expect.any(Function))
    expect(cdp.attachedTabs.has(7)).toBe(false)
  })

  it('cancels the pending detach when a new command records activity', async () => {
    const cdp = await loadModule()
    await cdp.ensureAttached(7)
    await vi.advanceTimersByTimeAsync(cdp.CDP_IDLE_TIMEOUT_MS - 10_000)
    cdp.noteCdpActivity(7)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(cdp.CDP_IDLE_TIMEOUT_MS + 1000)
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(1)
  })

  it('does not detach a tab that is receiving regular commands', async () => {
    const cdp = await loadModule()
    await cdp.ensureAttached(7)
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(cdp.CDP_IDLE_TIMEOUT_MS / 2)
      // Through the production path: sendCommand must record activity itself.
      await cdp.sendCommand(7, 'Runtime.evaluate', { expression: '1' })
    }
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
    expect(cdp.attachedTabs.has(7)).toBe(true)
  })

  it('keeps persisted timestamps for other tabs when a new tab persists activity', async () => {
    // Tab A's timestamp exists in storage (previous SW); the current worker
    // only knows tab B. A B-activity persist must not erase or alter A's record.
    const tab5Timestamp = Date.now() - 90_000
    const data = new Map<string, unknown>([['cw_cdp_activity', { 5: tab5Timestamp }]])
    ;(chrome.storage.session.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => (data.has(key) ? { [key]: data.get(key) } : {}))
    ;(chrome.storage.session.set as ReturnType<typeof vi.fn>).mockImplementation(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, v) })
    const cdp = await loadModule()
    cdp.noteCdpActivity(7)
    // Flush the coalesced persist.
    await vi.advanceTimersByTimeAsync(10)
    const stored = await chrome.storage.session.get('cw_cdp_activity')
    expect(stored.cw_cdp_activity).toEqual({ 5: tab5Timestamp, 7: expect.any(Number) })
  })

  it('skips the persist write after a failed storage read, keeping other tabs', async () => {
    // Tab A's timestamp exists in storage; the read fails, so the worker only
    // knows tab 7. Writing the partial map would erase A's cleanup record.
    const data = new Map<string, unknown>([['cw_cdp_activity', { 5: Date.now() }]])
    // Both the eager load and the persist-time hydrate must fail so the write
    // path sees a failed read.
    ;(chrome.storage.session.get as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockImplementation(async (key: string) => (data.has(key) ? { [key]: data.get(key) } : {}))
    ;(chrome.storage.session.set as ReturnType<typeof vi.fn>).mockImplementation(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, v) })
    const cdp = await loadModule()
    cdp.noteCdpActivity(7)
    // The failed read must leave storage untouched — a partial write would
    // erase tab 5's cleanup record.
    await vi.advanceTimersByTimeAsync(10)
    const stored = await chrome.storage.session.get('cw_cdp_activity')
    expect(stored.cw_cdp_activity).toEqual({ 5: expect.any(Number) })
    // Once the read recovers, the next activity note's persist lands with
    // both tabs. Move past the per-tab persist throttle first so the note
    // schedules a fresh write.
    await vi.advanceTimersByTimeAsync(6_000)
    cdp.noteCdpActivity(7)
    await vi.advanceTimersByTimeAsync(cdp.CDP_IDLE_TIMEOUT_MS + 10)
    const recovered = await chrome.storage.session.get('cw_cdp_activity')
    expect(recovered.cw_cdp_activity).toEqual({ 5: expect.any(Number), 7: expect.any(Number) })
  })

  it('keeps the activity record when a detach fails after a SW restart, so sweeps retry', async () => {
    // Discarded-SW scenario: persisted stale timestamp, empty in-memory state
    // — attachedTabs does NOT list the tab when the sweep detach fails.
    const data = new Map<string, unknown>([['cw_cdp_activity', { 7: Date.now() }]])
    ;(chrome.storage.session.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => (data.has(key) ? { [key]: data.get(key) } : {}))
    ;(chrome.storage.session.set as ReturnType<typeof vi.fn>).mockImplementation(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, v) })
    const cdp = await loadModule()
    await vi.advanceTimersByTimeAsync(cdp.CDP_IDLE_TIMEOUT_MS + 1000)
    ;(chrome.debugger.getTargets as ReturnType<typeof vi.fn>).mockResolvedValue([{ tabId: 7, attached: true }])
    ;(chrome.debugger.detach as ReturnType<typeof vi.fn>).mockImplementationOnce((_t: unknown, done: () => void) => {
      chrome.runtime.lastError = { message: 'Detach failed' }
      done()
      Reflect.deleteProperty(chrome.runtime, 'lastError')
    })
    await cdp.sweepIdleTabs()
    // The timestamp survives the failed detach, so the next sweep can retry.
    const stored = await chrome.storage.session.get('cw_cdp_activity')
    expect(stored.cw_cdp_activity?.[7]).toBeGreaterThan(0)
    await cdp.sweepIdleTabs()
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(2)
  })

  it('retries a failed activity write once shortly after the failure', async () => {
    const data = new Map<string, unknown>()
    ;(chrome.storage.session.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => (data.has(key) ? { [key]: data.get(key) } : {}))
    const set = vi.fn()
      .mockRejectedValueOnce(new Error('quota exceeded'))
      .mockImplementation(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, v) })
    ;(chrome.storage.session.set as ReturnType<typeof vi.fn>).mockImplementation(set)
    const cdp = await loadModule()
    cdp.noteCdpActivity(7)
    // The coalesced persist fires and fails.
    await vi.advanceTimersByTimeAsync(10)
    expect(data.has('cw_cdp_activity')).toBe(false)
    // The retry lands within its own short window — well before the idle
    // timeout — and is not postponed to it.
    await vi.advanceTimersByTimeAsync(6_000)
    expect(data.get('cw_cdp_activity')).toMatchObject({ 7: expect.any(Number) })
    expect(set).toHaveBeenCalledTimes(2)
  })

  it('does not restore a detached tab through the write retry', async () => {
    // The write fails, then the tab detaches before the retry fires. The
    // retry must persist the CURRENT (empty) snapshot, not resurrect the
    // stale timestamp from the failed attempt.
    const data = new Map<string, unknown>()
    ;(chrome.storage.session.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => (data.has(key) ? { [key]: data.get(key) } : {}))
    const set = vi.fn()
      .mockRejectedValueOnce(new Error('quota exceeded'))
      .mockImplementation(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, v) })
    ;(chrome.storage.session.set as ReturnType<typeof vi.fn>).mockImplementation(set)
    const cdp = await loadModule()
    await cdp.ensureAttached(7)
    cdp.noteCdpActivity(7)
    // The coalesced persist fires and fails; the tab then detaches.
    await vi.advanceTimersByTimeAsync(10)
    await cdp.detachDebugger(7)
    // The retry must write the empty snapshot, not the stale one.
    await vi.advanceTimersByTimeAsync(6_000)
    expect(data.get('cw_cdp_activity')).toEqual({})
  })

  it('does not resurrect a cleared tab when hydration races the clear', async () => {
    // A stored timestamp for tab 5; a pending hydration read lands AFTER
    // tab 7 was cleared — the cleared tab must stay cleared even though the
    // storage snapshot still carries its row.
    const data = new Map<string, unknown>([['cw_cdp_activity', { 7: Date.now() }]])
    let releaseRead!: () => void
    const gate = new Promise<void>(resolve => { releaseRead = resolve })
    ;(chrome.storage.session.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
      await gate
      return data.has(key) ? { [key]: data.get(key) } : {}
    })
    ;(chrome.storage.session.set as ReturnType<typeof vi.fn>).mockImplementation(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, v) })
    const cdp = await loadModule()
    cdp.noteCdpActivity(7)
    cdp.clearDebuggerState(7)
    // Let the hydration read (started before the clear) complete now.
    releaseRead()
    await vi.advanceTimersByTimeAsync(10)
    await cdp.sweepIdleTabs()
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
  })

  it('detaches our orphaned sessions with no activity record during a sweep', async () => {
    // A failed persist left the worker without the tab's timestamp (both the
    // eager load and the persist-time hydrate fail); getTargets still shows
    // OUR debugger attached — the sweep's recovery pass must detach it so the
    // banner cannot outlive the lost record.
    ;(chrome.storage.session.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('storage unavailable'))
    ;(chrome.runtime as { id?: string }).id = 'ext-id'
    ;(chrome.debugger.getTargets as ReturnType<typeof vi.fn>).mockResolvedValue([{ tabId: 7, attached: true, extensionId: 'ext-id' }])
    const cdp = await loadModule()
    await cdp.sweepIdleTabs()
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 7 }, expect.any(Function))
  })

  it('does not touch foreign debugger sessions in the recovery sweep', async () => {
    ;(chrome.storage.session.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('storage unavailable'))
    ;(chrome.runtime as { id?: string }).id = 'ext-id'
    ;(chrome.debugger.getTargets as ReturnType<typeof vi.fn>).mockResolvedValue([{ tabId: 7, attached: true, extensionId: 'someone-else' }])
    const cdp = await loadModule()
    await cdp.sweepIdleTabs()
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
  })

  it('persists an empty activity snapshot when the last tracked tab is detached', async () => {
    const data = new Map<string, unknown>()
    ;(chrome.storage.session.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => (data.has(key) ? { [key]: data.get(key) } : {}))
    ;(chrome.storage.session.set as ReturnType<typeof vi.fn>).mockImplementation(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, v) })
    const cdp = await loadModule()
    await cdp.ensureAttached(7)
    // Flush the attach's own queued persist first, so the detach-triggered
    // empty-snapshot write below is exercised and not just this leftover.
    await vi.advanceTimersByTimeAsync(10)
    expect(await chrome.storage.session.get('cw_cdp_activity')).toMatchObject({ cw_cdp_activity: { 7: expect.any(Number) } })
    await cdp.detachDebugger(7)
    // Flush the coalesced persist: the stale timestamp must not linger.
    await vi.advanceTimersByTimeAsync(10)
    const stored = await chrome.storage.session.get('cw_cdp_activity')
    expect(stored.cw_cdp_activity).toEqual({})
  })

  it('sweeps idle tabs through the alarm after a service worker restart', async () => {
    const cdp = await loadModule()
    cdp.installCdpIdleWatch()
    expect(chrome.alarms.create).toHaveBeenCalledWith(expect.any(String), { periodInMinutes: 1 })
    expect(alarmListeners.size).toBe(1)
    await cdp.ensureAttached(7)
    // Simulate a discarded SW: fresh module state, timestamps recovered from
    // session storage, only the alarm listener wiring survives.
    const revived = await loadModule()
    revived.installCdpIdleWatch()
    expect(revived.attachedTabs.size).toBe(0)
    // The browser still reports the debugger attached (getTargets survives).
    ;(chrome.debugger.getTargets as ReturnType<typeof vi.fn>).mockResolvedValue([{ tabId: 7, attached: true }])
    // Flush the pre-discard persist, then clear the ORIGINAL worker's timers:
    // a discarded SW freezes timers, so its 120s idle timer must not fire
    // during the advance below and detach the tab before the revived sweep
    // gets its turn (the assertion would pass without the sweep doing work).
    await vi.advanceTimersByTimeAsync(10)
    vi.clearAllTimers()
    // Revive the alarm wiring for the new worker and let the idle window
    // elapse. Drive sweepIdleTabs directly — the alarm listener discards the
    // sweep's promise, so awaiting the listener would race the assertions.
    const detachCallsBefore = (chrome.debugger.detach as ReturnType<typeof vi.fn>).mock.calls.length
    await vi.advanceTimersByTimeAsync(cdp.CDP_IDLE_TIMEOUT_MS + 1000)
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(detachCallsBefore)
    await revived.sweepIdleTabs()
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(detachCallsBefore + 1)
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 7 }, expect.any(Function))
    expect(revived.attachedTabs.has(7)).toBe(false)
  })

  it('keeps tabs whose persisted activity is still fresh during a sweep', async () => {
    const cdp = await loadModule()
    cdp.installCdpIdleWatch()
    await cdp.ensureAttached(7)
    const revived = await loadModule()
    revived.installCdpIdleWatch()
    ;(chrome.debugger.getTargets as ReturnType<typeof vi.fn>).mockResolvedValue([{ tabId: 7, attached: true }])
    // Overwrite the persisted snapshot with a fresh timestamp, as if the SW
    // was discarded seconds ago.
    await chrome.storage.session.set({ cw_cdp_activity: { 7: Date.now() } })
    await revived.sweepIdleTabs()
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
  })

  it('treats an "already attached" error as attached after SW restart (no duplicate attach)', async () => {
    const cdp = await loadModule()
    await cdp.ensureAttached(7)
    const revived = await loadModule()
    ;(chrome.debugger.getTargets as ReturnType<typeof vi.fn>).mockResolvedValue([{ tabId: 7, attached: true }])
    ;(chrome.debugger.attach as ReturnType<typeof vi.fn>).mockImplementationOnce((_t: unknown, _v: string, done: () => void) => {
      chrome.runtime.lastError = { message: 'Another debugger is already attached' }
      done()
      Reflect.deleteProperty(chrome.runtime, 'lastError')
    })
    await revived.ensureAttached(7)
    expect(revived.attachedTabs.has(7)).toBe(true)
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
  })

  it('rejects an "already attached" error when the debugger belongs to someone else', async () => {
    const cdp = await loadModule()
    ;(chrome.debugger.attach as ReturnType<typeof vi.fn>).mockImplementationOnce((_t: unknown, _v: string, done: () => void) => {
      chrome.runtime.lastError = { message: 'Another debugger is already attached' }
      done()
      Reflect.deleteProperty(chrome.runtime, 'lastError')
    })
    // getTargets reports the tab attached by a DIFFERENT debugger.
    ;(chrome.debugger.getTargets as ReturnType<typeof vi.fn>).mockResolvedValue([
      { tabId: 7, attached: true, extensionId: 'someone-else' },
    ])
    await expect(cdp.ensureAttached(7)).rejects.toThrow('already attached')
    expect(cdp.attachedTabs.has(7)).toBe(false)
  })

  it('does not detach a tab that receives activity while the sweep checks attachment', async () => {
    // Seed a persisted stale timestamp directly (as a previous SW would have
    // left it), with no in-memory state — the discarded-SW scenario.
    const data = new Map<string, unknown>([['cw_cdp_activity', { 7: Date.now() }]])
    ;(chrome.storage.session.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => (data.has(key) ? { [key]: data.get(key) } : {}))
    ;(chrome.storage.session.set as ReturnType<typeof vi.fn>).mockImplementation(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, v) })
    const cdp = await loadModule()
    cdp.installCdpIdleWatch()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    ;(chrome.debugger.getTargets as ReturnType<typeof vi.fn>).mockImplementationOnce(() => gate.then(() => [{ tabId: 7, attached: true }]))
    // Expire the persisted timestamp.
    await vi.advanceTimersByTimeAsync(cdp.CDP_IDLE_TIMEOUT_MS + 1000)
    // Drive sweepIdleTabs directly: the alarm listener discards the sweep's
    // promise, so awaiting the listener would not cover the async sweep.
    const sweeping = cdp.sweepIdleTabs()
    // A command attaches through the same module while the check hangs,
    // recording fresh activity.
    await cdp.ensureAttached(7)
    release()
    await sweeping
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
    expect(cdp.attachedTabs.has(7)).toBe(true)
  })

  it('clears idle state on explicit detach and debugger-state resets', async () => {
    const cdp = await loadModule()
    await cdp.ensureAttached(7)
    await cdp.detachDebugger(7)
    expect(cdp.attachedTabs.has(7)).toBe(false)
    // A new activity note after an explicit detach must not resurrect a
    // stale timer that detaches a no-longer-attached tab.
    cdp.noteCdpActivity(7)
    await vi.advanceTimersByTimeAsync(cdp.CDP_IDLE_TIMEOUT_MS + 1000)
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(1)
    expect(cdp.attachedTabs.has(7)).toBe(false)
  })
})
