import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Circle, Eye, Search, Settings, Sparkles } from 'lucide-react'
import { useSettingsStore } from '@/store/settings.store'
import type { LLMProviderType } from '@/agent/providers/types'
import { supportsImageInput } from '@/agent/llm/pi-ai-model-resolver'
import { Popover, PopoverContent, PopoverTrigger, BrandButton } from '@creatorweave/ui'
import { useT } from '@/i18n'

interface AvailableProvider {
  providerType: LLMProviderType
  displayName: string
  models: Array<{ id: string; name: string; hasVision?: boolean }>
  providerKey: string
}

/** Flattened model entry used when searching across providers. */
interface FlatModel {
  provider: AvailableProvider
  model: { id: string; name: string; hasVision?: boolean }
}

interface ModelQuickSwitchProps {
  /** Called when user clicks the "Manage providers" entry. Typically opens
   *  the settings dialog on the LLM provider tab. */
  onManageProviders?: () => void
}

export function ModelQuickSwitch({ onManageProviders }: ModelQuickSwitchProps = {}) {
  const t = useT()
  const providerType = useSettingsStore((s) => s.providerType)
  const modelName = useSettingsStore((s) => s.modelName)
  const hasApiKey = useSettingsStore((s) => s.hasApiKey)
  const getAvailableProviders = useSettingsStore((s) => s.getAvailableProviders)
  const switchProviderAndModel = useSettingsStore((s) => s.switchProviderAndModel)
  const providerRefreshVersion = useSettingsStore((s) => s._providerRefreshVersion)

  const [open, setOpen] = useState(false)
  const [providers, setProviders] = useState<AvailableProvider[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [collapsedProviders, setCollapsedProviders] = useState<Record<string, boolean>>({})
  const [visionOnly, setVisionOnly] = useState(false)
  const [searchResultIdx, setSearchResultIdx] = useState(0)

  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const result = await getAvailableProviders()
        if (!cancelled) {
          setProviders(result)
        }
      } catch (err) {
        console.error('[ModelQuickSwitch] Failed to load providers:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // NOTE: `open` is intentionally excluded — providers are cached after first load
    // and refreshed only when _providerRefreshVersion changes (pin/unpin/custom provider edits).
    // Including `open` here caused a full reload every time the popover opens.
  }, [getAvailableProviders, providerRefreshVersion])

  // Auto-focus the search input when popover opens
  useEffect(() => {
    if (open) {
      // Defer focus until content is painted
      const id = requestAnimationFrame(() => {
        searchInputRef.current?.focus()
      })
      return () => cancelAnimationFrame(id)
    }
    // Reset query when popover closes
    setQuery('')
  }, [open])

  // Filter out providers with no models available
  const visibleProviders = useMemo(() =>
    providers.filter((p) => p.models.length > 0),
    [providers]
  )

  // Enrich each model with hasVision (vision capability from OpenRouter
  // snapshot).  supportsImageInput is a sync snapshot lookup, so it never
  // throws — no try/catch needed.
  const enrichedProviders = useMemo<AvailableProvider[]>(() => {
    return visibleProviders.map((p) => ({
      ...p,
      models: p.models.map((m) => ({ ...m, hasVision: supportsImageInput(m.id) })),
    }))
  }, [visibleProviders])

  useEffect(() => {
    setCollapsedProviders((prev) => {
      const next: Record<string, boolean> = {}
      let changed = Object.keys(prev).length !== visibleProviders.length

      for (const provider of visibleProviders) {
        if (provider.providerKey in prev) {
          next[provider.providerKey] = prev[provider.providerKey]
        } else {
          next[provider.providerKey] = false
          changed = true
        }
      }

      return changed ? next : prev
    })
  }, [visibleProviders])

  useEffect(() => {
    if (!open || !providerType) return
    const currentProvider = visibleProviders.find((p) => p.providerType === providerType)
    if (!currentProvider) return

    setCollapsedProviders((prev) =>
      prev[currentProvider.providerKey]
        ? { ...prev, [currentProvider.providerKey]: false }
        : prev
    )
  }, [open, providerType, visibleProviders])

  // Build a flat list of all models for cross-provider search
  const flatModels = useMemo<FlatModel[]>(() => {
    const list: FlatModel[] = []
    for (const provider of enrichedProviders) {
      for (const model of provider.models) {
        list.push({ provider, model })
      }
    }
    return list
  }, [enrichedProviders])

  const trimmedQuery = query.trim().toLowerCase()
  const isSearching = trimmedQuery.length > 0

  // Token-AND matching: every space-separated token must hit name or id
  const filteredFlatModels = useMemo<FlatModel[]>(() => {
    if (!isSearching) return []
    const tokens = trimmedQuery.split(/\s+/).filter(Boolean)
    return flatModels.filter(({ model }) => {
      const hay = `${model.name} ${model.id}`.toLowerCase()
      return tokens.every((tk) => hay.includes(tk))
    })
  }, [flatModels, trimmedQuery])

  const currentLabel = useMemo(() => {
    // No API key configured → always show "unavailable" regardless of persisted values
    if (!hasApiKey) {
      return t('topbar.modelSwitcher.unavailable')
    }
    // No model selected yet
    if (!providerType || !modelName) {
      return t('topbar.modelSwitcher.unavailable')
    }
    // Always show current provider/model, even if not in pinned list
    const currentProvider = providers.find(
      (p) => p.providerType === providerType
    )
    if (currentProvider) {
      const model = currentProvider.models.find((m) => m.id === modelName)
      return `${currentProvider.displayName} / ${model?.name || modelName}`
    }
    return modelName || t('topbar.modelSwitcher.unavailable')
  }, [hasApiKey, providerType, providers, modelName, t])

  const handleSelect = (provider: AvailableProvider, nextModelName: string) => {
    switchProviderAndModel(provider.providerType, nextModelName)
    setOpen(false)
  }

  const toggleProviderCollapsed = (providerKey: string) => {
    setCollapsedProviders((prev) => ({
      ...prev,
      [providerKey]: !prev[providerKey],
    }))
  }

  // Keyboard: Enter selects the first matched model, Esc clears or closes,
  // ArrowUp/ArrowDown navigates search results.
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && isSearching && filteredFlatModels.length > 0) {
      e.preventDefault()
      const { provider, model } = filteredFlatModels[Math.min(searchResultIdx, filteredFlatModels.length - 1)]
      handleSelect(provider, model.id)
    } else if (e.key === 'Escape') {
      if (isSearching) {
        e.preventDefault()
        setQuery('')
      }
      // If not searching, let the popover handle Esc (closes naturally)
    } else if (e.key === 'ArrowDown' && isSearching && filteredFlatModels.length > 0) {
      e.preventDefault()
      setSearchResultIdx((prev) => Math.min(prev + 1, filteredFlatModels.length - 1))
    } else if (e.key === 'ArrowUp' && isSearching && filteredFlatModels.length > 0) {
      e.preventDefault()
      setSearchResultIdx((prev) => Math.max(prev - 1, 0))
    }
  }

  // Always show the button so users can see it even when nothing is configured
  // (previously it was hidden when no providers existed)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <BrandButton variant="outline" className="h-8 max-w-[280px] min-[380px]:max-w-[160px] justify-between gap-2 px-2.5 text-xs">
          <span className="flex min-w-0 items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-tertiary" />
            <span className="truncate text-secondary" title={currentLabel}>{currentLabel}</span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-tertiary" />
        </BrandButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-3">
        <div className="mb-2 px-2 py-1 text-xs font-medium text-tertiary">
          {t('topbar.modelSwitcher.title')}
        </div>

        {/* Search input — always visible when providers exist */}
        {!loading && enrichedProviders.length > 0 && (
          <div className="mb-2 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tertiary" />
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={t('topbar.modelSwitcher.searchPlaceholder')}
                className="w-full rounded-md border border-border/60 bg-transparent py-2 pl-8 pr-2 text-sm outline-none placeholder:text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                aria-label={t('topbar.modelSwitcher.searchPlaceholder')}
              />
            </div>
            <button
              type="button"
              onClick={() => setVisionOnly((v) => !v)}
              title={t('topbar.modelSwitcher.visionOnlyTooltip')}
              aria-label={t('topbar.modelSwitcher.visionOnlyTooltip')}
              aria-pressed={visionOnly}
              className={`flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-2 text-xs transition-colors ${
                visionOnly
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border/60 text-tertiary hover:bg-muted'
              }`}
            >
              <Eye className="h-3.5 w-3.5" />
              <span>{t('topbar.modelSwitcher.visionOnly')}</span>
            </button>
          </div>
        )}

        {loading ? (
          <div className="space-y-2 py-2">
            <div className="h-9 animate-pulse rounded-lg border border-border/60 bg-muted/40" />
            <div className="h-7 animate-pulse rounded-md bg-muted/30" />
            <div className="h-7 animate-pulse rounded-md bg-muted/30" />
          </div>
        ) : enrichedProviders.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-2 py-6 text-center">
            <span className="text-xs text-tertiary">{t('topbar.modelSwitcher.noPinnedModels')}</span>
            {onManageProviders && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  onManageProviders()
                }}
                className="rounded-md bg-primary-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-primary-700"
              >
                {t('topbar.modelSwitcher.manageProviders')}
              </button>
            )}
          </div>
        ) : isSearching ? (
          /* Search mode: flat list, each item tagged with provider name */
          filteredFlatModels.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-tertiary">
              {t('topbar.modelSwitcher.noResults')}
            </div>
          ) : (
            <div className="max-h-[320px] space-y-1 overflow-auto pr-1">
              {filteredFlatModels.map(({ provider, model }, idx) => {
                const selected =
                  provider.providerType === providerType && model.id === modelName
                const isActive = idx === searchResultIdx
                return (
                  <button
                    key={`${provider.providerKey}:${model.id}`}
                    type="button"
                    onClick={() => handleSelect(provider, model.id)}
                    className={`flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm ${
                      isActive ? 'bg-primary/10' : 'hover:bg-muted'
                    }`}>
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate" title={model.name}>{model.name}</span>
                      {model.hasVision ? (
                        <Eye
                          className="h-3.5 w-3.5 shrink-0 text-primary"
                          aria-label={t('topbar.modelSwitcher.visionCapable')}
                        />
                      ) : null}
                      <span className="shrink-0 text-xs text-tertiary">
                        {provider.displayName}
                      </span>
                    </span>
                    {selected ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
                  </button>
                )
              })}
            </div>
          )
        ) : (
          /* Default mode: grouped by provider (original layout) */
          <div className="max-h-[320px] space-y-2 overflow-auto pr-1">
            {enrichedProviders
              .filter((p) => !visionOnly || p.models.some((m) => m.hasVision))
              .map((provider) => {
              const isCurrentProvider = provider.providerType === providerType
              const isCollapsed = collapsedProviders[provider.providerKey] ?? false
              const visibleModels = visionOnly
                ? provider.models.filter((m) => m.hasVision)
                : provider.models

              return (
                <div
                  key={provider.providerKey}
                  className="overflow-hidden rounded-lg"
                >
                  <button
                    type="button"
                    onClick={() => toggleProviderCollapsed(provider.providerKey)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left transition-colors hover:bg-muted/30"
                    aria-expanded={!isCollapsed}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {isCollapsed ? (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-tertiary" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-tertiary" />
                      )}
                      <span className="truncate text-sm font-semibold text-secondary" title={provider.displayName}>
                        {provider.displayName}
                      </span>
                      {isCurrentProvider ? (
                        <Circle className="h-2 w-2 fill-current text-primary" aria-label="Current provider" />
                      ) : null}
                    </span>
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-1 text-xs text-tertiary">
                      {visibleModels.length}
                      {visionOnly && visibleModels.length !== provider.models.length ? (
                        <span className="ml-0.5 text-tertiary/60">/{provider.models.length}</span>
                      ) : null}
                    </span>
                  </button>
                  {!isCollapsed ? (
                    <div className="space-y-1 border-t border-border/40 px-2 py-2">
                      {visibleModels.map((model) => {
                        const selected = isCurrentProvider && model.id === modelName
                        return (
                          <button
                            key={`${provider.providerKey}:${model.id}`}
                            type="button"
                            onClick={() => handleSelect(provider, model.id)}
                            className={`flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm transition-colors ${selected ? 'bg-muted/60' : 'hover:bg-muted'}`}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate" title={model.name}>{model.name}</span>
                              {model.hasVision ? (
                                <Eye
                                  className="h-3.5 w-3.5 shrink-0 text-primary"
                                  aria-label={t('topbar.modelSwitcher.visionCapable')}
                                />
                              ) : null}
                            </span>
                            {selected ? <Check className="h-4 w-4 text-primary" /> : null}
                          </button>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}

        {/* Manage providers entry — opens settings → LLM tab */}
        {onManageProviders && (
          <>
            <div className="mt-2 border-t border-border/40" />
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onManageProviders()
              }}
              className="mt-2 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-secondary transition-colors hover:bg-muted"
            >
              <Settings className="h-3.5 w-3.5 shrink-0 text-tertiary" />
              {t('topbar.modelSwitcher.manageProviders')}
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

export default ModelQuickSwitch
