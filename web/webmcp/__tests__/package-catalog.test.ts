import { describe, expect, it } from 'vitest'
import { memoryProvider } from '@creatorweave/fs-provider/memory'
import { parseWebMCPConfig, resolveWebMCPConfig } from '@creatorweave/shared/webmcp-config'
import { readMountedWebMCPCatalog, activeWebMCPPackages } from '@creatorweave/shared/webmcp-package-catalog'
import { providerMount } from '../../../browser-extension/entrypoints/webmcp/package-repository'
import { createResourceProvider } from '../../../browser-extension/entrypoints/webmcp/resource-provider'
import { manifest, source } from './fixtures'
const encode = (value: string) => new TextEncoder().encode(value)
const fixture = (config?: string) => ({
  [`${manifest.id}/manifest.json`]: JSON.stringify(manifest),
  [`${manifest.id}/read-title.js`]: source,
  ...(config === undefined ? {} : { [`${manifest.id}/config.json`]: config }),
})
async function user(files: Record<string, string>) {
  const provider = memoryProvider()
  for (const [path, value] of Object.entries(files)) await provider.writeFile(path, encode(value))
  return provider
}
describe('one parser for mounted WebMCP packages', () => {
  it('parses identical package trees from read-only resources and writable storage', async () => {
    const files = fixture('{"activation":"enabled"}')
    const builtin = createResourceProvider(Object.keys(files), async path => encode(files[path]))
    for (const [name, provider] of [['builtin-webmcp', builtin], ['webmcp', await user(files)]] as const) {
      const entries = await readMountedWebMCPCatalog([providerMount(name, provider)])
      expect(entries[0]).toMatchObject({ activation: 'enabled', diagnostics: [], uri: `vfs://external/${name}/${manifest.id}/` })
      expect(activeWebMCPPackages(entries)).toHaveLength(1)
    }
  })
  it('defaults missing config and missing optional activation to disabled', async () => {
    for (const config of [undefined, '{}']) {
      const entries = await readMountedWebMCPCatalog([providerMount('webmcp', await user(fixture(config)))])
      expect(entries[0]).toMatchObject({ activation: 'disabled', config: {}, diagnostics: [] })
      expect(activeWebMCPPackages(entries)).toEqual([])
    }
  })
  it.each(['{"activation":true}', '{"activation":"automatic"}', '{"activation":null}', '[]', '{', '{"unknown":"enabled"}'])('withdraws invalid config %s while retaining diagnostics', async config => {
    const entries = await readMountedWebMCPCatalog([providerMount('webmcp', await user(fixture(config)))])
    expect(entries[0].activation).toBeNull()
    expect(entries[0].diagnostics[0]).toContain('config.json')
    expect(activeWebMCPPackages(entries)).toEqual([])
  })
  it('does not shadow a package from another mount', async () => {
    const files = fixture('{"activation":"enabled"}')
    const entries = await readMountedWebMCPCatalog([
      providerMount('builtin-webmcp', createResourceProvider(Object.keys(files), async path => encode(files[path]))),
      providerMount('webmcp', await user(files)),
    ])
    expect(entries.every(entry => entry.diagnostics.some(error => error.includes('Duplicate package')))).toBe(true)
    expect(activeWebMCPPackages(entries)).toEqual([])
  })
  it('isolates broken packages and picks up config edits and deletion', async () => {
    const provider = await user(fixture('{"activation":"enabled"}'))
    await provider.writeFile('broken/config.json', encode('{"activation":"enabled"}'))
    const mount = providerMount('webmcp', provider)
    expect(activeWebMCPPackages(await readMountedWebMCPCatalog([mount]))).toHaveLength(1)
    await provider.writeFile(`${manifest.id}/config.json`, encode('{"activation":"disabled"}'))
    expect(activeWebMCPPackages(await readMountedWebMCPCatalog([mount]))).toEqual([])
    await provider.remove(`${manifest.id}/config.json`)
    expect((await readMountedWebMCPCatalog([mount])).find(entry => entry.directory === manifest.id)?.activation).toBe('disabled')
  })
  it('validates enum configuration and leaves optional fields absent', () => {
    expect(parseWebMCPConfig({})).toEqual({})
    expect(resolveWebMCPConfig({})).toEqual({ activation: 'disabled' })
  })
})

it('normalizes OPFS missing-file errors before applying config defaults', async () => {
  const provider = await user(fixture())
  const originalRead = provider.readFile.bind(provider)
  provider.readFile = async path => {
    if (path.endsWith('/config.json')) throw new DOMException('File does not exist', 'NotFoundError')
    return originalRead(path)
  }
  const entries = await readMountedWebMCPCatalog([providerMount('webmcp', provider)])
  expect(entries[0]).toMatchObject({ activation: 'disabled', config: {}, diagnostics: [] })
})
