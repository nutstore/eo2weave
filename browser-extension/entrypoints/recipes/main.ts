import { listManagedPackages, setManagedPackageConfig, type ManagedWebMCPPackage } from '../webmcp/package-client'

function t(key: string, substitutions?: string | string[]): string {
  return chrome.i18n.getMessage(key as any, substitutions) || key
}
const errorDisplay = document.getElementById('pageError')!
function showError(error: unknown) { errorDisplay.textContent = error instanceof Error ? error.message : String(error) }
for (const [id, key] of [['pageTitle', 'webmcpPackagesTitle'], ['pageSubtitle', 'webmcpPackagesSubtitle'], ['pageNote', 'webmcpPackagesNote']])
  document.getElementById(id)!.textContent = t(key)

function buildCard(entry: ManagedWebMCPPackage): HTMLElement {
  const enabled = entry.activation === 'enabled'
  const card = document.createElement('div')
  card.className = 'card' + (enabled ? '' : ' disabled')
  const body = document.createElement('div')
  body.className = 'body'
  const name = document.createElement('div')
  name.className = 'name'
  name.textContent = entry.manifest?.id ?? entry.directory
  const host = document.createElement('div')
  host.className = 'host'
  host.textContent = `${t(entry.access === 'read-only' ? 'webmcpSourceBuiltin' : 'webmcpSourceUser')} · ${entry.manifest?.version ?? '—'}`
  const desc = document.createElement('div')
  desc.className = 'desc'
  desc.textContent = entry.manifest?.description ?? ''
  const path = document.createElement('div')
  path.className = 'source-path'
  path.textContent = entry.uri + 'config.json'
  body.append(name, host, desc, path)
  const tools = document.createElement('div')
  tools.className = 'tools'
  for (const tool of entry.manifest?.tools ?? []) {
    const chip = document.createElement('span')
    chip.className = 'tool-chip'
    chip.textContent = tool.name
    chip.title = `${tool.description}\n${entry.uri}${tool.path}`
    tools.append(chip)
  }
  body.append(tools)
  if (entry.diagnostics.length) {
    const diagnostic = document.createElement('div')
    diagnostic.className = 'diagnostic'
    diagnostic.textContent = `${t('webmcpPackageInvalid')}: ${entry.diagnostics.join('; ')}`
    body.append(diagnostic)
  }
  const toggle = document.createElement('input')
  toggle.type = 'checkbox'
  toggle.className = 'toggle'
  toggle.checked = enabled
  toggle.setAttribute('aria-label', `${t('webmcpPackageActivation')}: ${entry.directory}`)
  toggle.disabled = !enabled && (!entry.manifest || entry.diagnostics.some(error => !error.startsWith('config.json:')))
  toggle.addEventListener('change', async () => {
    toggle.disabled = true
    errorDisplay.textContent = ''
    try {
      await setManagedPackageConfig(entry, { activation: toggle.checked ? 'enabled' : 'disabled' })
      await render()
    } catch (error) {
      toggle.checked = enabled
      toggle.disabled = false
      showError(error)
    }
  })
  card.append(body, toggle)
  return card
}
let generation = 0
async function render(): Promise<void> {
  const current = ++generation
  const entries = await listManagedPackages()
  if (current !== generation) return
  const enabled = entries.filter(entry => entry.activation === 'enabled')
  const disabled = entries.filter(entry => entry.activation !== 'enabled')
  for (const [prefix, group, title, empty] of [
    ['installed', enabled, 'recipesInstalled', 'recipesEmptyInstalled'],
    ['available', disabled, 'recipesAvailable', 'recipesEmptyAvailable'],
  ] as const) {
    const list = document.getElementById(prefix + 'List')!
    list.replaceChildren()
    document.getElementById(prefix + 'Title')!.textContent = `${t(title)} (${group.length})`
    for (const entry of group) list.append(buildCard(entry))
    if (!group.length) {
      const placeholder = document.createElement('div')
      placeholder.className = 'empty'
      placeholder.textContent = t(empty)
      list.append(placeholder)
    }
  }
}
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'webmcp_packages_changed') void render().catch(showError)
})
window.addEventListener('focus', () => void render().catch(showError))
void render().catch(showError)
