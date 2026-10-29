import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RECOVERY_RELOAD_ALARM_PREFIX,
  handlePackageOptInRecoveryAlarm,
  scheduleRecoveryReload,
} from '../../../browser-extension/entrypoints/webmcp/package-optin-handler'

/**
 * The recovery reload must survive MV3 service-worker suspension: retries
 * are scheduled as chrome.alarms (durable), never as in-worker setTimeout
 * chains (finding: "Recovery reload is lost").
 */
describe('package opt-in recovery reload (durable alarms)', () => {
  const create = vi.fn()
  const getAll = vi.fn()
  const clear = vi.fn()
  const get = vi.fn()
  const reload = vi.fn()

  function stubChrome(): void {
    vi.stubGlobal('chrome', {
      alarms: { create, getAll, clear },
      tabs: { get, reload },
    })
  }

  beforeEach(() => {
    vi.resetAllMocks()
    create.mockReturnValue(undefined)
    getAll.mockResolvedValue([])
    clear.mockResolvedValue(undefined)
    get.mockResolvedValue({ id: 7, url: 'https://jmail.world/messages' })
    reload.mockResolvedValue(undefined)
    stubChrome()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('schedules a DURABLE alarm (no setTimeout retry chain)', () => {
    scheduleRecoveryReload(7, 'https://jmail.world/messages')
    expect(create).toHaveBeenCalledTimes(1)
    const [name, info] = create.mock.calls[0] as [string, { periodInMinutes: number }]
    expect(name).toContain(`${RECOVERY_RELOAD_ALARM_PREFIX}:7:`)
    expect(name).toContain('https://jmail.world/messages')
    expect(info.periodInMinutes).toBeGreaterThan(0)
  })

  it('reloads the tab when the alarm fires and the URL still matches', async () => {
    const name = `${RECOVERY_RELOAD_ALARM_PREFIX}:7:${Date.now()}:https://jmail.world/messages`
    const handled = await handlePackageOptInRecoveryAlarm({ name })
    expect(handled).toBe(true)
    expect(reload).toHaveBeenCalledWith(7)
    expect(clear).toHaveBeenCalledWith(name)
  })

  it('does NOT reload when the tab navigated away (no consent for the new page)', async () => {
    get.mockResolvedValue({ id: 7, url: 'https://unrelated.example/' })
    const name = `${RECOVERY_RELOAD_ALARM_PREFIX}:7:${Date.now()}:https://jmail.world/messages`
    const handled = await handlePackageOptInRecoveryAlarm({ name })
    expect(handled).toBe(true)
    expect(reload).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledWith(name)
  })

  it('keeps the alarm when the tab is not ready yet (transient error)', async () => {
    get.mockRejectedValue(new Error('No tab with id'))
    const name = `${RECOVERY_RELOAD_ALARM_PREFIX}:7:${Date.now()}:https://jmail.world/messages`
    const handled = await handlePackageOptInRecoveryAlarm({ name })
    expect(handled).toBe(true)
    expect(reload).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('clears an expired alarm without reloading (window elapsed)', async () => {
    const stale = Date.now() - 10 * 60 * 1000
    const name = `${RECOVERY_RELOAD_ALARM_PREFIX}:7:${stale}:https://jmail.world/messages`
    const handled = await handlePackageOptInRecoveryAlarm({ name })
    expect(handled).toBe(true)
    expect(reload).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledWith(name)
  })

  it('ignores alarms from other features', async () => {
    const handled = await handlePackageOptInRecoveryAlarm({ name: 'sched_abc' })
    expect(handled).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('cancels pending recovery alarms after a successful reload', async () => {
    const name = `${RECOVERY_RELOAD_ALARM_PREFIX}:7:${Date.now()}:https://jmail.world/messages`
    getAll.mockResolvedValue([{ name }, { name: 'sched_abc' }])
    const { cancelRecoveryReloadAlarms } =
      await import('../../../browser-extension/entrypoints/webmcp/package-optin-handler')
    await cancelRecoveryReloadAlarms(7)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith(name)
  })
})
