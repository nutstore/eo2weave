/**
 * Registry background handler (issue #143).
 *
 * The background owns the registry operations; the management page drives
 * them through runtime messages. The handler must:
 *   - resolve a registry from the STORED list (never from the payload);
 *   - report a failure as `{ ok: false, error }` instead of throwing;
 *   - notify the extension pages after a mutation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, unknown>()
const notifications: string[] = []

;(globalThis as { chrome?: unknown }).chrome = {
  storage: {
    local: {
      async get(key: string | string[]) {
        const keys = Array.isArray(key) ? key : [key]
        const result: Record<string, unknown> = {}
        for (const name of keys) if (store.has(name)) result[name] = store.get(name)
        return result
      },
      async set(items: Record<string, unknown>) {
        for (const [name, value] of Object.entries(items)) store.set(name, value)
      },
      async remove(key: string) {
        store.delete(key)
      },
    },
  },
  runtime: {
    sendMessage: async (message: { type?: string }) => {
      notifications.push(message.type ?? '')
      return undefined
    },
  },
}

// The registry list handler reads the installed-package ids from the OPFS
// adapter mount (navigator.storage.getDirectory). The fail-closed behaviour
// (a listing failure throws instead of reading as "nothing installed")
// means the handler needs a mount to list — an EMPTY in-memory one.
Object.defineProperty(globalThis, 'navigator', {
  value: {
    storage: {
      getDirectory: async () => {
        const walk = (path: string[]): FileSystemDirectoryHandle => {
          const children = new Map<string, FileSystemDirectoryHandle>()
          const handle = {
            kind: 'directory' as const,
            name: path.at(-1) ?? '',
            async getDirectoryHandle(name: string) {
              let child = children.get(name)
              if (!child) { child = walk([...path, name]); children.set(name, child) }
              return child
            },
            async getFileHandle(name: string) {
              const key = [...path, name].join('/')
              throw Object.assign(new Error(`${key} not found`), { name: 'NotFoundError' })
            },
            async * entries() {
              for (const name of children.keys()) yield [name, children.get(name)!]
            },
          }
          return handle as unknown as FileSystemDirectoryHandle
        }
        return walk([])
      },
    },
  },
})

const { createRegistryBackground } = await import('../registry-background')

function handler(changed = vi.fn(async () => {})) {
  const notify = vi.fn()
  const handle = createRegistryBackground({ changed, notify })
  return { handle, changed, notify }
}

describe('createRegistryBackground', () => {
  beforeEach(() => {
    store.clear()
    notifications.length = 0
  })

  it('adds a registry and persists it', async () => {
    const { handle } = handler()
    const response = await handle({ type: 'webmcp_registry_add', input: 'nutstore/eo2weave-webmcp-packages' })
    expect(response.ok).toBe(true)
    expect((response.registry as { label: string }).label).toBe('nutstore/eo2weave-webmcp-packages')

    const list = await handle({ type: 'webmcp_registry_list' })
    expect((list.registries as unknown[]).length).toBe(1)
  })

  it('rejects an invalid registry URL with a readable error', async () => {
    const { handle } = handler()
    const response = await handle({ type: 'webmcp_registry_add', input: 'not a url at all' })
    expect(response.ok).toBe(false)
    expect(String(response.error)).toMatch(/registry URL|Unsupported/i)
  })

  it('refuses to act on a registry it does not know', async () => {
    const { handle } = handler()
    const response = await handle({ type: 'webmcp_registry_catalog', manifestUrl: 'https://raw.githubusercontent.com/x/y/main/manifest.json' })
    expect(response.ok).toBe(false)
    expect(String(response.error)).toMatch(/Unknown registry/)
  })

  it('notifies the pages after a mutation', async () => {
    const { handle, notify } = handler()
    await handle({ type: 'webmcp_registry_add', input: 'nutstore/eo2weave-webmcp-packages' })
    expect(notify).toHaveBeenCalled()
  })

  it('reports an unknown operation as a failure (never throws)', async () => {
    const { handle } = handler()
    const response = await handle({ type: 'webmcp_registry_nonsense' })
    expect(response.ok).toBe(false)
    expect(String(response.error)).toMatch(/Unknown registry operation/)
  })

  it('removes a registry from the list', async () => {
    const { handle } = handler()
    await handle({ type: 'webmcp_registry_add', input: 'nutstore/eo2weave-webmcp-packages' })
    const list = await handle({ type: 'webmcp_registry_list' })
    const manifestUrl = (list.registries as Array<{ manifestUrl: string }>)[0]!.manifestUrl
    await handle({ type: 'webmcp_registry_remove', manifestUrl })
    const after = await handle({ type: 'webmcp_registry_list' })
    expect((after.registries as unknown[]).length).toBe(0)
  })
})
