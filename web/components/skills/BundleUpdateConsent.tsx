/**
 * One aggregated consent prompt for sibling bundle updates (#183).
 *
 * A bundle ZIP can carry several skills; installing one of them used to
 * overwrite every other installed member whose store version is newer, with no
 * prompt. The owner chose the aggregated design: one dialog lists every member
 * that would be updated, each row can be unchecked, and unchecked members are
 * skipped (and named in the install summary).
 *
 * The hook keeps the promise plumbing; the enumeration/partition logic lives
 * in the pure `@/skills/bundle-update-consent` module.
 */

import { useCallback, useRef, useState } from 'react'
import {
  BrandButton,
  BrandCheckbox,
  BrandDialog,
  BrandDialogBody,
  BrandDialogContent,
  BrandDialogFooter,
  BrandDialogHeader,
  BrandDialogTitle,
} from '@creatorweave/ui'
import { useT } from '@/i18n'
import type { BundleUpdateCandidate } from '@/skills/bundle-update-consent'

export interface BundleUpdateConsentApi {
  /** Present the prompt; resolves with the approved dirNames (possibly none). */
  confirm: (candidates: BundleUpdateCandidate[]) => Promise<string[]>
  /** Mount the dialog once, next to the install surface. */
  element: React.ReactNode
}

export function useBundleUpdateConsent(): BundleUpdateConsentApi {
  const t = useT()
  const [pending, setPending] = useState<BundleUpdateCandidate[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const resolverRef = useRef<((approved: string[]) => void) | null>(null)

  const settle = useCallback((approved: string[]) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setPending(null)
    resolve?.(approved)
  }, [])

  const confirm = useCallback((candidates: BundleUpdateCandidate[]) => {
    if (candidates.length === 0) return Promise.resolve<string[]>([])
    return new Promise<string[]>((resolve) => {
      resolverRef.current = resolve
      setSelected(new Set(candidates.map((candidate) => candidate.dirName)))
      setPending(candidates)
    })
  }, [])

  const toggle = useCallback((dirName: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(dirName)
      else next.delete(dirName)
      return next
    })
  }, [])

  const element = (
    <BrandDialog
      open={pending !== null}
      onOpenChange={(isOpen) => {
        // Closing the dialog declines every member: the installed copies stay.
        if (!isOpen) settle([])
      }}
    >
      <BrandDialogContent className="max-w-md">
        <BrandDialogHeader>
          <BrandDialogTitle>{t('skills.discover.bundleUpdateTitle')}</BrandDialogTitle>
        </BrandDialogHeader>
        <BrandDialogBody>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {t('skills.discover.bundleUpdateBody', { count: pending?.length ?? 0 })}
          </p>
          <ul className="mt-3 space-y-2">
            {(pending ?? []).map((candidate) => (
              <li key={candidate.dirName} className="flex items-start gap-2 text-sm">
                <BrandCheckbox
                  size="sm"
                  className="mt-0.5"
                  checked={selected.has(candidate.dirName)}
                  onCheckedChange={(checked) => toggle(candidate.dirName, checked === true)}
                  aria-label={candidate.dirName}
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-neutral-800 dark:text-neutral-200">
                    {candidate.dirName}
                  </span>
                  <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                    {t('skills.discover.bundleUpdateVersion', {
                      from: candidate.installedVersion,
                      to: candidate.storeVersion,
                    })}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </BrandDialogBody>
        <BrandDialogFooter>
          <BrandButton variant="outline" onClick={() => settle([])}>
            {t('skills.discover.bundleUpdateSkip')}
          </BrandButton>
          <BrandButton onClick={() => settle([...selected])}>
            {t('skills.discover.bundleUpdateAccept', { count: selected.size })}
          </BrandButton>
        </BrandDialogFooter>
      </BrandDialogContent>
    </BrandDialog>
  )

  return { confirm, element }
}
