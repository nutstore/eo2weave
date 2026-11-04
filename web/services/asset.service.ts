/**
 * Asset Service — writes user files to OPFS assets/ and returns AssetMeta[].
 *
 * Called by the conversation logic when a message is sent with pending uploads.
 */

import type { AssetMeta } from '@/types/asset'
import { inferMimeType } from '@/types/asset'
import { getActiveConversation } from '@/store/conversation-context.store'

/**
 * Write pending files to the OPFS assets/ directory and return AssetMeta[].
 *
 * If a file with the same name already exists, appends a numeric suffix.
 * File data is read from the PendingAsset's File object.
 */
export async function writePendingAssetsToOPFS(
  files: Array<{ name: string; file: File }>
): Promise<AssetMeta[]> {
  if (files.length === 0) return []

  const active = await getActiveConversation()
  if (!active) {
    throw new Error('No active conversation — cannot upload files')
  }

  const assetsDir = await active.conversation.getAssetsDir()
  const results: AssetMeta[] = []

  const createdNames: string[] = []
  try {
    for (const { name, file } of files) {
      // Resolve name collision: append -1, -2, etc.
      const finalName = await resolveUniqueName(assetsDir, name)

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
}

/** Remove assets that were written for an operation which did not complete. */
export async function removeAssetsFromOPFS(assets: AssetMeta[]): Promise<void> {
  if (assets.length === 0) return

  const active = await getActiveConversation()
  if (!active) return

  const assetsDir = await active.conversation.getAssetsDir()
  await Promise.all(
    assets.map(async (asset) => {
      try {
        await assetsDir.removeEntry(asset.name)
      } catch {
        // Best effort: the asset may already have been removed externally.
      }
    })
  )
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
