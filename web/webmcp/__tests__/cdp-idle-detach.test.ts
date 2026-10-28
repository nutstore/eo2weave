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
      cdp.noteCdpActivity(7)
    }
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
    expect(cdp.attachedTabs.has(7)).toBe(true)
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
    const [, listener] = [...alarmListeners]
    // The frozen clock keeps the persisted timestamp fresh; let the idle
    // window elapse, then the alarm sweep (with storage recovered) detaches.
    await vi.advanceTimersByTimeAsync(cdp.CDP_IDLE_TIMEOUT_MS + 1000)
    await listener({ name: 'cw-cdp-idle-sweep' })
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
    const [, listener] = [...alarmListeners]
    await listener({ name: 'cw-cdp-idle-sweep' })
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
  })

  it('treats an "already attached" error as attached after SW restart (no duplicate attach)', async () => {
    const cdp = await loadModule()
    await cdp.ensureAttached(7)
    const revived = await loadModule()
    ;(chrome.debugger.attach as ReturnType<typeof vi.fn>).mockImplementationOnce((_t: unknown, _v: string, done: () => void) => {
      chrome.runtime.lastError = { message: 'Another debugger is already attached' }
      done()
      Reflect.deleteProperty(chrome.runtime, 'lastError')
    })
    await revived.ensureAttached(7)
    expect(revived.attachedTabs.has(7)).toBe(true)
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
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
