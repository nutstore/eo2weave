/**
 * ThinkingDropdown — thinking mode toggle with level selector.
 */

import { useState, useEffect } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import { BrandSwitch } from '@creatorweave/ui'
import { useT } from '@/i18n'
import type { ExtendedThinkingLevel } from '@/agent/llm/pi-ai-custom-openai-fetch'

interface ThinkingDropdownProps {
  enableThinking: boolean
  thinkingLevel: ExtendedThinkingLevel
  setEnableThinking: (enabled: boolean) => void
  setThinkingLevel: (level: ExtendedThinkingLevel) => void
}

export function ThinkingDropdown({
  enableThinking,
  thinkingLevel,
  setEnableThinking,
  setThinkingLevel,
}: ThinkingDropdownProps) {
  const t = useT()
  const [isOpen, setIsOpen] = useState(false)

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.thinking-dropdown-container')) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const levels: { value: ExtendedThinkingLevel; label: string }[] = [
    { value: 'minimal', label: t('conversation.thinkingLevels.minimal') },
    { value: 'low', label: t('conversation.thinkingLevels.low') },
    { value: 'medium', label: t('conversation.thinkingLevels.medium') },
    { value: 'high', label: t('conversation.thinkingLevels.high') },
    { value: 'xhigh', label: t('conversation.thinkingLevels.xhigh') },
    { value: 'max', label: t('conversation.thinkingLevels.max') },
  ]

  return (
    <div className="thinking-dropdown-container relative">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className={`inline-flex h-7 min-h-0 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border-none px-2 text-[11px] font-medium transition-colors sm:h-auto sm:min-h-8 sm:gap-1.5 sm:px-2.5 sm:text-xs ${
          enableThinking
            ? 'bg-primary-100/60 text-primary-700 dark:bg-primary-100/15 dark:text-primary-300'
            : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
        }`}
      >
        <Brain className="h-3 w-3" />
        <span className="max-w-[72px] truncate">
          {enableThinking
            ? t(`conversation.thinkingLevels.${thinkingLevel}`)
            : t('conversation.thinking')}
        </span>
        <ChevronDown
          className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute bottom-full right-0 z-50 mb-1.5 w-52 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-medium text-secondary">
              {t('conversation.thinkingMode')}
            </span>
            <BrandSwitch
              checked={enableThinking}
              onCheckedChange={(checked) => {
                setEnableThinking(checked)
              }}
            />
          </div>
          {enableThinking && (
            <div className="border-t border-neutral-100 px-2 py-1.5 dark:border-neutral-800">
              <div className="grid grid-cols-3 gap-1">
                {levels.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setThinkingLevel(value)
                      setIsOpen(false)
                    }}
                    className={`whitespace-nowrap rounded px-1.5 py-1 text-[10px] font-medium transition-colors ${
                      thinkingLevel === value
                        ? 'bg-primary-600 text-white'
                        : 'bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
