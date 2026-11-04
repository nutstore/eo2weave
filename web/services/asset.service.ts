/**
 * Asset Service — writes user files to OPFS assets/ and returns AssetMeta[].
 *
 * Called by the conversation logic when a message is sent with pending uploads.
 */

import type { AssetMeta } from '@/types/asset'
import { inferMimeType } from '@/types/asset'
import { getActiveConversation } from '@/store/conversation-context.store'
import { getWorkspaceManager } from '@/opfs'

const uploadLocks = new Map<string, Promise<void>>()

async function withUploadLock<T>(id: string, task: (crossTabLocked: boolean) => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(`creatorweave-assets:${id}`, () => task(true))
  }
  const previous = uploadLocks.get(id) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => current)
  uploadLocks.set(id, queued)
  await previous
  try { return await task(false) } finally {
    release()
    if (uploadLocks.get(id) === queued) uploadLocks.delete(id)
  }
}

async function getAssetsDirectory(conversationId?: string) {
  if (conversationId) {
    const manager = await getWorkspaceManager()
    const workspace = await manager.getWorkspace(conversationId)
    if (!workspace) throw new Error('Conversation workspace is unavailable')
    return { id: conversationId, dir: await workspace.getAssetsDir() }
  }
  const active = await getActiveConversation()
  if (!active) throw new Error('No active conversation — cannot access files')
  return { id: active.conversationId ?? 'active', dir: await active.conversation.getAssetsDir() }
}

/**
 * Write pending files to the OPFS assets/ directory and return AssetMeta[].
 *
 * If a file with the same name already exists, appends a numeric suffix.
 * File data is read from the PendingAsset's File object.
 */
export async function writePendingAssetsToOPFS(
  files: Array<{ name: string; file: File }>,
  conversationId?: string,
): Promise<AssetMeta[]> {
  if (files.length === 0) return []

  const { id, dir: assetsDir } = await getAssetsDirectory(conversationId)
  return withUploadLock(id, async (crossTabLocked) => {
    const results: AssetMeta[] = []

    const createdNames: string[] = []
    try {
      for (const { name, file } of files) {
        // Resolve name collision: append -1, -2, etc.
        // Without Web Locks, use a random suffix so independent tabs do not
        // choose the same path during their non-atomic existence checks.
        const safeName = crossTabLocked ? name : addUniqueSuffix(name)
        const finalName = await resolveUniqueName(assetsDir, safeName)

        // Write file to OPFS
        const fileHandle = await assetsDir.getFileHandle(finalName, { create: true })
        createdNames.push(finalName)
        const writable = await fileHandle.createWritable()
        try {
          await writable.write(file)
        } finally {
          await writable.close()
        }

        results.push({
          id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: finalName,
          size: file.size,
          mimeType: file.type || inferMimeType(finalName),
          direction: 'upload',
          createdAt: Date.now(),
        })
      }

      return results
    } catch (error) {
      await Promise.all(createdNames.map(async (name) => {
        try { await assetsDir.removeEntry(name) } catch (cleanupError) {
          console.warn('[asset.service] Failed to remove incomplete upload:', name, cleanupError)
        }
      }))
      throw error
    }
  })
}

/** Remove assets that were written for an operation which did not complete. */
export async function removeAssetsFromOPFS(assets: AssetMeta[], conversationId?: string): Promise<void> {
  if (assets.length === 0) return

  let target: Awaited<ReturnType<typeof getAssetsDirectory>>
  try { target = await getAssetsDirectory(conversationId) } catch (error) {
    console.warn('[asset.service] Failed to locate assets for cleanup:', error)
    return
  }
  const { id, dir: assetsDir } = target
  await withUploadLock(id, async () => {
    await Promise.all(
      assets.map(async (asset) => {
        try {
          await assetsDir.removeEntry(asset.name)
        } catch {
          // Best effort: the asset may already have been removed externally.
        }
      })
    )
  })
}

function addUniqueSuffix(name: string): string {
  const dot = name.lastIndexOf('.')
  const suffix = globalThis.crypto.randomUUID()
  return dot > 0 ? `${name.slice(0, dot)}-${suffix}${name.slice(dot)}` : `${name}-${suffix}`
}

/**
 * Ensure the file name is unique within the assets directory.
 * Appends `-1`, `-2`, etc. before the extension if needed.
 */
async function resolveUniqueName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  const dotIdx = name.lastIndexOf('.')
  const base = dotIdx > 0 ? name.slice(0, dotIdx) : name
  const ext = dotIdx > 0 ? name.slice(dotIdx) : ''

  let candidate = name
  let counter = 1

  while (await existsInDir(dir, candidate)) {
    candidate = `${base}-${counter}${ext}`
    counter++
  }

  return candidate
}

async function existsInDir(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name)
    return true
  } catch {
    return false
  }
}
