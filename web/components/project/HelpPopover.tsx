'use client'

import { useEffect, useRef, useState } from 'react'
import { BookOpen } from 'lucide-react'
import { useT } from '@/i18n'

export interface HelpPopoverProps {
  onOpenDocs: () => void
}

/**
 * Header help button + popover (文档中心 / GitHub / 隐私政策).
 *
 * Replaces the old full-width hero "Docs Hub" button. Closes on outside click
 * and on Escape.
 */
export function HelpPopover({ onOpenDocs }: HelpPopoverProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={t('projectHome.help.label')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="grid h-9 w-9 place-items-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      >
        <BookOpen className="h-4 w-4" />
      </button>
      {/* The menu drops below the header button group, so it needs a z-index
          above the page content (extension banner, hero) to stay clickable. */}
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-2 w-44 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onOpenDocs()
            }}
            className="block w-full px-3 py-2 text-left text-sm text-secondary transition-colors hover:bg-muted"
          >
            {t('projectHome.help.docsHub')}
          </button>
          <a
            href="https://github.com/nutstore/eo2weave"
            target="_blank"
            rel="noopener noreferrer"
            role="menuitem"
            className="block w-full px-3 py-2 text-left text-sm text-secondary transition-colors hover:bg-muted"
          >
            GitHub
          </a>
          <a
            href="/privacy"
            role="menuitem"
            className="block w-full px-3 py-2 text-left text-sm text-secondary transition-colors hover:bg-muted"
          >
            {t('projectHome.help.privacy')}
          </a>
        </div>
      )}
    </div>
  )
}