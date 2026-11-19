import { useMemo } from 'react'
import { createUseT } from '@creatorweave/i18n'
import { useI18nStore } from './store'

/**
 * Translation hooks for the web app
 * @example
 * const t = useT()
 * t('common.save') => "Save" (localized for the active locale)
 */
export function useT() {
  const locale = useI18nStore((state) => state.locale)
  return useMemo(() => createUseT(locale), [locale])
}

/**
 * Read and set the active language
 * @example
 * const [locale, setLocale] = useLocale()
 * setLocale('en-US')
 */
export function useLocale() {
  const { locale, setLocale } = useI18nStore()
  return [locale, setLocale] as const
}

// Re-export types and constants
export type { Locale } from '@creatorweave/i18n'
export { LOCALE_LABELS } from '@creatorweave/i18n'
