/**
 * DropZone - File Drag and Drop Upload Area
 *
 * Supports dragging and dropping files and folders, automatically identifies file types
 * and provides appropriate operation suggestions.
 */

import { useState, useCallback, useRef } from 'react'
import {
  Upload,
  File,
  Folder,
  X,
  Check,
  AlertCircle,
  FileText,
  Image,
  Code,
  Table,
  Archive,
} from 'lucide-react'
import { useAgentStore } from '@/store/agent.store'
import { selectFolderReadWrite } from '@/services/fsAccess.service'

//=============================================================================
// Types
//=============================================================================

interface DropZoneProps {
  onFilesDrop?: (files: File[]) => void
  onPrompt?: (prompt: string) => void
  className?: string
  minimal?: boolean
}

interface DroppedItem {
  id: string
  name: string
  type: 'file' | 'folder'
  size: number
  fileType?: string
  icon: React.ElementType
}

//=============================================================================
// File Type Detection
//=============================================================================

function getFileTypeIcon(filename: string): React.ElementType {
  const ext = filename.toLowerCase().split('.').pop()

  const iconMap: Record<string, React.ElementType> = {
    // Images
    png: Image,
    jpg: Image,
    jpeg: Image,
    gif: Image,
    svg: Image,
    webp: Image,
    ico: Image,

    // Code
    ts: Code,
    tsx: Code,
    js: Code,
    jsx: Code,
    py: Code,
    go: Code,
    rs: Code,
    java: Code,
    cpp: Code,
    c: Code,
    cs: Code,
    php: Code,
    rb: Code,
    swift: Code,
    kt: Code,
    scala: Code,

    // Data
    csv: Table,
    xlsx: Table,
    xls: Table,
    json: FileText,
    xml: FileText,
    yaml: FileText,
    yml: FileText,
    toml: FileText,

    // Archives
    zip: Archive,
    tar: Archive,
    gz: Archive,
    rar: Archive,
    '7z': Archive,

    // Documents
    md: FileText,
    txt: FileText,
    pdf: FileText,
    doc: FileText,
    docx: FileText,
  }

  return iconMap[ext || ''] || File
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'

  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

//=============================================================================
// Component
//=============================================================================

export function DropZone({ onFilesDrop, onPrompt, className, minimal }: DropZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false)
  const [droppedItems, setDroppedItems] = useState<DroppedItem[]>([])
  const [error, setError] = useState<string | null>(null)

  const setDirectoryHandle = useAgentStore((s) => s.setDirectoryHandle)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
    setError(null)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)

      const items = e.dataTransfer.items
      if (!items || items.length === 0) return

      const newItems: DroppedItem[] = []

      for (let i = 0; i < items.length; i++) {
        const item = items[i]

        if (item.kind === 'file') {
          const file = item.getAsFile()
          if (file) {
            newItems.push({
              id: `${file.name}-${Date.now()}-${i}`,
              name: file.name,
              type: 'file',
              size: file.size,
              fileType: file.name.split('.').pop(),
              icon: getFileTypeIcon(file.name),
            })
          }
        }
      }

      if (newItems.length > 0) {
        setDroppedItems((prev) => [...prev, ...newItems])
        // Create File-like objects for the dropped items
        onFilesDrop?.(newItems.map((item) => ({ name: item.name, size: item.size }) as File))
      }
    },
    [onFilesDrop]
  )

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return

      const newItems: DroppedItem[] = []

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        newItems.push({
          id: `${file.name}-${Date.now()}-${i}`,
          name: file.name,
          type: 'file',
          size: file.size,
          fileType: file.name.split('.').pop(),
          icon: getFileTypeIcon(file.name),
        })
      }

      if (newItems.length > 0) {
        setDroppedItems((prev) => [...prev, ...newItems])
        // Create File-like objects for the dropped items
        onFilesDrop?.(newItems.map((item) => ({ name: item.name, size: item.size }) as File))
      }

      // Reset input
      if (inputRef.current) {
        inputRef.current.value = ''
      }
    },
    [onFilesDrop]
  )

  const handleRemoveItem = useCallback((id: string) => {
    setDroppedItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const handleClear = useCallback(() => {
    setDroppedItems([])
    setError(null)
  }, [])

  const handleAnalyze = useCallback(() => {
    if (droppedItems.length === 0) return

    // Generate a prompt based on the dropped files
    const fileNames = droppedItems.map((item) => item.name).join(', ')

    // Detect file types and generate appropriate prompt
    const hasCode = droppedItems.some((item) =>
      ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs'].includes(item.fileType || '')
    )
    const hasData = droppedItems.some((item) =>
      ['csv', 'json', 'xlsx', 'xls'].includes(item.fileType || '')
    )
    const hasImages = droppedItems.some((item) =>
      ['png', 'jpg', 'jpeg', 'svg', 'gif'].includes(item.fileType || '')
    )

    let prompt = `I've uploaded these files: ${fileNames}.`

    if (hasCode) {
      prompt += ' Please analyze the code structure and explain how it works.'
    } else if (hasData) {
      prompt += ' Please analyze the data and provide insights.'
    } else if (hasImages) {
      prompt += ' Please describe what you see in these images.'
    } else {
      prompt += ' Please help me understand the contents.'
    }

    onPrompt?.(prompt)
    setDroppedItems([])
  }, [droppedItems, onPrompt])

  const handleSelectFolder = async () => {
    try {
      const handle = await selectFolderReadWrite()
      if (!handle) return
      setDirectoryHandle(handle)
    } catch (error) {
      if (error instanceof Error && error.message === 'User cancelled') return
      setError(error instanceof Error ? error.message : 'Failed to select folder')
    }
  }

  if (minimal) {
    return (
      <div
        className={`relative flex items-center justify-center rounded-xl border-2 border-dashed transition-colors ${
          isDragOver
            ? 'border-primary-500 bg-primary-50'
            : 'border-border dark:border-border bg-muted dark:bg-muted hover:border-border'
        } ${className || ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input ref={inputRef} type="file" multiple onChange={handleFileSelect} className="hidden" />
        <div className="p-4 text-center">
          <Upload className="mx-auto mb-2 h-6 w-6 text-tertiary dark:text-muted" />
          <p className="text-sm text-secondary dark:text-muted">
            {isDragOver ? 'Drop files here' : 'Drag files or click to upload'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={className || ''}>
      {/* Drop Zone */}
      <div
        className={`relative rounded-xl border-2 border-dashed transition-all ${
          isDragOver
            ? 'scale-[1.02] border-primary-500 bg-primary-50'
            : 'border-border dark:border-border bg-muted dark:bg-muted hover:border-border'
        } ${droppedItems.length > 0 ? 'p-4' : 'p-8'}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input ref={inputRef} type="file" multiple onChange={handleFileSelect} className="hidden" />

        {droppedItems.length === 0 ? (
          // Empty state
          <div className="text-center">
            <div
              className={`mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full ${
                isDragOver ? 'bg-primary-100' : 'bg-muted dark:bg-muted'
              } transition-colors`}
            >
              <Upload
                className={`h-6 w-6 ${isDragOver ? 'text-primary-600' : 'text-tertiary dark:text-muted'}`}
              />
            </div>
            <p className="text-sm font-medium text-secondary dark:text-foreground">
              {isDragOver ? 'Drop files here' : 'Drag files or click to upload'}
            </p>
            <p className="mt-1 text-xs text-tertiary dark:text-muted">Supports code, data, and document files</p>
            <div className="mt-4 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700"
              >
                Select Files
              </button>
              <button
                type="button"
                onClick={handleSelectFolder}
                className="flex items-center gap-2 rounded-lg border border-border dark:border-border bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-muted dark:bg-muted dark:border-border dark:bg-card dark:text-muted dark:hover:bg-muted"
              >
                <Folder className="h-4 w-4" />
                Select Folder
              </button>
            </div>
          </div>
        ) : (
          // Has items
          <div>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-secondary dark:text-foreground">
                {droppedItems.length} file{droppedItems.length > 1 ? 's' : ''} selected
              </p>
              <button
                onClick={handleClear}
                className="rounded-lg p-1 text-tertiary dark:text-muted transition-colors hover:bg-muted dark:bg-muted hover:text-secondary dark:text-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-2">
              {droppedItems.map((item) => {
                const Icon = item.icon
                return (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 rounded-lg bg-white p-3 shadow-sm dark:bg-card"
                  >
                    <div className="rounded-lg bg-muted dark:bg-muted p-2">
                      <Icon className="h-4 w-4 text-secondary dark:text-muted" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-secondary dark:text-foreground">{item.name}</p>
                      <p className="text-xs text-tertiary dark:text-muted">{formatFileSize(item.size)}</p>
                    </div>
                    <button
                      onClick={() => handleRemoveItem(item.id)}
                      className="rounded-lg p-1 text-tertiary dark:text-muted transition-colors hover:bg-muted dark:bg-muted hover:text-secondary dark:text-muted"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )
              })}
            </div>
            <button
              onClick={handleAnalyze}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-700"
            >
              <Check className="h-4 w-4" />
              Analyze Files
            </button>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 p-3">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}
    </div>
  )
}

//=============================================================================
// Compact Drop Zone (for inline use)
//=============================================================================

interface CompactDropZoneProps {
  onFilesDrop?: (files: File[]) => void
  onPrompt?: (prompt: string) => void
}

export function CompactDropZone({ onFilesDrop, onPrompt }: CompactDropZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false)
  const [hasDropped, setHasDropped] = useState(false)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)
      setHasDropped(true)

      const items = e.dataTransfer.items
      if (!items || items.length === 0) return

      const files: File[] = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.kind === 'file') {
          const file = item.getAsFile()
          if (file) files.push(file)
        }
      }

      if (files.length > 0) {
        onFilesDrop?.(files)
        const fileNames = files.map((f) => f.name).join(', ')
        onPrompt?.(`I've uploaded these files: ${fileNames}. Please analyze them.`)
      }

      setTimeout(() => setHasDropped(false), 2000)
    },
    [onFilesDrop, onPrompt]
  )

  return (
    <div
      className={`flex h-full items-center justify-center rounded-lg border-2 border-dashed transition-all ${
        isDragOver
          ? 'border-primary-500 bg-primary-50'
          : hasDropped
            ? 'border-green-500 bg-green-50'
            : 'border-border dark:border-border bg-muted dark:bg-muted'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Upload
        className={`h-5 w-5 ${
          isDragOver ? 'text-primary-600' : hasDropped ? 'text-green-600' : 'text-tertiary dark:text-muted'
        }`}
      />
    </div>
  )
}
