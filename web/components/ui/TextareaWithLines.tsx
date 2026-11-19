/**
 * TextareaWithLines - Enhanced textarea with line numbers
 *
 * The line-number gutter scrolls in sync with the text area; Tab inserts two spaces instead of moving focus.
 */

import { useCallback, useRef } from 'react'
import { cn } from '@/lib/utils'

export interface TextareaWithLinesProps {
  value: string
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  placeholder?: string
  rows?: number
  className?: string
  disabled?: boolean
  'data-testid'?: string
}

export function TextareaWithLines({
  value, onChange, placeholder, rows, className, disabled, 'data-testid': testId,
}: TextareaWithLinesProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lineNumbersRef = useRef<HTMLDivElement>(null)

  const lineCount = value ? value.split('\n').length : 1
  const displayLines = Math.max(lineCount, rows || 1)

  const handleScroll = useCallback(() => {
    if (textareaRef.current && lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const textarea = e.currentTarget
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const newValue = value.substring(0, start) + '  ' + value.substring(end)
      const syntheticEvent = {
        target: { value: newValue, selectionStart: start + 2, selectionEnd: start + 2 },
      } as React.ChangeEvent<HTMLTextAreaElement>
      onChange(syntheticEvent)
      requestAnimationFrame(() => {
        textarea.selectionStart = start + 2
        textarea.selectionEnd = start + 2
      })
    }
  }, [value, onChange])

  return (
    <div className={cn('flex overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-600', className)}>
      {/* Line numbers */}
      <div
        ref={lineNumbersRef}
        className="flex shrink-0 select-none flex-col items-end overflow-hidden bg-neutral-50 px-2 py-3 text-right font-mono text-xs leading-[1.625rem] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
        aria-hidden="true"
      >
        {Array.from({ length: displayLines }, (_, i) => (
          <span key={i} className="block h-[1.625rem] leading-[1.625rem]">
            {i + 1}
          </span>
        ))}
      </div>
      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={onChange}
        onKeyDown={handleKeyDown}
        onScroll={handleScroll}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        data-testid={testId}
        className={cn(
          'flex-1 resize-none bg-white px-4 py-3 font-mono text-sm leading-[1.625rem] dark:bg-neutral-900 dark:text-foreground',
          'placeholder:text-neutral-400 dark:placeholder:text-neutral-500',
          'focus:outline-none'
        )}
      />
    </div>
  )
}
