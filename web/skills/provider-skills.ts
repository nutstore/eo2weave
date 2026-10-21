import { FsError, normalizeProviderPath } from '@creatorweave/fs-provider'
import { ProviderBackend } from '@/agent/tools/backends/provider-backend'
import { providerRegistry, type ProviderRegistry } from '@/vfs/provider-registry'
import { parseSkillMd } from './skill-parser'
import { RESOURCE_LIMITS, type Skill, type SkillResource } from './skill-types'

async function withLoadTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FsError('ENOTCONN', 'Skill provider timed out')), RESOURCE_LIMITS.LOAD_TIMEOUT)
    })])
  } finally { clearTimeout(timer) }
}

function backend(skill: Pick<Skill, 'providerLocation'>, registry: ProviderRegistry) {
  const location = skill.providerLocation
  if (!location || !registry.registrations().some(r => r.id === location.providerId && r.mountName === location.mountName)) {
    throw new FsError('ENOTCONN', 'Skill provider is unavailable')
  }
  return { fs: new ProviderBackend(location.mountName, registry), directory: location.directory }
}

export async function readProviderSkillFile(skill: Pick<Skill, 'providerLocation'>, relativePath: string, registry = providerRegistry): Promise<string> {
  const path = normalizeProviderPath(relativePath.trim().replace(/^\/+/, ''))
  if (!path) throw new FsError('EINVAL', 'Expected a skill file path')
  const { fs, directory } = backend(skill, registry)
  const fullPath = `${directory}/${path}`
  const result = await withLoadTimeout(fs.readFile(fullPath, { encoding: 'text' }))
  if (result.size > RESOURCE_LIMITS.MAX_FILE_SIZE) throw new FsError('EINVAL', 'Skill file is too large')
  return result.content as string
}

export async function listProviderSkillResources(skill: Skill, registry = providerRegistry): Promise<SkillResource[]> {
  const { fs, directory } = backend(skill, registry)
  const resources: SkillResource[] = []
  const walk = async (relative: string, depth: number) => {
    if (depth > 8) return
    for (const entry of await withLoadTimeout(fs.listDir(relative ? `${directory}/${relative}` : directory))) {
      if (resources.length >= RESOURCE_LIMITS.MAX_RESOURCES_PER_SKILL) return
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.kind === 'directory') await walk(path, depth + 1)
      else if (path !== 'SKILL.md') resources.push({
        id: `${skill.id}:${path}`, skillId: skill.id, resourcePath: path,
        resourceType: path.startsWith('scripts/') ? 'script' : path.startsWith('references/') ? 'reference' : 'asset',
        size: entry.size ?? 0, content: '', contentType: 'text/plain', createdAt: 0,
      })
    }
  }
  await walk('', 0)
  return resources
}

/** Only explicitly advertised roots participate in discovery. Contents stay provider-owned. */
export async function scanProviderSkills(registry = providerRegistry): Promise<Skill[]> {
  const skills: Skill[] = []
  const ids = new Set<string>()
  for (const registration of registry.registrations()) {
    for (const root of registration.skillRoots ?? []) {
      try {
        const fs = new ProviderBackend(registration.mountName, registry)
        for (const entry of await withLoadTimeout(fs.listDir(root))) {
          if (entry.kind !== 'directory') continue
          try {
            const location = { providerId: registration.id, mountName: registration.mountName, directory: entry.path }
            const stub = { providerLocation: location }
            const parsed = parseSkillMd(await readProviderSkillFile(stub, 'SKILL.md', registry), 'provider')
            if (!parsed.skill) continue
            const id = `provider:${encodeURIComponent(registration.id)}:${encodeURIComponent(entry.path)}`
            if (ids.has(id)) continue
            ids.add(id)
            skills.push({ ...parsed.skill, id, providerLocation: location })
          } catch (error) {
            console.warn('[Provider skills] Unable to read skill:', entry.path, error)
          }
        }
      } catch (error) {
        console.warn('[Provider skills] Provider unavailable:', registration.id, error)
      }
    }
  }
  return skills
}

/** Re-scan provider skills and push the result into the skills store when it changed. */
export async function refreshProviderSkillsIntoStore(): Promise<void> {
  try {
    const { getSkillManager } = await import('./skill-manager')
    const manager = getSkillManager()
    await manager.refreshProviderSkills()
    const { useSkillsStore } = await import('@/store/skills.store')
    const skills = manager.getSkillMetadata()
    if (JSON.stringify(skills) !== JSON.stringify(useSkillsStore.getState().skills)) {
      useSkillsStore.setState({ skills })
    }
  } catch (error) {
    console.warn('[Provider skills] Refresh failed:', error)
  }
}

/**
 * Event-driven refresh: registry changes, tab becoming visible, window focus.
 * No timers; agent entry points and the skills dialog also refresh on demand.
 */
export function startProviderSkillSync(): () => void {
  let stopped = false
  let running = false
  const refresh = async () => {
    if (stopped || running) return
    running = true
    try { await refreshProviderSkillsIntoStore() } finally { running = false }
  }
  const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
  const onFocus = () => { void refresh() }
  const unsubscribe = providerRegistry.subscribe(() => { void refresh() })
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onFocus)
  void refresh()
  return () => {
    stopped = true
    unsubscribe()
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('focus', onFocus)
  }
}
