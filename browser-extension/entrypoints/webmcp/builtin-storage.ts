import { FsError, type FsProvider } from '@creatorweave/fs-provider'
import { parseWebMCPConfig, serializeWebMCPConfig, type WebMCPConfig } from '@creatorweave/shared/webmcp-config'
import { builtinResources } from './builtin-resources'
import { createResourceProvider } from './resource-provider'

export const BUILTIN_CONFIG_STORAGE_KEY = 'webmcp_builtin_package_configs'
const paths = Object.keys(builtinResources).sort()
const configs = new Set(paths.filter(path => path.endsWith('/config.json')))
const encoder = new TextEncoder()
let storage: FsProvider | undefined
let updates: Promise<unknown> = Promise.resolve()

async function readOverrides(): Promise<Record<string, unknown>> {
  const stored = await chrome.storage.local.get(BUILTIN_CONFIG_STORAGE_KEY)
  return stored[BUILTIN_CONFIG_STORAGE_KEY] ?? {}
}

/**
 * Stored activation for one builtin package (`null` = default/no override).
 * Used by the opt-in handler to verify that the enable write actually stuck
 * (a concurrent disable must win over an in-flight opt-in enable).
 */
export async function readBuiltinConfig(directory: string): Promise<WebMCPConfig | null> {
  const path = `${directory}/config.json`
  if (!configs.has(path)) return null
  const overrides = await readOverrides()
  if (!Object.prototype.hasOwnProperty.call(overrides, path)) return null
  return parseWebMCPConfig(overrides[path])
}

/** Configuration is a persistent overlay; both reads expose the same package tree. */
export function getBuiltinStorage(): Promise<FsProvider> {
  storage ??= createResourceProvider(paths, async path => {
    if (configs.has(path)) {
      const overrides = await readOverrides()
      if (Object.prototype.hasOwnProperty.call(overrides, path)) return encoder.encode(JSON.stringify(overrides[path], null, 2) + '\n')
    }
    return encoder.encode(builtinResources[path])
  })
  return Promise.resolve(storage)
}

/** Internal management API only; the mounted filesystem always remains read-only. */
export function setBuiltinConfig(directory: string, config: WebMCPConfig): Promise<void> {
  const path = `${directory}/config.json`
  if (!configs.has(path)) return Promise.reject(new FsError('ENOENT', path))
  const parsed = parseWebMCPConfig(JSON.parse(serializeWebMCPConfig(config)))
  const pending = updates.catch(() => {}).then(async () => {
    await chrome.storage.local.set({ [BUILTIN_CONFIG_STORAGE_KEY]: { ...await readOverrides(), [path]: parsed } })
  })
  updates = pending
  return pending
}
