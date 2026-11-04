/**
 * Regression tests for the registry management page (round-2 Sourcery
 * findings on the toast/state feedback logic).
 *
 * main.ts is an entrypoint with side effects at import time: each test
 * wires a happy-dom document, stubs the global `chrome` messaging layer
 * (the same channel registry-client-page uses), then imports the module
 * fresh to run its bootstrap render under controlled responses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'

const registry = { manifestUrl: 'https://example.com/manifest.json', label: 'Example' }
const pkgA = {
  id: 'com.example.alpha',
  version: '1.0.0',
  description: 'Package A',
  toolCount: 1,
  files: [],
}
const pkgB = {
  id: 'com.example.beta',
  version: '2.0.0',
  description: 'Package B',
  toolCount: 1,
  files: [],
}

interface Harness {
  document: Document
  send: ReturnType<typeof vi.fn>
}

type SendHandler = (message: { type: string }) => unknown | Promise<unknown>

/**
 * Install a fresh happy-dom document + chrome stub, then import main.ts.
 * `handlers` maps message types to results: a function's return value is
 * the response payload (an `Error` becomes a failure response); a
 * non-function value is returned as-is.
 */
async function setup(handlers: Record<string, SendHandler | object>): Promise<Harness> {
  const win = new Window({ url: 'https://registry.extension/index.html' })
  win.document.body.innerHTML = `
    <p id="pageError" hidden><span id="pageErrorText"></span><span id="pageErrorDismiss"></span></p>
    <h1 id="pageTitle"></h1><p id="pageSubtitle"></p>
    <div id="registryTitle"></div><div id="registryList"></div>
    <div class="add-box"><div class="add-row"><input id="registryInput" /><button id="registryAdd"></button></div><div class="hint" id="registryHint"></div></div>
    <div id="installedTitle"></div><div id="installedList"></div>
    <p id="pageNote"></p>
  `
  const send = vi.fn(async (message: { type: string }) => {
    const handler = handlers[message.type]
    if (!handler) return { ok: true }
    const result = typeof handler === 'function' ? await handler(message) : handler
    if (result instanceof Error) return { ok: false, error: result.message }
    return result instanceof Object && 'ok' in result ? result : { ok: true, ...(result as object) }
  })
  const chromeStub = {
    i18n: { getMessage: (key: string) => key },
    runtime: {
      sendMessage: send,
      onMessage: { addListener: vi.fn() },
    },
  }
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('window', win)
  vi.stubGlobal('chrome', chromeStub)
  vi.stubGlobal('HTMLElement', win.HTMLElement)
  vi.stubGlobal('HTMLButtonElement', win.HTMLButtonElement)

  await import('../main')
  await settle()
  return { document: win.document as unknown as Document, send }
}

function buttonByLabel(document: Document, label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement | undefined
}

function successToast(document: Document): HTMLElement | null {
  return document.getElementById('successToast')
}

function toastVisible(document: Document): boolean {
  return successToast(document)?.classList.contains('visible') ?? false
}

/** Drain the async render chain: message round-trips + follow-up renders. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

function errorBox(document: Document): HTMLElement {
  return document.getElementById('pageError')!
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('registry page toast/state feedback (round 2)', () => {
  it('a successful operation clears a stale error box (thread KeVm)', async () => {
    // Package A and B are BOTH held in flight; A fails first while B is
    // still running. B's START cleared the error, A's failure re-drew it;
    // when B finally SUCCEEDS, the stale red box from A must be superseded
    // by showSuccess() itself — not sit beside the green toast.
    //
    // Ordering matters for the regression value: B starts while A is still
    // in flight, so nothing about B's click can mask the assertion — the
    // error box is re-drawn AFTER B started and only B's SUCCESS path runs
    // afterwards (Sourcery round 3: the previous shape clicked B only after
    // A's error was already displayed, so B's start-time clearError() would
    // have hidden a broken showSuccess()).
    let releaseB: () => void = () => {}
    const bGate = new Promise<void>(resolve => { releaseB = resolve })
    const h = await setup({
      webmcp_registry_list: { registries: [registry], installed: [], activations: {}, persisted: true },
      webmcp_registry_catalog: { manifest: { manifestUrl: registry.manifestUrl, name: 'Example', packages: [pkgA, pkgB] } },
      webmcp_registry_install: async (message: { package: { id: string } }) => {
        if (message.package.id === pkgA.id) return new Error('alpha exploded')
        await bGate
        return { filesWritten: 1 }
      },
    })

    const installA = buttonByLabel(h.document, 'webmcpPackagesInstall')
    expect(installA).toBeTruthy()
    installA!.click()
    // A is in flight when B starts.
    const installB = [...h.document.querySelectorAll('button')]
      .filter(b => b.textContent === 'webmcpPackagesInstall')
      .pop() as HTMLButtonElement
    expect(installB).not.toBe(installA)
    installB!.click()
    await settle()
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'webmcp_registry_install' }))

    // A fails while B is still held open: the red box is on screen.
    await settle()
    expect(errorBox(h.document).hidden).toBe(false)
    expect(errorBox(h.document).textContent).toContain('alpha exploded')

    // B succeeds: the success path must clear the stale error.
    releaseB()
    await settle()
    expect(toastVisible(h.document)).toBe(true)
    // Regression: the stale error used to stay beside the success toast.
    expect(errorBox(h.document).hidden).toBe(true)
  })

  it('a successful uninstall dismisses the success toast (thread KeVZ)', async () => {
    let installed: string[] = []
    const h = await setup({
      webmcp_registry_list: () => ({ registries: [registry], installed, activations: {}, persisted: true }),
      webmcp_registry_catalog: { manifest: { manifestUrl: registry.manifestUrl, name: 'Example', packages: [pkgA] } },
      webmcp_registry_install: { filesWritten: 3 },
      webmcp_registry_uninstall: () => {
        installed = []
        return {}
      },
    })

    // Install succeeds → toast visible and the list reports the package.
    const install = buttonByLabel(h.document, 'webmcpPackagesInstall')
    install!.click()
    installed = [pkgA.id]
    await settle()
    expect(toastVisible(h.document)).toBe(true)

    // The re-rendered row now offers Uninstall; click the package row's
    // (FIRST) uninstall while the toast is still inside its 3.5s window.
    const uninstall = [...h.document.querySelectorAll('button')]
      .find(b => b.textContent === 'webmcpPackagesUninstall') as HTMLButtonElement | undefined
    expect(uninstall).toBeTruthy()
    uninstall!.click()
    await settle()
    // Regression: the uninstall path used to leave the green toast visible.
    expect(toastVisible(h.document)).toBe(false)
  })

  it('a non-persisted list does not hide the install success toast (thread KeVi)', async () => {
    const h = await setup({
      webmcp_registry_list: { registries: [registry], installed: [], activations: {}, persisted: false },
      webmcp_registry_catalog: { manifest: { manifestUrl: registry.manifestUrl, name: 'Example', packages: [pkgA] } },
      webmcp_registry_install: { filesWritten: 3 },
    })
    // The boot render already reported the persistence warning.
    expect(errorBox(h.document).hidden).toBe(false)

    const install = buttonByLabel(h.document, 'webmcpPackagesInstall')
    install!.click()
    // First settle: the install resolves and the success toast shows.
    await settle()
    expect(toastVisible(h.document)).toBe(true)

    // The install's finally-block render re-reports the non-blocking
    // persistence warning; the success toast must STAY visible (regression:
    // the warning reused showError(), which dismissed the toast).
    await settle()
    expect(toastVisible(h.document)).toBe(true)
    expect(errorBox(h.document).hidden).toBe(false)
  })

  it('a repair resolving after a Remove suppresses its success toast (thread KeVP)', async () => {
    let installed = ['com.example.pkg']
    // Repair is held in flight AFTER its write: the response resolves only
    // when the test releases it — mirroring the background's route-refresh
    // wait the real client performs.
    let releaseRepair: () => void = () => {}
    const repairWrite = new Promise<void>(resolve => { releaseRepair = resolve })
    const h = await setup({
      webmcp_registry_list: { registries: [registry], installed, activations: {}, persisted: true },
      webmcp_registry_catalog: { manifest: { manifestUrl: registry.manifestUrl, name: 'Example', packages: [{ ...pkgA, id: 'com.example.pkg' }] } },
      webmcp_registry_install: async () => {
        // The package write lands, then the response waits (route refresh).
        installed = ['com.example.pkg']
        await repairWrite
        return { filesWritten: 3 }
      },
      webmcp_registry_uninstall: () => {
        installed = []
        return {}
      },
    })

    const repair = buttonByLabel(h.document, 'webmcpPackagesRepair')
    const uninstall = buttonByLabel(h.document, 'webmcpPackagesUninstall')
    expect(repair).toBeTruthy()
    expect(uninstall).toBeTruthy()

    // Start the repair (stays in flight)…
    repair!.click()
    await settle()
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'webmcp_registry_install' }))

    // …then remove the package before the repair response returns.
    uninstall!.click()
    await settle()
    expect(toastVisible(h.document)).toBe(false)

    // The repair response finally resolves — it must NOT show "installed":
    // the package was removed while the repair was in flight.
    // Round 3: prove the deferred repair completion was actually PROCESSED
    // (previously the assertions only checked absence — the test stayed
    // green even if repair completions never rendered feedback at all).
    // Processing the response runs the repair handler's finally block: the
    // Repair button's label is restored from "installing" and re-enabled,
    // and its trailing render() issues a FRESH webmcp_registry_list call.
    // Both observables occur only after the awaited response is consumed —
    // an install-call count would prove only that the request was SENT.
    const listCallsBeforeRelease = h.send.mock.calls.filter(
      ([m]) => (m as { type: string }).type === 'webmcp_registry_list',
    ).length
    expect(repair!.textContent).toBe('webmcpPackagesInstalling')
    expect(repair!.disabled).toBe(true)
    releaseRepair()
    await settle()
    await settle()
    expect(repair!.textContent).toBe('webmcpPackagesRepair')
    expect(repair!.disabled).toBe(false)
    const listCallsAfterRelease = h.send.mock.calls.filter(
      ([m]) => (m as { type: string }).type === 'webmcp_registry_list',
    ).length
    expect(listCallsAfterRelease).toBeGreaterThan(listCallsBeforeRelease)
    expect(toastVisible(h.document)).toBe(false)
    // And no stale red error either — the removal legitimately succeeded.
    expect(errorBox(h.document).hidden).toBe(true)
  })
  it('a failed install of package A still reports while package B is in flight (round 3: per-package feedback)', async () => {
    // A's install FAILS while B is held in flight. Under the page-global
    // token, B's start invalidated A's token, so A's failure was never
    // reported (its showError was suppressed by isFeedbackCurrent). With
    // per-package generations A's failure always lands.
    let releaseB: () => void = () => {}
    const bGate = new Promise<void>(resolve => { releaseB = resolve })
    const h = await setup({
      webmcp_registry_list: { registries: [registry], installed: [], activations: {}, persisted: true },
      webmcp_registry_catalog: { manifest: { manifestUrl: registry.manifestUrl, name: 'Example', packages: [pkgA, pkgB] } },
      webmcp_registry_install: async (message: { package: { id: string } }) => {
        if (message.package.id === pkgA.id) return new Error('alpha exploded')
        await bGate
        return { filesWritten: 1 }
      },
    })

    // Start A, keep it in flight, start B, then let A fail FIRST.
    const installA = buttonByLabel(h.document, 'webmcpPackagesInstall')
    installA!.click()
    const installB = [...h.document.querySelectorAll('button')]
      .filter(b => b.textContent === 'webmcpPackagesInstall')
      .pop() as HTMLButtonElement
    expect(installB).not.toBe(installA)
    installB!.click()
    await settle()

    // A's failure landed (superseding B's start-time cleared box) while B
    // is STILL in flight — this is the exact suppression the global token
    // produced.
    expect(errorBox(h.document).hidden).toBe(false)
    expect(errorBox(h.document).textContent).toContain('alpha exploded')

    // B then succeeds: the toast shows; A's failure box is superseded by
    // the success (designed stale-error behavior, unchanged).
    releaseB()
    await settle()
    expect(toastVisible(h.document)).toBe(true)
  })

  it('removing package B keeps the toast announcing package A (round 3: toast-package binding)', async () => {
    // A installs (toast announces A), then the installed B is uninstalled
    // while the toast is up. The round-2 shape dismissed the single global
    // toast on EVERY successful uninstall — A's true confirmation vanished.
    let installed = ['com.example.beta']
    const h = await setup({
      webmcp_registry_list: { registries: [registry], installed, activations: {}, persisted: true },
      webmcp_registry_catalog: { manifest: { manifestUrl: registry.manifestUrl, name: 'Example', packages: [pkgA, pkgB] } },
      webmcp_registry_install: async () => {
        installed = ['com.example.alpha', 'com.example.beta']
        return { filesWritten: 1 }
      },
      webmcp_registry_uninstall: (message: { package: { id: string } }) => {
        installed = installed.filter(id => id !== message.package.id)
        return {}
      },
    })

    // Install A: its toast is up, announcing com.example.alpha.
    const installA = [...h.document.querySelectorAll('button')]
      .find(b => b.textContent === 'webmcpPackagesInstall') as HTMLButtonElement | undefined
    expect(installA).toBeTruthy()
    installA!.click()
    await settle()
    expect(toastVisible(h.document)).toBe(true)

    // Uninstall B via B's own catalog row while A's toast is showing.
    // The redesign nests package rows (.pkg-row) INSIDE the registry card,
    // whose header .name is the registry label — match the row's own name.
    const betaRow = [...h.document.querySelectorAll('button')]
      .find(b => b.textContent === 'webmcpPackagesUninstall' &&
        b.closest('.pkg-row')?.querySelector('.name')?.textContent === 'com.example.beta') as HTMLButtonElement | undefined
    expect(betaRow).toBeTruthy()
    betaRow!.click()
    await settle()
    // Regression: the toast announcing A must survive B's removal.
    expect(toastVisible(h.document)).toBe(true)
  })

  it('the expired toast leaves the accessibility tree (round 3: aria-hidden)', async () => {
    // happy-dom's window.setTimeout is its own internal implementation —
    // not vitest-fake-timer-transparent (even `toFake: []` still stubs the
    // global setTimeout with a never-firing fake) — so run on real timers
    // and let the actual 3.5s auto-hide elapse, asserting both phases.
    const h = await setup({
      webmcp_registry_list: { registries: [registry], installed: [], activations: {}, persisted: true },
      webmcp_registry_catalog: { manifest: { manifestUrl: registry.manifestUrl, name: 'Example', packages: [pkgA] } },
      webmcp_registry_install: { filesWritten: 3 },
    })
    const install = buttonByLabel(h.document, 'webmcpPackagesInstall')
    install!.click()
    await settle()
    const toast = successToast(h.document)!
    expect(toast.classList.contains('visible')).toBe(true)
    expect(toast.getAttribute('aria-hidden')).toBe('false')
    await new Promise(resolve => setTimeout(resolve, 3600))
    expect(toast.classList.contains('visible')).toBe(false)
    // Regression: the region used to stay in the a11y tree after fading out.
    expect(toast.getAttribute('aria-hidden')).toBe('true')
  }, 10000)
})
