/**
 * Functional tests for the registry section of the merged packages page
 * (issue #193).
 *
 * Ported from `entrypoints/registry/__tests__/main.test.ts`: the section is
 * driven directly (no import-time bootstrap), so each test owns the loaded
 * registry state and the operation responses. The behaviors under test —
 * stale-error supersession, toast binding to a package, per-package feedback
 * generations — are the ones that regressed before.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import type { RegistryListResult } from '../../webmcp/registry-client-page'
import type { RegistrySection } from '../registry-section'

const registry = {
  rawBase: 'https://raw.githubusercontent.com/example/repo/main',
  manifestUrl: 'https://example.com/manifest.json',
  label: 'Example',
}
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

type SendHandler = (message: { type: string; [key: string]: unknown }) => unknown | Promise<unknown>

interface Harness {
  document: Document
  /** The section itself (to drive fail/render transitions directly). */
  section: RegistrySection
  /** The happy-dom window the section was built in (event constructors). */
  window: Window
  send: ReturnType<typeof vi.fn>
  /** The section's own re-render trigger (main.ts reloads both sources). */
  refresh: ReturnType<typeof vi.fn>
  sectionError(): HTMLElement
}

interface SetupOptions {
  state: () => RegistryListResult
  handlers?: Record<string, SendHandler | object>
}

/**
 * Install a fresh happy-dom document + chrome stub, build ONE registry
 * section, and render it with `state()`. `handlers` maps message types to
 * results: a function's return value is the payload (an `Error` becomes a
 * failure response); a non-function value is returned as-is.
 */
async function setup({ state, handlers = {} }: SetupOptions): Promise<Harness> {
  const win = new Window({ url: 'chrome-extension://test-extension/packages.html' })
  win.document.body.innerHTML = '<div id="sections"></div>'
  const send = vi.fn(async (message: { type: string }) => {
    const handler = handlers[message.type]
    if (!handler) return { ok: true }
    const result = typeof handler === 'function' ? await handler(message) : handler
    if (result instanceof Error) return { ok: false, error: result.message }
    return result instanceof Object && 'ok' in result ? result : { ok: true, ...(result as object) }
  })
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('window', win)
  vi.stubGlobal('chrome', {
    i18n: { getMessage: (key: string) => key },
    runtime: { sendMessage: send, onMessage: { addListener: vi.fn() } },
  })
  vi.stubGlobal('HTMLElement', win.HTMLElement)

  const { createRegistrySection } = await import('../registry-section')
  let section: RegistrySection
  const refresh = vi.fn(() => section.render(state()))
  section = createRegistrySection(
    win.document.getElementById('sections') as unknown as HTMLElement,
    () => refresh(),
  )
  section.render(state())
  await settle()
  return {
    document: win.document as unknown as Document,
    section,
    window: win,
    send,
    refresh,
    sectionError: () => win.document.querySelector('.error') as unknown as HTMLElement,
  }
}

function buttonByLabel(document: Document, label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement | undefined
}

function toastVisible(document: Document): boolean {
  return document.getElementById('successToast')?.classList.contains('visible') ?? false
}

/** Drain the async render chain: message round-trips + follow-up renders. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('registry section feedback', () => {
  it('a successful operation clears a stale error box', async () => {
    // A and B are BOTH held in flight; A fails first while B is still
    // running, so the stale red box is drawn AFTER B started and only B's
    // success path can supersede it.
    let releaseB: () => void = () => {}
    const bGate = new Promise<void>(resolve => { releaseB = resolve })
    const h = await setup({
      state: () => ({
        registries: [registry],
        installed: [],
        activations: {},
        persisted: true,
      }),
      handlers: {
        webmcp_registry_catalog: { manifest: { manifestUrl: registry.manifestUrl, name: 'Example', packages: [pkgA, pkgB] } },
        webmcp_registry_install: async (message) => {
          const pkg = message.package as { id: string }
          if (pkg.id === pkgA.id) return new Error('alpha exploded')
          await bGate
          return { filesWritten: 1 }
        },
      },
    })

    const installA = buttonByLabel(h.document, 'webmcpPackagesInstall')
    expect(installA).toBeTruthy()
    installA!.click()
    const installB = [...h.document.querySelectorAll('button')]
      .filter(b => b.textContent === 'webmcpPackagesInstall')
      .pop() as HTMLButtonElement
    expect(installB).not.toBe(installA)
    installB!.click()
    await settle()
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'webmcp_registry_install' }))

    // A fails while B is still held open: the red box is on screen.
    await settle()
    expect(h.sectionError().hidden).toBe(false)
    expect(h.sectionError().textContent).toContain('alpha exploded')

    // B succeeds: the success path must clear the stale error.
    releaseB()
    await settle()
    expect(toastVisible(h.document)).toBe(true)
    expect(h.sectionError().hidden).toBe(true)
  })

  it('a successful uninstall dismisses the success toast', async () => {
    let installed: string[] = []
    const h = await setup({
      state: () => ({ registries: [registry], installed, activations: {}, persisted: true }),
      handlers: {
        webmcp_registry_catalog: { manifest: { manifestUrl: registry.manifestUrl, name: 'Example', packages: [pkgA] } },
        webmcp_registry_install: { filesWritten: 3 },
        webmcp_registry_uninstall: () => {
          installed = []
          return {}
        },
      },
    })

    // Install succeeds → toast visible and the list reports the package.
    const install = buttonByLabel(h.document, 'webmcpPackagesInstall')
    install!.click()
    installed = [pkgA.id]
    await settle()
    expect(toastVisible(h.document)).toBe(true)

    // The re-rendered row now offers Uninstall; click it while the toast is
    // still inside its 3.5s window.
    const uninstall = [...h.document.querySelectorAll('button')]
      .find(b => b.textContent === 'webmcpPackagesUninstall') as HTMLButtonElement | undefined
    expect(uninstall).toBeTruthy()
    uninstall!.click()
    await settle()
    expect(toastVisible(h.document)).toBe(false)
  })

  it('a non-persisted list does not hide the install success toast', async () => {
    const h = await setup({
      state: () => ({ registries: [registry], installed: [], activations: {}, persisted: false }),
      handlers: {
        webmcp_registry_catalog: { manifest: { manifestUrl: registry.manifestUrl, name: 'Example', packages: [pkgA] } },
        webmcp_registry_install: { filesWritten: 3 },
      },
    })
    // The boot render already reported the persistence warning.
    expect(h.sectionError().hidden).toBe(false)
    expect(h.sectionError().textContent).toContain('webmcpPackagesNotPersisted')

    const install = buttonByLabel(h.document, 'webmcpPackagesInstall')
    install!.click()
    await settle()
    expect(toastVisible(h.document)).toBe(true)
    // The install's follow-up render re-reports the warning; the toast stays.
    await settle()
    expect(toastVisible(h.document)).toBe(true)
    expect(h.sectionError().hidden).toBe(false)
  })

  it('a repair resolving after a Remove suppresses its success toast', async () => {
    let installed = ['com.example.pkg']
    // Repair is held in flight AFTER its write: the response resolves only
    // when the test releases it — mirroring the background's route-refresh.
    let releaseRepair: () => void = () => {}
    const repairWrite = new Promise<void>(resolve => { releaseRepair = resolve })
    const h = await setup({
      state: () => ({ registries: [registry], installed, activations: {}, persisted: true }),
      handlers: {
        webmcp_registry_catalog: {
          manifest: { manifestUrl: registry.manifestUrl, name: 'Example', packages: [{ ...pkgA, id: 'com.example.pkg' }] },
        },
        webmcp_registry_install: async () => {
          installed = ['com.example.pkg']
          await repairWrite
          return { filesWritten: 3 }
        },
        webmcp_registry_uninstall: () => {
          installed = []
          return {}
        },
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

    // The deferred repair completion is really PROCESSED: the handler's
    // finally block restores the button and triggers a refresh. Both happen
    // only when the awaited response is consumed.
    const refreshesBeforeRelease = h.refresh.mock.calls.length
    expect(repair!.textContent).toBe('webmcpPackagesInstalling')
    expect(repair!.disabled).toBe(true)
    releaseRepair()
    await settle()
    await settle()
    expect(repair!.textContent).toBe('webmcpPackagesRepair')
    expect(repair!.disabled).toBe(false)
    expect(h.refresh.mock.calls.length).toBeGreaterThan(refreshesBeforeRelease)
    expect(toastVisible(h.document)).toBe(false)
    expect(h.sectionError().hidden).toBe(true)
  })

  it('a failed install of package A still reports while package B is in flight', async () => {
    // A's install FAILS while B is held in flight. Under a page-global token
    // B's start invalidated A's token, so A's failure was never reported.
    let releaseB: () => void = () => {}
    const bGate = new Promise<void>(resolve => { releaseB = resolve })
    const h = await setup({
      state: () => ({ registries: [registry], installed: [], activations: {}, persisted: true }),
      handlers: {
        webmcp_registry_catalog: { manifest: { manifestUrl: registry.manifestUrl, name: 'Example', packages: [pkgA, pkgB] } },
        webmcp_registry_install: async (message) => {
          const pkg = message.package as { id: string }
          if (pkg.id === pkgA.id) return new Error('alpha exploded')
          await bGate
          return { filesWritten: 1 }
        },
      },
    })

    const installA = buttonByLabel(h.document, 'webmcpPackagesInstall')
    installA!.click()
    const installB = [...h.document.querySelectorAll('button')]
      .filter(b => b.textContent === 'webmcpPackagesInstall')
      .pop() as HTMLButtonElement
    expect(installB).not.toBe(installA)
    installB!.click()
    await settle()

    expect(h.sectionError().hidden).toBe(false)
    expect(h.sectionError().textContent).toContain('alpha exploded')

    releaseB()
    await settle()
    expect(toastVisible(h.document)).toBe(true)
  })

  it('a recovered load clears its own failure and the session-only warning', async () => {
    const state = (persisted: boolean): RegistryListResult => ({ registries: [registry], installed: [], activations: {}, persisted })
    const h = await setup({
      state: () => state(false),
      handlers: {
        webmcp_registry_catalog: { manifest: { manifestUrl: registry.manifestUrl, name: 'Example', packages: [] } },
      },
    })
    expect(h.sectionError().textContent).toContain('webmcpPackagesNotPersisted')

    h.section.fail(new Error('registry list unavailable'))
    expect(h.sectionError().hidden).toBe(false)
    expect(h.sectionError().textContent).toContain('registry list unavailable')

    // Persistence recovered AND the load succeeded: neither message survives.
    h.section.render(state(true))
    await settle()
    expect(h.sectionError().hidden).toBe(true)
    expect(h.sectionError().textContent).not.toContain('registry list unavailable')
    expect(h.sectionError().textContent).not.toContain('webmcpPackagesNotPersisted')
  })

  it('enables an installed registry package from its own row', async () => {
    // Installs record the disabled default and "mine" excludes registry
    // installs, so this row's toggle is the ONLY activation path on the page.
    const h = await setup({
      state: () => ({ registries: [registry], installed: [pkgA.id], activations: { [pkgA.id]: 'disabled' }, persisted: true }),
      handlers: {
        webmcp_registry_catalog: { manifest: { manifestUrl: registry.manifestUrl, name: 'Example', packages: [pkgA] } },
      },
    })
    const row = [...h.document.querySelectorAll('.pkg-row')]
      .find(element => element.querySelector('.name')?.textContent === pkgA.id)
    const toggle = row?.querySelector<HTMLInputElement>('input.toggle')
    expect(toggle).toBeTruthy()
    expect(toggle!.checked).toBe(false)

    toggle!.checked = true
    toggle!.dispatchEvent(new h.window.Event('change') as unknown as Event)
    await settle()

    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'webmcp_packages_set_config',
      mount: 'webmcp',
      directory: pkgA.id,
      config: { activation: 'enabled' },
    }))
  })

  it('removing package B keeps the toast announcing package A', async () => {
    let installed = ['com.example.beta']
    const h = await setup({
      state: () => ({ registries: [registry], installed, activations: {}, persisted: true }),
      handlers: {
        webmcp_registry_catalog: { manifest: { manifestUrl: registry.manifestUrl, name: 'Example', packages: [pkgA, pkgB] } },
        webmcp_registry_install: async () => {
          installed = ['com.example.alpha', 'com.example.beta']
          return { filesWritten: 1 }
        },
        webmcp_registry_uninstall: (message) => {
          const pkg = message.package as { id: string }
          installed = installed.filter(id => id !== pkg.id)
          return {}
        },
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
    const betaRow = [...h.document.querySelectorAll('button')]
      .find(b => b.textContent === 'webmcpPackagesUninstall' &&
        b.closest('.pkg-row')?.querySelector('.name')?.textContent === 'com.example.beta') as HTMLButtonElement | undefined
    expect(betaRow).toBeTruthy()
    betaRow!.click()
    await settle()
    expect(toastVisible(h.document)).toBe(true)
  })

  it('the expired toast leaves the accessibility tree', async () => {
    // happy-dom's window.setTimeout is its own implementation, not
    // fake-timer-transparent, so run on real timers and let the 3.5s elapse.
    const h = await setup({
      state: () => ({ registries: [registry], installed: [], activations: {}, persisted: true }),
      handlers: {
        webmcp_registry_catalog: { manifest: { manifestUrl: registry.manifestUrl, name: 'Example', packages: [pkgA] } },
        webmcp_registry_install: { filesWritten: 3 },
      },
    })
    const install = buttonByLabel(h.document, 'webmcpPackagesInstall')
    install!.click()
    await settle()
    const toast = h.document.getElementById('successToast')!
    expect(toast.classList.contains('visible')).toBe(true)
    expect(toast.getAttribute('aria-hidden')).toBe('false')
    await new Promise(resolve => setTimeout(resolve, 3600))
    expect(toast.classList.contains('visible')).toBe(false)
    expect(toast.getAttribute('aria-hidden')).toBe('true')
  }, 10000)
})
