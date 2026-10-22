import { afterEach, expect, it, vi } from 'vitest'
import { deleteManagedPackage, listManagedPackages, setManagedPackageConfig } from '../../../browser-extension/entrypoints/webmcp/package-client'
import { manifest } from './fixtures'
vi.mock('../../../browser-extension/entrypoints/webmcp/package-client', () => ({ deleteManagedPackage: vi.fn(), listManagedPackages: vi.fn(), setManagedPackageConfig: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })
it('renders both mounts and invalid packages, persists toggles and reacts to external config edits', async () => {
  const listen = vi.fn()
  vi.stubGlobal('chrome', { i18n: { getMessage: (key: string) => key }, runtime: { onMessage: { addListener: listen } } })
  document.body.innerHTML = '<h1 id="pageTitle"></h1><div id="pageSubtitle"></div><div id="pageNote"></div><div id="pageError"></div><h2 id="installedTitle"></h2><div id="installedList"></div><h2 id="availableTitle"></h2><div id="availableList"></div>'
  const entry = { directory: manifest.id, mount: 'webmcp', uri: `vfs://external/webmcp/${manifest.id}/`, access: 'read-write' as const, config: {}, activation: 'disabled' as const, diagnostics: [], manifest }
  const builtin = { ...entry, directory: 'com.example.builtin', mount: 'builtin-webmcp', uri: 'vfs://external/builtin-webmcp/com.example.builtin/', access: 'read-only' as const }
  const broken = { ...entry, directory: 'broken', manifest: null, diagnostics: ['Missing source'] }
  vi.mocked(listManagedPackages).mockResolvedValue([entry, builtin, broken])
  await import('../../../browser-extension/entrypoints/recipes/main')
  await vi.waitFor(() => expect(document.querySelectorAll('.card')).toHaveLength(3))
  expect(document.querySelectorAll<HTMLInputElement>('.toggle')[2].disabled).toBe(true)
  expect(document.body.textContent).toContain('builtin-webmcp')
  expect(document.body.textContent).toContain('Missing source')
  const toggle = document.querySelector<HTMLInputElement>('.toggle')!
  toggle.checked = true
  toggle.dispatchEvent(new Event('change'))
  await vi.waitFor(() => expect(setManagedPackageConfig).toHaveBeenCalledWith(entry, { activation: 'enabled' }))
  vi.mocked(listManagedPackages).mockResolvedValue([{ ...entry, activation: 'enabled', config: { activation: 'enabled' } }, builtin, broken])
  listen.mock.calls[0][0]({ type: 'webmcp_packages_changed' })
  await vi.waitFor(() => expect(document.querySelectorAll('#installedList .card')).toHaveLength(1))
  expect(document.querySelector<HTMLInputElement>('#installedList .toggle')!.checked).toBe(true)
  vi.mocked(setManagedPackageConfig).mockRejectedValueOnce(new Error('Storage unavailable'))
  const active = document.querySelector<HTMLInputElement>('#installedList .toggle')!
  active.checked = false
  active.dispatchEvent(new Event('change'))
  await vi.waitFor(() => expect(document.getElementById('pageError')!.textContent).toBe('Storage unavailable'))
  expect(active.checked).toBe(true)
  expect(document.querySelectorAll('.delete-package')).toHaveLength(2)
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const remove = document.querySelector<HTMLButtonElement>('#installedList .delete-package')!
  remove.click()
  expect(confirm).toHaveBeenCalled()
  expect(deleteManagedPackage).not.toHaveBeenCalled()
  confirm.mockReturnValue(true)
  vi.mocked(deleteManagedPackage).mockRejectedValueOnce(new Error('Deletion failed'))
  remove.click()
  await vi.waitFor(() => expect(document.getElementById('pageError')!.textContent).toBe('Deletion failed'))
  expect(remove.disabled).toBe(false)
  vi.mocked(listManagedPackages).mockResolvedValue([builtin, broken])
  remove.click()
  await vi.waitFor(() => expect(document.querySelectorAll('.card')).toHaveLength(2))
  expect(deleteManagedPackage).toHaveBeenCalledWith(expect.objectContaining({ directory: entry.directory }))
  confirm.mockRestore()
})
