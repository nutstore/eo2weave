/**
 * Mobile-friendly file selection and upload state.
 * Uses the File System Access API where available and an `<input type="file">`
 * fallback on iOS Safari and other browsers.
 */
import { useCallback, useRef, useState } from 'react'
import { formatBytes } from '@/lib/utils'

export interface FileSelectOptions {
  accept?: string
  multiple?: boolean
  maxFiles?: number
  maxSize?: number
}

export interface UploadFile {
  file: File
  id: string
  name: string
  size: number
  progress: number
  status: 'pending' | 'uploading' | 'completed' | 'error'
  error?: string
}

export interface UploadState {
  files: UploadFile[]
  isUploading: boolean
  totalProgress: number
  completedCount: number
  errorCount: number
}

export interface UseMobileUploadOptions {
  onProgress?: (fileId: string, progress: number) => void
  onFileComplete?: (fileId: string, success: boolean, error?: string) => void
  onUploadComplete?: (files: UploadFile[]) => void
}

export function formatFileSize(bytes: number): string {
  return formatBytes(bytes)
}

export function isFilePickerSupported(): boolean {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window
}

export function isIOSSafari(): boolean {
  if (typeof window === 'undefined') return false
  return /iPad|iPhone|iPod/.test(window.navigator.userAgent) && /Safari/.test(window.navigator.userAgent)
}

export function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(window.navigator.userAgent)
}

function fileId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function selectWithInput(options: FileSelectOptions): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = options.multiple ?? true
    if (options.accept) input.accept = options.accept
    input.style.display = 'none'
    document.body.appendChild(input)

    const finish = (files: File[]) => {
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => finish(input.files ? Array.from(input.files) : []), {
      once: true,
    })
    input.addEventListener('cancel', () => finish([]), { once: true })
    input.click()
  })
}

async function selectWithNativePicker(options: FileSelectOptions): Promise<File[]> {
  const picker = (window as Window & {
    showOpenFilePicker?: (options: { multiple: boolean }) => Promise<Array<{ getFile(): Promise<File> }>>
  }).showOpenFilePicker
  if (!picker) return selectWithInput(options)
  const handles = await picker({ multiple: options.multiple ?? true })
  return Promise.all(handles.map((handle) => handle.getFile()))
}

function summarize(files: UploadFile[]): Pick<UploadState, 'totalProgress' | 'completedCount' | 'errorCount'> {
  return {
    totalProgress: files.length
      ? files.reduce((total, file) => total + file.progress, 0) / files.length
      : 0,
    completedCount: files.filter((file) => file.status === 'completed').length,
    errorCount: files.filter((file) => file.status === 'error').length,
  }
}

export function useMobileUpload(options: UseMobileUploadOptions = {}) {
  const [state, setState] = useState<UploadState>({
    files: [],
    isUploading: false,
    totalProgress: 0,
    completedCount: 0,
    errorCount: 0,
  })
  const uploadFunction = useRef<((file: File) => Promise<void>) | null>(null)

  const setUploadFunction = useCallback((fn: (file: File) => Promise<void>) => {
    uploadFunction.current = fn
  }, [])

  const selectFiles = useCallback(async (fileOptions: FileSelectOptions = {}): Promise<File[]> => {
    let selected: File[]
    try {
      selected = isFilePickerSupported() && !isIOSSafari()
        ? await selectWithNativePicker(fileOptions)
        : await selectWithInput(fileOptions)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return []
      selected = await selectWithInput(fileOptions)
    }

    if (fileOptions.maxFiles && fileOptions.maxFiles > 0) {
      selected = selected.slice(0, fileOptions.maxFiles)
    }
    return selected.filter((file) => !fileOptions.maxSize || file.size <= fileOptions.maxSize)
  }, [])

  const updateFileProgress = useCallback((id: string, progress: number) => {
    const bounded = Math.max(0, Math.min(100, progress))
    setState((previous) => {
      const files = previous.files.map((file) => file.id === id ? { ...file, progress: bounded } : file)
      return { ...previous, files, ...summarize(files) }
    })
    options.onProgress?.(id, bounded)
  }, [options])

  const completeFile = useCallback((id: string, success: boolean, error?: string) => {
    setState((previous) => {
      const files = previous.files.map((file) => file.id === id
        ? { ...file, status: success ? 'completed' as const : 'error' as const, progress: success ? 100 : file.progress, error }
        : file)
      return { ...previous, files, ...summarize(files) }
    })
    options.onFileComplete?.(id, success, error)
  }, [options])

  const uploadFile = useCallback(async (file: File): Promise<UploadFile> => {
    const item: UploadFile = {
      file,
      id: fileId(),
      name: file.name,
      size: file.size,
      progress: 0,
      status: 'uploading',
    }
    setState((previous) => ({ ...previous, isUploading: true, files: [...previous.files, item] }))

    if (!uploadFunction.current) {
      const failed = { ...item, status: 'error' as const, error: 'No upload function configured' }
      completeFile(item.id, false, failed.error)
      return failed
    }

    try {
      await uploadFunction.current(file)
      completeFile(item.id, true)
      return { ...item, progress: 100, status: 'completed' }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed'
      completeFile(item.id, false, message)
      return { ...item, status: 'error', error: message }
    }
  }, [completeFile])

  const uploadFiles = useCallback(async (
    files: File[],
    uploadFn?: (file: File) => Promise<void>,
  ): Promise<UploadFile[]> => {
    if (uploadFn) uploadFunction.current = uploadFn
    const results: UploadFile[] = []
    for (const file of files) results.push(await uploadFile(file))
    setState((previous) => ({ ...previous, isUploading: false }))
    options.onUploadComplete?.(results)
    return results
  }, [options, uploadFile])

  const clearCompleted = useCallback(() => {
    setState((previous) => {
      const files = previous.files.filter((file) => file.status !== 'completed')
      return { ...previous, files, ...summarize(files) }
    })
  }, [])

  const clearAll = useCallback(() => setState({
    files: [], isUploading: false, totalProgress: 0, completedCount: 0, errorCount: 0,
  }), [])

  const removeFile = useCallback((id: string) => {
    setState((previous) => {
      const files = previous.files.filter((file) => file.id !== id)
      return { ...previous, files, ...summarize(files) }
    })
  }, [])

  const retryFile = useCallback(async (id: string) => {
    const failed = state.files.find((file) => file.id === id && file.status === 'error')
    if (!failed) return
    removeFile(id)
    await uploadFile(failed.file)
  }, [removeFile, state.files, uploadFile])

  return {
    ...state,
    selectFiles,
    uploadFile,
    uploadFiles,
    setUploadFunction,
    updateFileProgress,
    completeFile,
    clearCompleted,
    clearAll,
    removeFile,
    retryFile,
    isFilePickerSupported,
    isIOSSafari,
    isMobileDevice,
    formatFileSize,
  }
}
