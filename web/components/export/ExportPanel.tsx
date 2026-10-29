/* eslint-disable react-refresh/only-export-components */
/**
 * ExportPanel - Data export interface component
 *
 * Provides UI for exporting data in various formats.
 */

import { useState, useCallback } from 'react'
import {
  X,
  Download,
  FileText,
  FileJson,
  FileSpreadsheet,
  Image,
  Check,
  AlertCircle,
  Clock,
} from 'lucide-react'
import {
  BrandButton,
} from '@creatorweave/ui'
import {
  exportToCSV,
  exportToJSON,
  exportToExcel,
  exportToImage,
  detectExportFormat,
  type ExportFormat,
  type ExportResult,
} from '@/services/export/data-exporter'
import { formatSize } from '@/lib/utils'

//=============================================================================
// Types
//=============================================================================

interface ExportHistoryItem {
  id: string
  filename: string
  format: ExportFormat
  size: number
  timestamp: number
  success: boolean
}

interface ExportPanelProps {
  /** Data to export */
  data?: unknown
  /** Chart element for image export */
  chartElement?: Element | null
  /** Default filename */
  defaultFilename?: string
  /** Callback when export completes */
  onExportComplete?: (result: ExportResult) => void
  /** Callback when panel closes */
  onClose?: () => void
  /** i18n translation function */
  t?: (key: string, params?: Record<string, string | number>) => string
}

//=============================================================================
// Component
//=============================================================================

export function ExportPanel({
  data,
  chartElement,
  defaultFilename = 'export',
  onExportComplete,
  onClose,
  t = (key: string) => key,
}: ExportPanelProps) {
  // UI State
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>('csv')
  const [isExporting, setIsExporting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [exportHistory, setExportHistory] = useState<ExportHistoryItem[]>([])
  const [options, setOptions] = useState({
    addTimestamp: true,
    includeHeaders: true,
  })

  // Auto-detect format from data
  const detectedFormat = data ? detectExportFormat(data) : 'csv'

  // Format options
  const formatOptions: Array<{ value: ExportFormat; label: string; icon: React.ElementType }> = [
    { value: 'csv', label: t('export.format.csv') || 'CSV', icon: FileText },
    { value: 'json', label: t('export.format.json') || 'JSON', icon: FileJson },
    { value: 'excel', label: t('export.format.excel') || 'Excel', icon: FileSpreadsheet },
    { value: 'image', label: t('export.format.image') || 'Image', icon: Image },
  ]

  // Get button class name
  const getButtonClass = (_value: ExportFormat, isSelected: boolean, isDisabled: boolean): string => {
    const baseClass = 'flex flex-col items-center gap-1 p-3 rounded-lg border transition-all'
    const stateClass = isSelected
      ? 'border-primary bg-primary/10 text-primary'
      : 'border-border hover:bg-muted'
    const disabledClass = isDisabled ? ' opacity-50 cursor-not-allowed' : ''
    return `${baseClass} ${stateClass}${disabledClass}`
  }

  // Format timestamp
  const formatTime = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString()
  }

  // Export handlers
  const handleExport = useCallback(async () => {
    if (!data && selectedFormat !== 'image') {
      setError(t('export.error.noData') || 'No data to export')
      return
    }

    setIsExporting(true)
    setProgress(0)
    setStatus(t('export.status.preparing') || 'Preparing...')
    setError(null)

    try {
      let result: ExportResult

      switch (selectedFormat) {
        case 'csv':
          result = await exportToCSV(data as Record<string, unknown>[], {
            filename: defaultFilename,
            addTimestamp: options.addTimestamp,
            onProgress: (p, s) => {
              setProgress(p)
              setStatus(s)
            },
          })
          break

        case 'json':
          result = await exportToJSON(data, {
            filename: defaultFilename,
            addTimestamp: options.addTimestamp,
            onProgress: (p, s) => {
              setProgress(p)
              setStatus(s)
            },
          })
          break

        case 'excel':
          result = await exportToExcel(data as Record<string, unknown>[], {
            filename: defaultFilename,
            addTimestamp: options.addTimestamp,
            sheetName: defaultFilename,
            onProgress: (p, s) => {
              setProgress(p)
              setStatus(s)
            },
          })
          break

        case 'image':
          if (!chartElement) {
            throw new Error(t('export.error.noChart') || 'No chart element to export')
          }
          result = await exportToImage(chartElement as HTMLElement, 'png', {
            filename: defaultFilename,
            addTimestamp: options.addTimestamp,
            onProgress: (p, s) => {
              setProgress(p)
              setStatus(s)
            },
          })
          break

        default:
          throw new Error(t('export.error.invalidFormat') || 'Invalid export format')
      }

      // Add to history
      const historyItem: ExportHistoryItem = {
        id: Date.now().toString(),
        filename: result.filename,
        format: selectedFormat,
        size: result.size,
        timestamp: Date.now(),
        success: result.success,
      }
      setExportHistory((prev) => [historyItem, ...prev.slice(0, 9)])

      onExportComplete?.(result)

      if (result.success) {
        setStatus(t('export.status.complete') || 'Export complete!')
        setProgress(100)
      } else {
        setError(result.error || t('export.error.unknown') || 'Export failed')
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t('export.error.unknown')
      setError(errorMessage)
    } finally {
      setIsExporting(false)
    }
  }, [data, chartElement, selectedFormat, defaultFilename, options.addTimestamp, onExportComplete, t])

  return (
    <div className="export-panel bg-card border rounded-lg shadow-md w-96 max-h-[600px] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/50">
        <div className="flex items-center gap-2">
          <Download className="h-5 w-5" />
          <h2 className="font-semibold">{t('export.title') || 'Export Data'}</h2>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1 hover:bg-muted rounded transition-colors"
            aria-label={t('common.close') || 'Close'}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Content */}
      <div className="p-4 space-y-4 overflow-y-auto max-h-[450px]">
        {/* Format Selection */}
        <div className="space-y-2">
          <label className="block text-sm font-medium">
            Export Format
          </label>
          <div className="grid grid-cols-2 gap-2">
            {formatOptions.map((option) => {
              const Icon = option.icon
              const isSelected = selectedFormat === option.value
              const isDisabled = option.value === 'image' && !chartElement

              return (
                <button
                  key={option.value}
                  onClick={() => !isDisabled && setSelectedFormat(option.value)}
                  disabled={isDisabled}
                  className={getButtonClass(option.value, isSelected, isDisabled)}
                >
                  <Icon className="h-5 w-5" />
                  <span className="text-sm font-medium">{option.label}</span>
                </button>
              )
            })}
          </div>
          {selectedFormat === 'image' && !chartElement ? (
            <p className="text-xs text-muted-foreground mt-1">
              Select a chart first to export as image
            </p>
          ) : null}
        </div>

        {/* Detected Format Notice */}
        {data && detectedFormat !== selectedFormat ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 p-2 rounded">
            <AlertCircle className="h-4 w-4" />
            <span>Detected: {detectedFormat.toUpperCase()}</span>
          </div>
        ) : null}

        {/* Options */}
        <div>
          <label className="block text-sm font-medium mb-2">
            Options
          </label>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={options.addTimestamp}
                onChange={(e) =>
                  setOptions((prev) => ({ ...prev, addTimestamp: e.target.checked }))
                }
                className="rounded"
              />
              <span>Add timestamp to filename</span>
            </label>
            {selectedFormat === 'csv' ? (
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.includeHeaders}
                  onChange={(e) =>
                    setOptions((prev) => ({ ...prev, includeHeaders: e.target.checked }))
                  }
                  className="rounded"
                />
                <span>Include column headers</span>
              </label>
            ) : null}
          </div>
        </div>

        {/* Export Button */}
        <BrandButton
          onClick={handleExport}
          disabled={isExporting || (!data && selectedFormat !== 'image')}
          className="w-full"
          variant="primary"
        >
          {isExporting ? (
            <>
              <span className="animate-spin mr-2">&#9203;</span>
              {status}
            </>
          ) : (
            <>
              <Download className="h-4 w-4 mr-2" />
              Export as {selectedFormat.toUpperCase()}
            </>
          )}
        </BrandButton>

        {/* Progress Bar */}
        {isExporting ? (
          <div className="space-y-1">
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-xs text-center text-muted-foreground">
              {progress.toFixed(0)}%
            </p>
          </div>
        ) : null}

        {/* Error Display */}
        {error ? (
          <div className="flex items-center gap-2 p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {/* Export History */}
        {exportHistory.length > 0 ? (
          <div>
            <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Recent Exports
            </h3>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {exportHistory.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-center justify-between p-2 rounded text-sm ${
                    item.success ? 'bg-muted/50' : 'bg-destructive/10'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {item.success ? (
                      <Check className="h-3 w-3 text-green-500 shrink-0" />
                    ) : (
                      <AlertCircle className="h-3 w-3 text-destructive shrink-0" />
                    )}
                    <span className="truncate">{item.filename}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{item.format.toUpperCase()}</span>
                    <span>{formatSize(item.size)}</span>
                    <span>{formatTime(item.timestamp)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

//=============================================================================
// Export Hook
//=============================================================================

/**
 * Hook for using export functionality
 */
export function useExport() {
  const [isPanelOpen, setIsPanelOpen] = useState(false)
  const [exportData, setExportData] = useState<unknown>(undefined)
  const [chartElement, setChartElement] = useState<Element | null>(null)
  const [filename, setFilename] = useState('export')

  const openExport = useCallback((data: unknown, chart?: Element, name?: string) => {
    setExportData(data)
    setChartElement(chart || null)
    setFilename(name || 'export')
    setIsPanelOpen(true)
  }, [])

  const closeExport = useCallback(() => {
    setIsPanelOpen(false)
  }, [])

  return {
    isExportPanelOpen: isPanelOpen,
    exportData,
    chartElement,
    exportFilename: filename,
    openExport,
    closeExport,
  }
}
