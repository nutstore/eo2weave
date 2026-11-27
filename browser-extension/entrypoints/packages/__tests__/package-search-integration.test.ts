import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import type { ManagedWebMCPPackage } from '../../webmcp/package-client'

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

async function setup(previewFails = false) {
  const win = new Window({ url: 'chrome-extension://test/packages.html' })
  const doc = win.document as unknown as Document
  doc.body.innerHTML = '<input id="search"><button id="clear">Clear</button><p id="status"></p><div id="builtin"></div><div id="mine"></div><div id="registry"></div>'
  const source = { manifestUrl: 'https://example.com/manifest.json', rawBase: 'https://example.com', label: 'Example' }
  const pkg = { id: 'com.example.registry', version: '1.0.0', description: 'Registry package', toolCount: 8, files: [] }
  const state = { registries: [source], installed: ['com.example.orphan'], activations: {}, persisted: true }
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const send = vi.fn(async (message: { type: string }) => {
    if (message.type === 'webmcp_registry_catalog') return { ok: true, manifest: { name: 'Example', packages: [pkg] } }
    if (message.type === 'webmcp_registry_preview') {
      await gate
      if (previewFails) return { ok: false, error: 'Preview unavailable' }
      return { ok: true, tools: Array.from({ length: 8 }, (_, i) => ({ name: i === 7 ? 'late_hidden_tool' : `tool${i}`, description: '' })) }
    }
    return { ok: true }
  })
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('chrome', { i18n: { getMessage: (key: string) => key }, runtime: { sendMessage: send } })
  const { createPackageSearch } = await import('../package-search')
  const { createBuiltinSection } = await import('../builtin-section')
  const { createMineSection } = await import('../mine-section')
  const { createRegistrySection } = await import('../registry-section')
  const input = doc.getElementById('search') as HTMLInputElement
  const status = doc.getElementById('status')!
  const clear = doc.getElementById('clear') as HTMLButtonElement
  const format = vi.fn((matched: number, total: number) => `${matched}/${total}`)
  const search = createPackageSearch(input, clear, status, format)
  const builtin = createBuiltinSection(doc.getElementById('builtin')!, vi.fn(), undefined, search)
  const mine = createMineSection(doc.getElementById('mine')!, vi.fn(), undefined, search)
  const registry = createRegistrySection(doc.getElementById('registry')!, vi.fn(), undefined, search)
  const entry = (id: string, mount: string, description: string): ManagedWebMCPPackage => ({
    directory: id, mount, uri: `vfs://external/${mount}/${id}/`, access: mount === 'webmcp' ? 'read-write' : 'read-only',
    activation: 'disabled', config: null, diagnostics: [],
    manifest: { id, version: '1.0.0', description, tools: Array.from({ length: 8 }, (_, i) => ({
      name: i === 7 ? 'builtin_hidden_tool' : `read${i}`, description: '', urlRegex: '.*', path: `read${i}.js`,
    })) },
  })
  const entries = [entry('com.example.builtin', 'builtin-webmcp', 'Document reader'), entry('com.example.mine', 'webmcp', 'Invoice summary')]
  const render = () => { builtin.render(entries); mine.render(entries, new Set()); registry.render(state) }
  render()
  await settle()
  const query = async (value: string) => { input.value = value; input.dispatchEvent(new win.Event('input') as unknown as Event); await settle() }
  const rows = () => [...doc.querySelectorAll<HTMLElement>('.card.pkg, .pkg-row')]
  const visible = () => rows().filter(row => !row.hidden)
  const removeRegistry = () => { state.registries = []; state.installed = []; registry.render(state) }
  return { doc, input, clear, status, send, release, query, render, rows, visible, removeRegistry, format }
}

it('searches every source, all tool names and orphan IDs without rebuilding rows or fetching', async () => {
  const h = await setup()
  const rows = h.rows()
  const requests = h.send.mock.calls.length
  expect(rows).toHaveLength(4)
  await h.query('  COM.EXAMPLE.BUILTIN ')
  expect(h.visible()).toHaveLength(1)
  expect(h.visible()[0].textContent).toContain('com.example.builtin')
  await h.query('invoice')
  expect(h.visible()).toHaveLength(1)
  expect(h.visible()[0].textContent).toContain('com.example.mine')
  await h.query('builtin_hidden_tool')
  expect(h.visible()).toHaveLength(2)
  await h.query('com.example.orphan')
  expect(h.visible()).toHaveLength(1)
  expect(h.status.textContent).toBe('1/4')
  expect(h.send.mock.calls).toHaveLength(requests)
  h.rows().forEach((row, index) => expect(row).toBe(rows[index]))
  h.release()
  await settle()
})

it('matches a tool preview that arrives during a search and keeps the filter after rendering', async () => {
  const h = await setup()
  const row = h.rows().find(row => row.classList.contains('pkg-row'))!
  await h.query('late_hidden_tool')
  expect(h.visible()).toHaveLength(0)
  expect(h.status.textContent).toBe('0/4')
  expect(h.format).toHaveBeenLastCalledWith(0, 4, 1)
  h.release()
  await settle()
  expect(h.visible()).toEqual([row])
  expect(h.status.textContent).toBe('1/4')
  expect(h.format).toHaveBeenLastCalledWith(1, 4, 0)
  h.render()
  await settle()
  expect(h.input.value).toBe('late_hidden_tool')
  expect(h.visible()).toHaveLength(1)
  expect(h.status.textContent).toBe('1/4')
  h.clear.click()
  await settle()
  expect(h.visible()).toHaveLength(4)
})

it('keeps search feedback incomplete when a registry tool preview fails', async () => {
  const h = await setup(true)
  await h.query('unknown_tool')
  h.release()
  await settle()
  expect(h.format).toHaveBeenLastCalledWith(0, 4, 1)
  h.removeRegistry()
  await settle()
  expect(h.format).toHaveBeenLastCalledWith(0, 2, 0)
})

it('updates totals when removing a registry without creating replacement rows', async () => {
  const h = await setup()
  await h.query('com.example')
  expect(h.status.textContent).toBe('4/4')
  h.removeRegistry()
  await settle()
  expect(h.visible()).toHaveLength(2)
  expect(h.status.textContent).toBe('2/2')
  h.release()
  await settle()
})
