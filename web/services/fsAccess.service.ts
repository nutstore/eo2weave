/**
 * Check if File System Access API is supported
 * @returns true if supported, false otherwise
 */
export function isSupported(): boolean {
  return 'showDirectoryPicker' in window
}

/**
 * Select a folder with readwrite permission for Agent file operations.
 * @returns FileSystemDirectoryHandle with write access
 */
export async function selectFolderReadWrite(): Promise<FileSystemDirectoryHandle | null> {
  if (!isSupported()) {
    throw new Error('File System Access API is not supported')
  }

  try {
    const handle = await (
      window.showDirectoryPicker as (options?: {
        mode?: 'read' | 'readwrite'
        id?: string
        startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
      }) => Promise<FileSystemDirectoryHandle>
    )({
      mode: 'readwrite',
    })
    return handle
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('User cancelled')
    }
    throw error
  }
}

/**
 * Resolve a file path to a FileSystemFileHandle from a root directory.
 * @param dirHandle Root directory handle
 * @param filePath Relative file path (e.g. "src/index.ts")
 */
export async function resolveFileHandle(
  dirHandle: FileSystemDirectoryHandle,
  filePath: string
): Promise<FileSystemFileHandle> {
  const parts = filePath.split('/').filter(Boolean)
  const fileName = parts.pop()
  if (!fileName) throw new Error(`Invalid file path: ${filePath}`)

  let current = dirHandle
  for (const part of parts) {
    current = await current.getDirectoryHandle(part)
  }
  return current.getFileHandle(fileName)
}

/**
 * Resolve a directory path to a FileSystemDirectoryHandle.
 * @param dirHandle Root directory handle
 * @param dirPath Relative directory path (e.g. "src/components")
 */
export async function resolveDirectoryHandle(
  dirHandle: FileSystemDirectoryHandle,
  dirPath: string
): Promise<FileSystemDirectoryHandle> {
  if (!dirPath || dirPath === '.' || dirPath === '/') return dirHandle
  const parts = dirPath.split('/').filter(Boolean)
  let current = dirHandle
  for (const part of parts) {
    current = await current.getDirectoryHandle(part)
  }
  return current
}

/**
 * Create a file and all necessary parent directories.
 * @param dirHandle Root directory handle
 * @param filePath Relative file path
 * @returns FileSystemFileHandle for the created file
 */
export async function createFileWithDirs(
  dirHandle: FileSystemDirectoryHandle,
  filePath: string
): Promise<FileSystemFileHandle> {
  const parts = filePath.split('/').filter(Boolean)
  const fileName = parts.pop()
  if (!fileName) throw new Error(`Invalid file path: ${filePath}`)

  let current = dirHandle
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create: true })
  }
  return current.getFileHandle(fileName, { create: true })
}
