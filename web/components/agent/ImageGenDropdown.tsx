/**
 * ImageGenDropdown — combined image model + aspect ratio selector.
 *
 * A single button in the top bar that opens a popover with:
 *   - Top section: searchable model list (grouped by provider)
 *   - Bottom section: aspect ratio grid
 *
 * Models are filtered against the provider's actual cached model list.
 * Hides entirely when the provider has no image models.
 */

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { ImageIcon, Search, ChevronDown } from 'lucide-react'
import { useSettingsStore } from '@/store/settings.store'
import { useT } from '@/i18n'
import { getImageModels } from '@earendil-works/pi-ai'
import { hasCodexImageBridge } from '@/agent/llm/image-gen'
import { useExtensionStore } from '@/store/extension.store'
import { getCachedModels, onModelsUpdated } from '@/agent/providers/model-store'
import type { LLMProviderType } from '@/agent/providers/types'
import { Popover, PopoverContent, PopoverTrigger, BrandButton } from '@creatorweave/ui'

// ─── Ratio options ──────────────────────────────────────────────────────────

const RATIOS = [
  { value: '1:1', label: '1:1' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
  { value: '3:2', label: '3:2' },
  { value: '2:3', label: '2:3' },
] as const

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Display model ID directly — no pretty-name transformation */
function displayModelId(modelId: string): string {
  return modelId
}

interface ModelEntry {
  id: string
  name: string
  provider: string
}

// ─── Hook: filtered model list ──────────────────────────────────────────────

function useFilteredImageModels() {
  const providerType = useSettingsStore((s) => s.providerType) as LLMProviderType
  const extensionStatus = useExtensionStore((s) => s.status)
  const [cacheVersion, setCacheVersion] = useState(0)

  useEffect(() => {
    return onModelsUpdated(() => setCacheVersion((v) => v + 1))
  }, [])

  return useMemo(() => {
    if ((providerType as string) === 'codex-oauth') return hasCodexImageBridge() ? [{ id: 'gpt-image-2', name: 'gpt-image-2', provider: 'openai' }] : []
    const registryModels = getImageModels('openrouter' as any)
    const cached =
      getCachedModels(providerType, providerType) ||
      getCachedModels(providerType)

    // If no cached models exist for this provider, we cannot determine which
    // image models are available. Return empty to avoid showing models from
    // unrelated providers (e.g. showing OpenRouter image models for Codex OAuth).
    // This is consistent with isImageGenAvailable() which also returns false
    // when cached is null.
    if (!cached || cached.length === 0) return [] as ModelEntry[]

    const cachedIds = new Set<string>()
    for (const m of cached) cachedIds.add(m.id)

    return registryModels
      .filter((m) => {
        // Only exact match against the full registry ID (e.g. "openai/gpt-5-image").
        // We do NOT match by short ID or substring — the same model ID suffix
        // can exist in non-OpenRouter providers (e.g. Codex returns "gpt-5-image"
        // as a text model with vision, not an image generation model).
        // A full match like cachedIds.has("openai/gpt-5-image") confirms the
        // provider's backend is actually OpenRouter.
        if (cachedIds.has(m.id)) return true
        return false
      })
      .map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.id.includes('/') ? m.id.split('/')[0]! : 'other',
      })) as ModelEntry[]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerType, cacheVersion, extensionStatus])
}

/** Whether the current provider has any image generation models available. */
export function useHasImageModels(): boolean {
  return useFilteredImageModels().length > 0
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ImageGenDropdown({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const imageGenModel = useSettingsStore((s) => s.imageGenModel)
  const providerType = useSettingsStore((s) => s.providerType)
  const setImageGenModel = useSettingsStore((s) => s.setImageGenModel)
  const imageGenAspectRatio = useSettingsStore((s) => s.imageGenAspectRatio)
  const setImageGenAspectRatio = useSettingsStore((s) => s.setImageGenAspectRatio)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const allModels = useFilteredImageModels()

  // Group by provider
  const grouped = useMemo(() => {
    const groups = new Map<string, ModelEntry[]>()
    for (const m of allModels) {
      const label = m.provider.charAt(0).toUpperCase() + m.provider.slice(1).replace(/-/g, ' ')
      if (!groups.has(label)) groups.set(label, [])
      groups.get(label)!.push(m)
    }
    return groups
  }, [allModels])

  // Filter by search
  const filtered = useMemo(() => {
    if (!search.trim()) return grouped
    const q = search.toLowerCase()
    const result = new Map<string, ModelEntry[]>()
    for (const [provider, models] of grouped) {
      const matched = models.filter(
        (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
      )
      if (matched.length > 0) result.set(provider, matched)
    }
    return result
  }, [grouped, search])

  const selectedModel = (providerType as string) === 'codex-oauth' ? 'gpt-image-2' : imageGenModel
  const currentDisplay = useMemo(() => displayModelId(selectedModel), [selectedModel])

  /** Accessible name for the icon-only trigger — the model id alone is meaningless. */
  const triggerLabel = `${t('conversation.imageGen.selectModel')}: ${currentDisplay} · ${imageGenAspectRatio || '1:1'}`

  // Focus search input on open
  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 50)
    }
  }, [open])

  const handleSelectModel = useCallback(
    (id: string) => {
      if ((providerType as string) !== 'codex-oauth') setImageGenModel(id)
      setSearch('')
    },
    [setImageGenModel, providerType],
  )

  const handleSelectRatio = useCallback(
    (value: string) => {
      setImageGenAspectRatio(value)
    },
    [setImageGenAspectRatio],
  )

  // Hide when no image models — after all hooks (Rules of Hooks)
  if (allModels.length === 0) return null

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setSearch('') }}>
      <PopoverTrigger asChild>
        {compact ? (
          <BrandButton
            iconButton
            variant="ghost"
            title={triggerLabel}
            aria-label={triggerLabel}
            className="h-7 w-7 shrink-0 p-0"
          >
            <ImageIcon className="h-3.5 w-3.5 shrink-0" />
          </BrandButton>
        ) : (
          <BrandButton
            variant="outline"
            title={triggerLabel}
            aria-label={triggerLabel}
            className="h-8 max-w-[220px] justify-between gap-1.5 px-2.5 text-xs"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <ImageIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{currentDisplay}</span>
              <span className="shrink-0 text-muted-foreground">{imageGenAspectRatio || '1:1'}</span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          </BrandButton>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        {/* Search */}
        <div className="border-b border-border/60 p-2">
          <div className="flex items-center gap-2 rounded-md bg-muted px-2 py-1.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('conversation.imageGen.searchPlaceholder')}
              className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>

        {/* Model list */}
        <div className="max-h-52 overflow-y-auto p-1.5">
          {Array.from(filtered.entries()).map(([provider, models]) => (
            <div key={provider}>
              <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-tertiary">
                {provider}
              </div>
              {models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => handleSelectModel(m.id)}
                  className={`flex w-full items-center rounded-md px-2 py-1.5 text-left text-[11px] transition-colors ${
                    selectedModel === m.id
                      ? 'bg-primary-50 font-medium text-primary-700 dark:bg-primary-100/30 dark:text-primary-700'
                      : 'text-secondary hover:bg-muted'
                  }`}
                >
                  <span className="truncate font-mono">{m.id}</span>
                </button>
              ))}
            </div>
          ))}
          {filtered.size === 0 && (
            <div className="px-2 py-3 text-center text-xs text-tertiary">
              {t('conversation.imageGen.noModelFound')}
            </div>
          )}
        </div>

        {/* Aspect ratio */}
        <div className="border-t border-border/60 p-2">
          <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-tertiary">
            {t('conversation.imageGen.aspectRatioLabel')}
          </div>
          <div className="grid grid-cols-4 gap-1">
            {RATIOS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => handleSelectRatio(value)}
                className={`rounded-md px-1.5 py-1 text-[11px] font-semibold transition-colors ${
                  imageGenAspectRatio === value
                    ? 'bg-primary-50 text-primary-700 dark:bg-primary-100/30 dark:text-primary-700'
                    : 'text-secondary hover:bg-muted'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
