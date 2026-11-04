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
const pendingCleanup = new Map<string, Set<string>>()
const LOCK_WAIT_MS = 15_000

function queueCleanup(id: string, names: string[]) {
  const pending = pendingCleanup.get(id) ?? new Set<string>()
  for (const name of names) pending.add(name)
  pendingCleanup.set(id, pending)
}

async function retryPendingCleanup(id: string, dir: FileSystemDirectoryHandle) {
  const pending = pendingCleanup.get(id)
  if (!pending) return
  for (const name of pending) {
    if (await removeEntryWithRetry(dir, name)) pending.delete(name)
  }
  if (pending.size === 0) pendingCleanup.delete(id)
}

async function withUploadLock<T>(id: string, task: (crossTabLocked: boolean) => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LOCK_WAIT_MS)
    try {
      return await navigator.locks.request(`creatorweave-assets:${id}`, { signal: controller.signal }, () => {
        clearTimeout(timer)
        return task(true)
      })
    } finally {
      clearTimeout(timer)
    }
  }
  const previous = uploadLocks.get(id) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.then(() => current)
  uploadLocks.set(id, queued)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([previous, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for asset upload lock')), LOCK_WAIT_MS) })])
  } catch (error) {
    release()
    // Keep the prior holder in the chain until it really releases the lock.
    void queued.then(() => { if (uploadLocks.get(id) === queued) uploadLocks.delete(id) })
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
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
    await retryPendingCleanup(id, assetsDir)
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
        if (!(await removeEntryWithRetry(assetsDir, name))) queueCleanup(id, [name])
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
    if (conversationId) queueCleanup(conversationId, assets.map((asset) => asset.name))
    console.warn('[asset.service] Failed to locate assets for cleanup:', error)
    return
  }
  const { id, dir: assetsDir } = target
  try {
    await withUploadLock(id, async () => {
      await Promise.all(
        assets.map(async (asset) => {
          if (!(await removeEntryWithRetry(assetsDir, asset.name))) queueCleanup(id, [asset.name])
        })
      )
    })
  } catch (error) {
    queueCleanup(id, assets.map((asset) => asset.name))
    console.warn('[asset.service] Failed to acquire asset cleanup lock:', error)
  }
}

async function removeEntryWithRetry(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.removeEntry(name)
    return true
  } catch (error) {
    if (error instanceof Error && error.name === 'NotFoundError') return true
    try {
      await dir.removeEntry(name)
      return true
    } catch (retryError) {
      if (retryError instanceof Error && retryError.name === 'NotFoundError') return true
      console.warn('[asset.service] Failed to remove incomplete upload after retry:', name, retryError)
      return false
    }
  }
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
