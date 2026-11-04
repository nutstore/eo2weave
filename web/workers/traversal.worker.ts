/**
 * Traversal Worker - File directory traversal in a separate thread
 *
 * This worker handles recursive directory traversal without blocking the main thread.
 * FileSystemDirectoryHandle is transferred to the worker where all traversal happens.
 */

import { isGitIgnored, type GitIgnoreRule } from '@/opfs/native-disk/gitignore-policy'
import { readDirectoryIgnoreRules } from '@/vfs/gitignore-discovery'

//=============================================================================
// Type Definitions
//=============================================================================

interface FileMetadata {
  name: string
  size: number
  type: 'file' | 'directory'
  lastModified: number
  path: string
}

type WorkerMessage =
  | { type: 'TRAVERSE'; payload: { directoryHandle: FileSystemDirectoryHandle; basePath?: string } }
  | { type: 'ABORT' }

type WorkerResponse =
  | { type: 'RESULT'; payload: { items: FileMetadata[]; done: boolean; currentPath: string } }
  | { type: 'COMPLETE'; payload: { totalFiles: number; totalDirs: number } }
  | { type: 'ERROR'; payload: { error: string } }

//=============================================================================
// Default Excluded Directories (keep in sync with search.worker.ts)
//=============================================================================

const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
  '.turbo',
  '.pnpm-store',
])

//=============================================================================
// Worker State
//=============================================================================

let abortController = new AbortController()
let isProcessing = false

//=============================================================================
// Message Handler
//=============================================================================

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const message = event.data

  try {
    switch (message.type) {
      case 'TRAVERSE':
        await handleTraverse(message.payload)
        break
      case 'ABORT':
        handleAbort()
        break
      default:
        sendError({ error: `Unknown message type: ${(message as any).type}` })
    }
  } catch (error) {
    sendError({ error: String(error) })
  }
}

//=============================================================================
// Traversal Logic
//=============================================================================

/**
 * Handle traversal request - traverses directory tree entirely in worker
 */
async function handleTraverse(payload: {
  directoryHandle: FileSystemDirectoryHandle
  basePath?: string
}) {
  if (isProcessing) {
    sendError({ error: 'Already processing a traversal' })
    return
  }

  isProcessing = true
  abortController = new AbortController()
  const signal = abortController.signal

  try {
    const { directoryHandle, basePath = '' } = payload

    let fileCount = 0
    let dirCount = 0
    const BATCH_SIZE = 100
    const batch: FileMetadata[] = []

    // Recursive traversal function
    async function* traverseDir(
      dirHandle: FileSystemDirectoryHandle,
      path: string,
      inherited: GitIgnoreRule[] = [],
    ): AsyncGenerator<FileMetadata> {
      if (signal.aborted) return

      try {
        const rules = await readDirectoryIgnoreRules(dirHandle, path, inherited)
        for await (const entry of dirHandle.entries()) {
          if (signal.aborted) return

          const [, handle] = entry
          const entryPath = path ? `${path}/${handle.name}` : handle.name
          if (isGitIgnored(entryPath, rules, handle.kind)) continue

          if (handle.kind === 'file') {
            try {
              const file = await handle.getFile()
              yield {
                name: file.name,
                size: file.size,
                type: 'file',
                lastModified: file.lastModified,
                path: entryPath,
              }
            } catch (error) {
              // Skip inaccessible files
              console.warn(`Skipping ${entryPath}:`, error)
            }
          } else if (handle.kind === 'directory') {
            // Skip excluded directories (node_modules, .git, etc.)
            if (DEFAULT_EXCLUDED_DIRS.has(handle.name)) continue

            // Yield directory entry first
            yield {
              name: handle.name,
              size: 0,
              type: 'directory',
              lastModified: 0,
              path: entryPath,
            }
            // Then recursively traverse subdirectory
            yield* traverseDir(handle as FileSystemDirectoryHandle, entryPath, rules)
          }
        }
      } catch (error) {
        console.warn(`Error accessing directory:`, error)
      }
    }

    // Process traversal and send batches
    for await (const item of traverseDir(directoryHandle, basePath)) {
      if (signal.aborted) {
        sendResult({
          items: batch,
          done: true,
          currentPath: 'Aborted',
        })
        return
      }

      batch.push(item)

      if (item.type === 'file') {
        fileCount++
      } else {
        dirCount++
      }

      // Send batch results periodically
      if (batch.length >= BATCH_SIZE) {
        sendResult({
          items: [...batch],
          done: false,
          currentPath: item.path,
        })
        batch.length = 0

        // Yield control to allow processing abort messages
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }

    // Send remaining items
    if (batch.length > 0) {
      sendResult({
        items: batch,
        done: false,
        currentPath: 'Complete',
      })
    }

    // Send completion
    sendComplete({ totalFiles: fileCount, totalDirs: dirCount })
  } finally {
    isProcessing = false
  }
}

/**
 * Handle abort request
 */
function handleAbort() {
  abortController.abort()
  isProcessing = false
}

//=============================================================================
// Helper Functions
//=============================================================================

function sendResult(payload: { items: FileMetadata[]; done: boolean; currentPath: string }) {
  const response: WorkerResponse = {
    type: 'RESULT',
    payload,
  }
  self.postMessage(response)
}

function sendComplete(payload: { totalFiles: number; totalDirs: number }) {
  const response: WorkerResponse = {
    type: 'COMPLETE',
    payload,
  }
  self.postMessage(response)
}

function sendError(payload: { error: string }) {
  const response: WorkerResponse = {
    type: 'ERROR',
    payload,
  }
  self.postMessage(response)
}

// Export types for TypeScript
export type {}
