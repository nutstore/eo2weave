/**
 * Keyboard Shortcuts Help Dialog
 *
 * Displays all available keyboard shortcuts in a modal.
 * Organized by category with search functionality.
 */

import { useState, useMemo } from 'react'
import { Search } from 'lucide-react'
import {
  BrandDialog,
  BrandButton,
  BrandDialogContent,
  BrandDialogHeader,
  BrandDialogTitle,
  BrandDialogBody,
  BrandDialogFooter,
} from '@creatorweave/ui'
import {
  useKeyboardShortcuts,
  formatShortcutKey,
  DEFAULT_SHORTCUTS,
} from '@/hooks/useKeyboardShortcuts'
import { useT } from '@/i18n'

interface Shortcut {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  description: string
  labelKey?: string
  category?: string
}

interface KeyboardShortcutsHelpProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  customShortcuts?: Shortcut[]
}

export function KeyboardShortcutsHelp({
  open,
  onOpenChange,
  customShortcuts = [],
}: KeyboardShortcutsHelpProps) {
  const { getAllShortcuts } = useKeyboardShortcuts()
  const t = useT()
  const [searchQuery, setSearchQuery] = useState('')

  // Localize a shortcut's description if it carries a labelKey
  const localize = (s: Shortcut): Shortcut =>
    s.labelKey ? { ...s, description: t(s.labelKey) } : s

  // Combine default and custom shortcuts
  const allShortcuts = useMemo(() => {
    const registered = getAllShortcuts().map((s) => ({
      ...s,
      category: t('keyboardShortcuts.categoryGeneral'),
    }))

    return [
      ...DEFAULT_SHORTCUTS.map((s) => ({
        ...s,
        category: t('keyboardShortcuts.categoryGeneral'),
      })),
      ...customShortcuts,
      ...registered,
    ].reduce<Shortcut[]>((acc, shortcut) => {
      const localized = localize(shortcut)
      // Deduplicate by description
      if (!acc.find((s) => s.description === localized.description)) {
        acc.push(localized)
      }
      return acc
    }, [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getAllShortcuts, customShortcuts, t])

  // Filter shortcuts by search query
  const filteredShortcuts = useMemo(() => {
    if (!searchQuery.trim()) return allShortcuts

    const query = searchQuery.toLowerCase()
    return allShortcuts.filter(
      (shortcut) =>
        shortcut.description.toLowerCase().includes(query) ||
        shortcut.key.toLowerCase().includes(query) ||
        (shortcut.category?.toLowerCase().includes(query) ?? false)
    )
  }, [allShortcuts, searchQuery])

  // Group shortcuts by category
  const shortcutsByCategory = useMemo(() => {
    const groups = new Map<string, Shortcut[]>()
    filteredShortcuts.forEach((shortcut) => {
      const category = shortcut.category || 'Other'
      if (!groups.has(category)) {
        groups.set(category, [])
      }
      groups.get(category)!.push(shortcut)
    })
    return groups
  }, [filteredShortcuts])

  return (
    <BrandDialog open={open} onOpenChange={onOpenChange}>
      <BrandDialogContent>
        <BrandDialogHeader>
          <BrandDialogTitle>{t('keyboardShortcuts.title')}</BrandDialogTitle>
        </BrandDialogHeader>

        <BrandDialogBody className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              placeholder={t('keyboardShortcuts.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="border-subtle w-full rounded-lg border bg-white px-4 py-2 pl-10 text-sm outline-none placeholder:text-neutral-400 focus:border-primary-500 dark:bg-neutral-900"
              autoFocus
            />
          </div>

          {/* Shortcuts list */}
          <div className="max-h-[60vh] space-y-6 overflow-y-auto">
            {Array.from(shortcutsByCategory.entries()).map(([category, shortcuts]) => (
              <div key={category}>
                <h3 className="mb-2 text-sm font-semibold text-foreground">
                  {category}
                </h3>
                <div className="space-y-1">
                  {shortcuts.map((shortcut, idx) => (
                    <div
                      key={`${category}-${idx}`}
                      className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
                    >
                      <span className="text-neutral-700 text-neutral-300 text-neutral-300 dark:text-neutral-300">
                        {shortcut.description}
                      </span>
                      <kbd className="border-subtle rounded border bg-white px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-900 text-neutral-400 text-neutral-400 dark:text-neutral-400">
                        {formatShortcutKey(shortcut)}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {filteredShortcuts.length === 0 && (
              <div className="py-8 text-center text-sm text-neutral-400">
                {t('keyboardShortcuts.noResults', { query: searchQuery })}
              </div>
            )}
          </div>
        </BrandDialogBody>

        <BrandDialogFooter>
          <p className="text-xs text-neutral-400">
            {t('keyboardShortcuts.closeHint')}{' '}
            <kbd className="border-subtle rounded border bg-white px-1.5 py-0.5 dark:bg-neutral-900">
              Esc
            </kbd>{' '}
            {t('keyboardShortcuts.closeHintKey')}
          </p>
          <BrandButton variant="outline" onClick={() => onOpenChange(false)}>
            {t('keyboardShortcuts.closeButton')}
          </BrandButton>
        </BrandDialogFooter>
      </BrandDialogContent>
    </BrandDialog>
  )
}
