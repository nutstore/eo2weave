export * from './types'
export * from './config'
export * from './utils'
export { zhCN, enUS, jaJP, koKR } from './locales'

import { translations, DEFAULT_LOCALE } from './config'
import { getNested, interpolate } from './utils'
import type { Locale } from './types'

/**
 * 创建翻译 Hook 工厂函数
 *
 * 使用方式（在各项目中）：
 * ```ts
 * import { createUseT } from '@creatorweave/i18n'
 * import { useI18nStore } from '@/store/i18n.store'
 *
 * export function useT() {
 *   const locale = useI18nStore((state) => state.locale)
 *   return createUseT(locale)
 * }
 * ```
 */
export function createUseT(locale: Locale) {
  const localeTranslations = translations[locale]

  return (
    key: string,
    params?: Record<string, string | number>
  ): string => {
    const value = getNested(localeTranslations, key)

    if (value === undefined) {
      // 尝试 fallback 到默认语言
      if (locale !== DEFAULT_LOCALE) {
        const fallbackValue = getNested(translations[DEFAULT_LOCALE], key)
        if (fallbackValue !== undefined) {
          console.warn(
            `[i18n] Missing "${key}" for "${locale}", using "${DEFAULT_LOCALE}" fallback`
          )
          return params ? interpolate(fallbackValue, params) : fallbackValue
        }
      }

      console.warn(`[i18n] Missing translation: ${key} for locale: ${locale}`)
      return key
    }

    return params ? interpolate(value, params) : value
  }
}

/**
 * 静态翻译函数（用于 React 组件外部）
 *
 * @example
 * import { t } from '@creatorweave/i18n'
 * t('zh-CN', 'common.save') => '保存'
 */
export function t(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>
): string {
  const localeTranslations = translations[locale]
  const value = getNested(localeTranslations, key)

  if (value === undefined) {
    console.warn(`[i18n] Missing translation: ${key} for locale: ${locale}`)
    return key
  }

  return params ? interpolate(value, params) : value
}

/**
 * Localized WebMCP builtin package tool description (display-only).
 *
 * Builtin package manifests (browser-extension/builtin-webmcp/) carry one
 * English description per tool for the LLM; the localized copies for
 * user-facing surfaces (auth modal, search_tools results panel) live in the
 * webmcpTools namespace, keyed by the package's site hostname then the raw
 * tool name. Hostnames contain dots, so this walks the object directly
 * instead of using dotted-path getNested.
 *
 * Returns undefined when the host/tool has no translation for the locale —
 * callers fall back to the manifest's English description.
 */
export function getWebMCPToolDescription(
  locale: Locale,
  sourceId: string,
  toolName: string
): string | undefined {
  const table = (
    translations[locale] as unknown as Record<string, unknown>
  ).webmcpTools as Record<string, Record<string, string>> | undefined
  const description = table?.[sourceId]?.[toolName]
  return typeof description === 'string' && description.length > 0
    ? description
    : undefined
}
