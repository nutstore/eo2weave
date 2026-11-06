/**
 * Card wiring for the built-in and "mine" sections (issue #193).
 *
 * Ported from the web app's `package-management-page.test.ts`, which drove the
 * deleted `entrypoints/recipes/main.ts`. Same behaviors, now owned by the
 * section that renders the card: which mount lands in which section, the
 * disabled toggle of a broken package, toggle persistence, per-section error
 * isolation, and the delete confirm/recover path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import type { ManagedWebMCPPackage } from '../../webmcp/package-client'

vi.mock('../../webmcp/package-client', () => ({
  listManagedPackages: vi.fn(),
  setManagedPackageConfig: vi.fn(),
  deleteManagedPackage: vi.fn(),
}))

import { deleteManagedPackage, setManagedPackageConfig } from '../../webmcp/package-client'
import { createBuiltinSection } from '../builtin-section'
import { createMineSection } from '../mine-section'

const tool = (name: string) => ({ name, description: `${name} tool`, urlRegex: '.*', path: `${name}.js` })

function entry(overrides: Partial<ManagedWebMCPPackage> & { id: string }): ManagedWebMCPPackage {
  const { id, ...rest } = overrides
  return {
    directory: id,
    mount: 'webmcp',
    uri: `vfs://external/webmcp/${id}/`,
    access: 'read-write',
    config: null,
    activation: 'disabled',
    diagnostics: [],
    manifest: { id, version: '1.0.0', description: `${id} package`, tools: [tool('run')] },
    ...rest,
  } as ManagedWebMCPPackage
}

interface Dom {
  win: Window
  doc: Document
}

function setupDom(): Dom {
  const win = new Window({ url: 'chrome-extension://test-extension/packages.html' })
  const doc = win.document as unknown as Document
  doc.body.innerHTML = '<div id="builtinHost"></div><div id="mineHost"></div>'
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('window', win)
  vi.stubGlobal('chrome', {
    i18n: { getMessage: (key: string) => key },
    runtime: { onMessage: { addListener: vi.fn() } },
  })
  return { win, doc }
}

function host(doc: Document, id: string): HTMLElement {
  return doc.getElementById(id)!
}

/** Drain the async card handlers (config write + follow-up refresh). */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.mocked(setManagedPackageConfig).mockReset().mockResolvedValue(undefined)
  vi.mocked(deleteManagedPackage).mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('built-in section', () => {
  it('lists only the built-in mount and disables a package it cannot enable', () => {
    const { win, doc } = setupDom()
    const builtin = createBuiltinSection(host(doc, 'builtinHost'), () => {})
    const broken = entry({
      id: 'com.example.broken',
      mount: 'builtin-webmcp',
      access: 'read-only',
      manifest: null,
      diagnostics: ['manifest.json: missing'],
    })
    builtin.render([
      entry({ id: 'com.douban.movie', mount: 'builtin-webmcp', access: 'read-only', activation: 'enabled' }),
      broken,
      entry({ id: 'com.example.mine' }),
    ])

    const cards = doc.querySelectorAll('#builtinHost .card')
    expect(cards).toHaveLength(2)
    expect(doc.body.textContent).toContain('com.douban.movie')
    expect(doc.body.textContent).not.toContain('com.example.mine')
    expect(doc.body.textContent).toContain('manifest.json: missing')
    // A package without a manifest can never be activated.
    expect(doc.querySelectorAll<HTMLInputElement>('#builtinHost .toggle')[1].disabled).toBe(true)
    // Read-only mount: no delete action.
    expect(doc.querySelectorAll('#builtinHost .btn.danger')).toHaveLength(0)
  })

  it('persists a toggle change and re-reads the source', async () => {
    const { win, doc } = setupDom()
    const refresh = vi.fn()
    const builtin = createBuiltinSection(host(doc, 'builtinHost'), refresh)
    const pkg = entry({ id: 'com.example.builtin', mount: 'builtin-webmcp', access: 'read-only' })
    builtin.render([pkg])

    const toggle = doc.querySelector<HTMLInputElement>('#builtinHost .toggle')!
    toggle.checked = true
    toggle.dispatchEvent(new win.Event('change') as unknown as Event)
    await settle()

    expect(setManagedPackageConfig).toHaveBeenCalledWith(pkg, { activation: 'enabled' })
    expect(refresh).toHaveBeenCalled()
  })

  it('reports a failed write in its own error box and rolls the toggle back', async () => {
    const { win, doc } = setupDom()
    vi.mocked(setManagedPackageConfig).mockRejectedValueOnce(new Error('Storage unavailable'))
    const builtin = createBuiltinSection(host(doc, 'builtinHost'), () => {})
    builtin.render([entry({ id: 'com.example.builtin', mount: 'builtin-webmcp', access: 'read-only' })])

    const toggle = doc.querySelector<HTMLInputElement>('#builtinHost .toggle')!
    toggle.checked = true
    toggle.dispatchEvent(new win.Event('change') as unknown as Event)
    await settle()

    const error = doc.querySelector('#builtinHost .error') as HTMLElement
    expect(error.hidden).toBe(false)
    expect(error.textContent).toContain('Storage unavailable')
    expect(toggle.checked).toBe(false)
  })
})

describe('mine section', () => {
  it('excludes registry installs and offers delete on the rw mount', () => {
    const { win, doc } = setupDom()
    const mine = createMineSection(host(doc, 'mineHost'), () => {})
    mine.render([
      entry({ id: 'com.example.alpha', activation: 'enabled' }),
      entry({ id: 'com.weiwei.report' }),
      entry({ id: 'com.douban.movie', mount: 'builtin-webmcp', access: 'read-only' }),
    ], new Set(['com.example.alpha']))

    expect(doc.querySelectorAll('#mineHost .card')).toHaveLength(1)
    expect(doc.body.textContent).toContain('com.weiwei.report')
    expect(doc.body.textContent).not.toContain('com.example.alpha')
    expect(doc.querySelectorAll('#mineHost .btn.danger')).toHaveLength(1)
  })

  it('reports an unreadable user mount instead of an empty section', () => {
    // The catalog degrades to builtin-only when the user mount cannot be
    // listed; "empty" would then be a claim the page cannot make.
    const { doc } = setupDom()
    const mine = createMineSection(host(doc, 'mineHost'), () => {})
    mine.render([entry({ id: 'com.example.builtin', mount: 'builtin-webmcp', access: 'read-only' })], new Set(), { userMountComplete: false })

    const error = doc.querySelector('#mineHost .error') as HTMLElement
    expect(error.hidden).toBe(false)
    expect(error.textContent).toContain('webmcpPackagesMineUnavailable')
    expect(doc.body.textContent).not.toContain('webmcpPackagesEmptyMine')
  })

  it('keeps a failed config write out of the sibling section', async () => {
    const { win, doc } = setupDom()
    vi.mocked(setManagedPackageConfig).mockRejectedValueOnce(new Error('Storage unavailable'))
    const builtin = createBuiltinSection(host(doc, 'builtinHost'), () => {})
    const mine = createMineSection(host(doc, 'mineHost'), () => {})
    builtin.render([entry({ id: 'com.example.builtin', mount: 'builtin-webmcp', access: 'read-only' })])
    mine.render([entry({ id: 'com.example.mine' })], new Set())

    const toggle = doc.querySelector<HTMLInputElement>('#mineHost .toggle')!
    toggle.checked = true
    toggle.dispatchEvent(new win.Event('change') as unknown as Event)
    await settle()

    expect((doc.querySelector('#mineHost .error') as HTMLElement).textContent).toContain('Storage unavailable')
    // Section isolation: the built-in section never shows another section's failure.
    expect((doc.querySelector('#builtinHost .error') as HTMLElement).hidden).toBe(true)
  })

  it('asks before deleting, then deletes and refreshes', async () => {
    const { win, doc } = setupDom()
    const refresh = vi.fn()
    const mine = createMineSection(host(doc, 'mineHost'), refresh)
    const pkg = entry({ id: 'com.example.mine' })
    mine.render([pkg], new Set())

    const confirm = vi.fn(() => false)
    ;(win as unknown as { confirm: typeof confirm }).confirm = confirm
    const remove = doc.querySelector<HTMLButtonElement>('#mineHost .btn.danger')!
    remove.click()
    await settle()
    expect(confirm).toHaveBeenCalled()
    expect(deleteManagedPackage).not.toHaveBeenCalled()

    confirm.mockReturnValue(true)
    remove.click()
    await settle()
    expect(deleteManagedPackage).toHaveBeenCalledWith(pkg)
    expect(refresh).toHaveBeenCalled()

  })

  it('recovers the delete action when the deletion fails', async () => {
    const { win, doc } = setupDom()
    vi.mocked(deleteManagedPackage).mockRejectedValueOnce(new Error('Deletion failed'))
    const mine = createMineSection(host(doc, 'mineHost'), () => {})
    mine.render([entry({ id: 'com.example.mine' })], new Set())

    const confirm = vi.fn(() => true)
    ;(win as unknown as { confirm: typeof confirm }).confirm = confirm
    const remove = doc.querySelector<HTMLButtonElement>('#mineHost .btn.danger')!
    remove.click()
    await settle()

    expect((doc.querySelector('#mineHost .error') as HTMLElement).textContent).toContain('Deletion failed')
    expect(remove.disabled).toBe(false)

  })
})

describe('catalog rejection (issue #239)', () => {
  it('shows why the adapter catalog dropped an otherwise valid package', () => {
    const { doc } = setupDom()
    const builtin = createBuiltinSection(host(doc, 'builtinHost'), () => {})
    builtin.render([
      entry({
        id: 'org.opentabs.tools',
        mount: 'builtin-webmcp',
        access: 'read-only',
        activation: 'enabled',
        catalogRejection: 'Package source exceeds the size limit (1200000 characters)',
      }),
      entry({ id: 'com.example.healthy', mount: 'builtin-webmcp', access: 'read-only' }),
    ])

    const rejection = doc.querySelector('#builtinHost .diagnostic.rejection')!
    expect(rejection).not.toBeNull()
    expect(rejection.textContent).toContain('webmcpPackageRejected')
    expect(rejection.textContent).toContain('Package source exceeds the size limit')
    // Only the rejected card carries it.
    expect(doc.querySelectorAll('#builtinHost .diagnostic.rejection')).toHaveLength(1)
  })

  it('leaves a healthy card without a rejection row', () => {
    const { doc } = setupDom()
    const builtin = createBuiltinSection(host(doc, 'builtinHost'), () => {})
    builtin.render([entry({ id: 'com.example.healthy', mount: 'builtin-webmcp', access: 'read-only' })])
    expect(doc.querySelector('#builtinHost .diagnostic.rejection')).toBeNull()
  })
})
