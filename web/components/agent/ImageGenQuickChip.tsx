/**
 * ImageGenQuickChip — input-area shortcut that pre-fills a natural-language
 * image prompt (image-generation PRD v1.2+, R2.1).
 *
 * Clicking pre-fills an example prompt into the chat input; the user completes
 * and sends it as a normal message, and the agent reaches generate_image in a
 * single turn. It never triggers generation directly.
 *
 * Display gate (decided 2026-09-10: "strict hide"): shares the SAME source of
 * truth as generate_image tool registration — isImageGenAvailable(). When the
 * provider cannot generate images the chip does not render at all, so users
 * can never click into a promise the product cannot keep. Activation guidance
 * for unconfigured users lives in onboarding (R2.4) and the settings
 * empty-state (R3), not here.
 *
 * Dismissal ("close and remember") is persisted in workspace preferences.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ImageIcon, X } from 'lucide-react'
import { useT } from '@/i18n'
import { isImageGenAvailable } from '@/agent/tools/image-gen.tool'
import { useSettingsStore } from '@/store/settings.store'
import { onModelsUpdated } from '@/agent/providers/model-store'
import { useWorkspacePreferencesStore } from '@/store/workspace-preferences.store'
import type { LLMProviderType } from '@/agent/providers/types'

/**
 * Reactive wrapper around the tool-registration gate.
 *
 * isImageGenAvailable() reads non-reactive sources (settings store fields plus
 * the module-level model cache). We subscribe to its inputs and re-evaluate
 * the canonical function whenever any of them changes — the chip can never
 * drift from tool registration because the decision IS
 * isImageGenAvailable(), not a reimplementation of it.
 */
function useImageGenAvailable(): boolean {
  const imageGenModel = useSettingsStore((s) => s.imageGenModel)
  const providerType = useSettingsStore((s) => s.providerType) as LLMProviderType
  const [cacheVersion, setCacheVersion] = useState(0)

  // The model cache lives outside zustand; onModelsUpdated fires when a
  // provider's model list arrives (same pattern as ImageGenDropdown).
  useEffect(() => {
    return onModelsUpdated(() => setCacheVersion((v) => v + 1))
  }, [])

  // The three subscribed inputs are re-evaluation TRIGGERS: they signal that
  // state behind isImageGenAvailable() (settings, provider config, model
  // cache) may have changed. The boolean decision itself always comes from
  // the canonical function — never reimplemented here. `void` references
  // mark them as used so exhaustive-deps accepts the intentional extra deps.
  return useMemo(() => {
    void imageGenModel
    void providerType
    void cacheVersion
    try {
      return isImageGenAvailable()
    } catch (error) {
      // The gate reads several stores/caches. Any unexpected throw must never
      // take down the input area (the chip sits in ConversationView's render
      // path above the ErrorBoundary for its children). Fail closed: hide the
      // chip — consistent with the strict-hide decision.
      console.warn('[ImageGenQuickChip] availability check failed, hiding chip:', error)
      return false
    }
  }, [imageGenModel, providerType, cacheVersion])
}

export function ImageGenQuickChip({ onPrefill }: { onPrefill: (text: string) => void }) {
  const t = useT()
  const available = useImageGenAvailable()
  const dismissed = useWorkspacePreferencesStore((s) => s.imageGenChipDismissed)
  const setImageGenChipDismissed = useWorkspacePreferencesStore((s) => s.setImageGenChipDismissed)

  const examplePrompt = t('conversation.imageGen.quickChip.examplePrompt')

  const handlePrefill = useCallback(() => {
    onPrefill(examplePrompt)
  }, [onPrefill, examplePrompt])

  const handleDismiss = useCallback(() => {
    setImageGenChipDismissed(true)
  }, [setImageGenChipDismissed])

  // Strict-hide gate — evaluated after all hooks (Rules of Hooks).
  if (!available || dismissed) return null

  return (
    <div className="mb-1.5 flex items-center">
      <span className="inline-flex items-center gap-0.5 rounded-full border border-neutral-200 bg-white py-1 pl-2.5 pr-1 text-xs text-neutral-600 shadow-sm transition-colors hover:border-primary-300 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-primary-700">
        <button
          type="button"
          onClick={handlePrefill}
          title={examplePrompt}
          className="inline-flex items-center gap-1.5 transition-colors hover:text-primary-700 dark:hover:text-primary-300"
        >
          <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {t('conversation.imageGen.quickChip.label')}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={t('conversation.imageGen.quickChip.dismissLabel')}
          title={t('conversation.imageGen.quickChip.dismissLabel')}
          className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </span>
    </div>
  )
}
