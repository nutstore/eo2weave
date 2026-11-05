import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, Brain, Check, ChevronDown, ChevronRight, Eye, Loader2, Search } from 'lucide-react'
import { useSettingsStore } from '@/store/settings.store'
import { isPotentiallyDynamicProviderType, getProviderConfig, getProviderCatalogStatus, subscribeToProviderRegistry, getProviderRegistryVersion } from '@/agent/providers/types'
import type { LLMProviderType } from '@/agent/providers/types'
import type { ExtendedThinkingLevel } from '@/agent/llm/pi-ai-custom-openai-fetch'
import { supportsImageInput } from '@/agent/llm/pi-ai-model-resolver'
import { Popover, PopoverContent, PopoverTrigger, BrandButton, BrandSwitch } from '@creatorweave/ui'
import { useT } from '@/i18n'

interface AvailableProvider {
  providerType: LLMProviderType
  displayName: string
  models: Array<{ id: string; name: string; hasVision?: boolean; stale?: boolean }>
  providerKey: string
  /** Authoritative model ids (registry list) — pins missing from here are stale. */
  authoritativeIds?: string[]
  /**
   * How the authoritative list was obtained. 'failed' means the catalog is
   * UNKNOWN (never loaded / fetch failed) — an empty list then carries no
   * information and must not flag pins as stale. 'empty' means the provider
   * positively reported that it serves no models (authoritative).
   */
  catalogStatus?: 'loading' | 'ready' | 'empty' | 'failed'
}

/** Flattened model entry used when searching across providers. */
interface FlatModel {
  provider: AvailableProvider
  model: { id: string; name: string; hasVision?: boolean; stale?: boolean }
}

function isUnverifiedGateway(provider: AvailableProvider): boolean {
  // 'loading' is excluded (Sourcery: "Loading gateway appears unavailable"):
  // a gateway whose catalog is still restoring is NOT an outage — the amber
  // unavailable banner must not fire before the /v1/models fetch finished.
  // Only positively-negative outcomes ('empty' / 'failed') banner + retry.
  return provider.providerType === 'llm-gateway' &&
    (provider.catalogStatus === 'empty' || provider.catalogStatus === 'failed')
}

/**
 * Issue #188 fix 1 (soft-land superseded snapshots): decide whether a
 * finished run's snapshot may replace the rendered list. A superseded run
 * (the run started while a newer one was already in flight) is still a
 * valid read-only catalog — dropping it blanked the popover until the
 * newest run landed and was the visible "skeleton refresh". Only apply it
 * when we have nothing yet; otherwise keep the last accepted snapshot
 * (stale-while-revalidate) until a CURRENT run replaces it.
 *
 * The run's currency comes from the top-level `runCurrent` flag, NOT the
 * per-entry `current` mapping (Sourcery: "Empty stale snapshots erase
 * providers"): a superseded run that found ZERO providers maps to `[]`
 * with no current:false marker, and `[].every(...)` is true — reading the
 * entries let an empty superseded result erase a non-empty accepted
 * snapshot and blank the switcher.
 */
export function shouldApplyProviderSnapshot(
  result: { length: number; runCurrent?: boolean },
  hasAcceptedSnapshot: boolean,
): boolean {
  if (!hasAcceptedSnapshot) return true
  return result.runCurrent !== false
}

interface ModelQuickSwitchProps {
  /** Show the thinking level beside the model when rendered in the composer toolbar. */
  compact?: boolean
  enableThinking?: boolean
  thinkingLevel?: ExtendedThinkingLevel
  setEnableThinking?: (enabled: boolean) => void
  setThinkingLevel?: (level: ExtendedThinkingLevel) => void
}

export function ModelQuickSwitch({
  compact = false,
  enableThinking = false,
  thinkingLevel = 'medium',
  setEnableThinking,
  setThinkingLevel,
}: ModelQuickSwitchProps = {}) {
  const t = useT()
  const providerType = useSettingsStore((s) => s.providerType)
  const modelName = useSettingsStore((s) => s.modelName)
  const modelCredentialStatus = useSettingsStore((s) => s.modelCredentialStatus)
  const getAvailableProviders = useSettingsStore((s) => s.getAvailableProviders)
  const switchProviderAndModel = useSettingsStore((s) => s.switchProviderAndModel)
  const providerRefreshVersion = useSettingsStore((s) => s._providerRefreshVersion)

  const [open, setOpen] = useState(false)
  const [providers, setProviders] = useState<AvailableProvider[]>([])
  // Last snapshot the render gate accepted — tracks "do we have anything on
  // screen" across registry-triggered reloads without extra state churn.
  const acceptedSnapshotRef = useRef<AvailableProvider[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [retryingGatewayCatalog, setRetryingGatewayCatalog] = useState(false)
  const [query, setQuery] = useState('')
  const [collapsedProviders, setCollapsedProviders] = useState<Record<string, boolean>>({})
  const [visionOnly, setVisionOnly] = useState(false)
  const [searchResultIdx, setSearchResultIdx] = useState(0)
  const [thinkingPopoverOpen, setThinkingPopoverOpen] = useState(false)

  // The dynamic-provider registry mutates asynchronously (extension
  // detection, gateway login, custom-provider restore). Subscribing to its
  // version (useSyncExternalStore) makes both the cached provider list
  // refresh below and the selectedProviderUnregistered memo reactive.
  const providerRegistryVersion = useSyncExternalStore(
    subscribeToProviderRegistry,
    getProviderRegistryVersion,
    getProviderRegistryVersion
  )

  // Re-fetch the cached provider list when the dynamic-provider registry
  // changes (Sourcery round 2): registering/unregistering a provider while
  // this popover is mounted must refresh the cached list, otherwise the
  // switcher keeps offering models from a provider that no longer exists.
  // The initial version is captured once; subsequent registry mutations bump
  // a generation counter that the load effect below depends on.
  const [registryLoadGen, setRegistryLoadGen] = useState(0)
  const initialRegistryVersionRef = useRef<number | null>(null)
  useEffect(() => {
    if (initialRegistryVersionRef.current === null) {
      initialRegistryVersionRef.current = providerRegistryVersion
      return
    }
    if (providerRegistryVersion !== initialRegistryVersionRef.current) {
      initialRegistryVersionRef.current = providerRegistryVersion
      setRegistryLoadGen((v) => v + 1)
    }
  }, [providerRegistryVersion])

  const searchInputRef = useRef<HTMLInputElement>(null)
  const thinkingCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // True once the FIRST provider-list load has settled (Sourcery round 3).
  // `loading` must not gate the unregistered-provider warning after this:
  // a registry-triggered refresh sets `loading` again and would suppress
  // the live warning until the refresh resolves.
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)

  // Stale-while-revalidate (#188): a refresh that started while an accepted
  // snapshot is already rendered must NOT swap the list for the skeleton —
  // the last accepted list stays visible (dimmed) until the fresh run
  // lands. Only the FIRST load (nothing accepted yet) shows the skeleton.
  const refreshingExistingList = loading && (acceptedSnapshotRef.current?.length ?? 0) > 0

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setLoadError(false)
      try {
        const result = await getAvailableProviders()
        // A superseded run (a newer getAvailableProviders() started while
        // this one was awaiting) reports runCurrent:false — applying it
        // over a newer run's data would let an older overlapping
        // run that resolves late overwrite the newer run's provider data
        // (Sourcery: "Superseded model lists remain selectable"). But
        // DROPPING it outright blanked the popover until the newest run
        // landed (#188 fix 1): a superseded snapshot is still a valid
        // read-only catalog, so soft-land it when nothing is rendered yet
        // and otherwise keep the last accepted snapshot until the CURRENT
        // run replaces it.
        if (!cancelled && shouldApplyProviderSnapshot(result, acceptedSnapshotRef.current !== null)) {
          acceptedSnapshotRef.current = result
          setProviders(result)
        }
      } catch (err) {
        console.error('[ModelQuickSwitch] Failed to load providers:', err)
        if (!cancelled) setLoadError(true)
      } finally {
        if (!cancelled) {
          setLoading(false)
          setHasLoadedOnce(true)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // NOTE: `open` is intentionally excluded — providers are cached after first load
    // and refreshed only when _providerRefreshVersion changes (pin/unpin/custom provider edits).
    // Including `open` here caused a full reload every time the popover opens.
  }, [getAvailableProviders, providerRefreshVersion, registryLoadGen])

  // Reset transient search state when the popover closes.
  useEffect(() => {
    if (open) return
    setQuery('')
    setSearchResultIdx(0)
  }, [open])

  // Filter out providers with no models available
  const visibleProviders = useMemo(() =>
    providers.filter((p) => p.models.length > 0),
    [providers]
  )
  const gatewayCatalogUnavailable = providers.some(
    isUnverifiedGateway,
  )

  // Enrich each model with hasVision and stale:
  // - hasVision: OpenRouter snapshot first (authoritative modality metadata);
  //   for models missing from the snapshot (newly released, e.g. gpt-6-sol/luna),
  //   fall back to the provider registry's declared capabilities via the
  //   providerType argument (codex-oauth models carry 'vision' from the
  //   extension response).
  // - stale: pinned before but missing from the provider's AUTHORITATIVE id
  //   list (registry / static list) — not from `models`, which is pinned-derived
  //   and would always contain every pin (making stale detection impossible).
  //   The catalog status travels with the comparison so an UNKNOWN catalog
  //   (never loaded / fetch failed / empty response) reports nothing stale.
  const enrichedProviders = useMemo<AvailableProvider[]>(() => {
    const { getStalePinnedModels } = useSettingsStore.getState()
    return visibleProviders.map((p) => {
      const staleIds = new Set(
        getStalePinnedModels(
          p.providerType,
          p.authoritativeIds ?? p.models.map((m) => m.id),
          p.catalogStatus,
        )
      )
      return {
        ...p,
        models: p.models.map((m) => ({
          ...m,
          hasVision: supportsImageInput(m.id, p.providerType),
          stale: staleIds.has(m.id),
        })),
      }
    })
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

  useEffect(() => {
    setSearchResultIdx(0)
  }, [trimmedQuery])

  // Token-AND matching: every space-separated token must hit name or id
  const filteredFlatModels = useMemo<FlatModel[]>(() => {
    if (!isSearching) return []
    const tokens = trimmedQuery.split(/\s+/).filter(Boolean)
    return flatModels.filter(({ model }) => {
      const hay = `${model.name} ${model.id}`.toLowerCase()
      return tokens.every((tk) => hay.includes(tk))
    })
  }, [flatModels, trimmedQuery])

  // Whether the currently-selected model is flagged stale (shown as a warning
  // dot on the trigger button so users learn before sending a message).
  const currentModelStale = useMemo(() => {
    const currentProvider = enrichedProviders.find((p) => p.providerType === providerType)
    return currentProvider?.models.some((model) => model.id === modelName && model.stale) ?? false
  }, [enrichedProviders, providerType, modelName])

  // The dynamic-provider registry mutates asynchronously (extension
  // detection, gateway login, custom-provider restore). Subscribing to its
  // version makes the memo below reactive (Sourcery round 5): registering
  // or unregistering a provider while this component is mounted must
  // recompute the flag — a stale cached `providers` list alone cannot.
  // (Declaration moved above the cached-list refresh effect, which also
  // depends on this version — Sourcery round 2.)
  // Unregistered dynamic provider (#87): the persisted selection names a
  // provider (codex-oauth, llm-gateway, custom-*) that has not registered
  // this session — `getProviderConfig` returns null for it, so
  // `getAvailableProviders` cannot list it either. Sending would hit a
  // dead route (the stale virtual key in SQLite even makes the credential
  // check pass), so this is a THIRD no-usable-model state alongside
  // gateway-expired. The selection is kept for seamless re-login restore.
  //
  // `getProviderConfig` (the LIVE registry) is authoritative (Sourcery
  // round 5): a provider still present in the cached `providers` list
  // after unregistering must NOT count as registered — the cached list is
  // a snapshot, the registry is the truth.
  const selectedProviderUnregistered = useMemo(() => {
    void providerRegistryVersion
    // Suppress the warning only during the INITIAL load (dynamic providers
    // register asynchronously after mount — warning before that window
    // closes would flash a false "unavailable"). Registry-triggered
    // refreshes (Sourcery round 3) must NOT re-arm the suppression: a
    // provider that unregisters mid-session would otherwise lose its
    // warning while the provider-list reload is pending.
    if (!hasLoadedOnce || !providerType || !modelName) return false
    if (!isPotentiallyDynamicProviderType(providerType)) return false
    return !getProviderConfig(providerType)
  }, [hasLoadedOnce, providerType, modelName, providerRegistryVersion])

  // Registered but its catalog discovery is still in flight (#188 fix 4):
  // a gateway between registration and its first successful /v1/models
  // fetch is RESTORING, not unregistered — the 请重新登录 warning must
  // not fire for it (selectedProviderUnregistered stays false above) and
  // neither does the amber no-usable-model state. A neutral "restoring
  // session" label renders instead until the catalog lands.
  const selectedProviderRestoring = useMemo(() => {
    void providerRegistryVersion
    if (!providerType || !modelName) return false
    if (!isPotentiallyDynamicProviderType(providerType)) return false
    if (!getProviderConfig(providerType)) return false
    return getProviderCatalogStatus(providerType) === 'loading'
  }, [providerType, modelName, providerRegistryVersion])

  // Warning copy must name the provider the user must re-login to
  // (Sourcery round 5): codex-oauth gets the Codex-specific recovery text;
  // llm-gateway and custom-* would otherwise see guidance for the wrong
  // provider. Keys exist in all four locales.
  const unregisteredWarningKey =
    providerType === 'codex-oauth'
      ? 'topbar.modelSwitcher.codexUnavailableWarning'
      : 'topbar.modelSwitcher.providerUnavailableWarning'

  const currentModelLabel = useMemo(() => {
    // No API key configured → always show "unavailable" regardless of persisted values
    if (loading && selectedProviderRestoring) return `${modelName} · ${t('topbar.modelSwitcher.sessionRestoring')}`
    if (loading) return t('topbar.modelSwitcher.loading')
    if (modelCredentialStatus === 'expired' && modelName && !selectedProviderUnregistered) {
      return `${modelName} · ${t('topbar.modelSwitcher.credentialExpired')}`
    }
    if (!providerType || !modelName) {
      return t('topbar.modelSwitcher.noModels')
    }
    // A selected model with an unresolved/missing key check is a CREDENTIAL
    // state, not "no models" (#84 review round 2) — keep showing the model
    // name so the chip's amber warning reads as re-credentials, not re-pick.
    // An unregistered dynamic provider (#87) appends the provider-specific
    // re-login warning instead of the bare model name. A registered gateway
    // whose catalog is still restoring (#188 fix 4) shows a neutral
    // "restoring session" note — NOT the re-login warning.
    const currentProvider = providers.find((p) => p.providerType === providerType)
    const model = currentProvider?.models.find((m) => m.id === modelName)
    const base = model?.name || modelName
    if (selectedProviderRestoring) return `${base} · ${t('topbar.modelSwitcher.sessionRestoring')}`
    return selectedProviderUnregistered
      ? `${base} · ${t(unregisteredWarningKey)}`
      : base
  }, [loading, selectedProviderUnregistered, selectedProviderRestoring, modelCredentialStatus, providerType, providers, modelName, t, unregisteredWarningKey])

  // No usable model (#82): nothing selectable — the composer's input is
  // disabled and this chip carries the amber warning state pointing at
  // model selection. Expired credentials keep the selection (label above
  // already appends the re-login hint) and get the warning too — but the
  // accessible label must NOT claim "no model selected" in that state
  // (#84 review): it would misdirect screen-reader users away from the
  // visible re-login action.
  // "No model" means NO provider/model SELECTED (#84 review round 2) — a
  // missing key is a credential problem, not a selection problem, and an
  // unresolved key check must not count as a confirmed missing key. The
  // credential branch below wins whenever a provider+model are chosen, so
  // the label points at recovering credentials, not re-picking a model.
  //
  // The unregistered-provider term above slots into the same
  // noUsableModel family (#87).
  const noModelSelected = !loading && (!providerType || !modelName)
  const credentialExpired = !loading && modelCredentialStatus === 'expired'
  const noUsableModel = noModelSelected || credentialExpired || selectedProviderUnregistered

  const thinkingLevels: { value: ExtendedThinkingLevel; label: string }[] = [
    { value: 'minimal', label: t('conversation.thinkingLevels.minimal') },
    { value: 'low', label: t('conversation.thinkingLevels.low') },
    { value: 'medium', label: t('conversation.thinkingLevels.medium') },
    { value: 'high', label: t('conversation.thinkingLevels.high') },
    { value: 'xhigh', label: t('conversation.thinkingLevels.xhigh') },
    { value: 'max', label: t('conversation.thinkingLevels.max') },
  ]

  const cancelThinkingClose = () => {
    if (thinkingCloseTimerRef.current) {
      clearTimeout(thinkingCloseTimerRef.current)
      thinkingCloseTimerRef.current = null
    }
  }

  const openThinkingPopover = () => {
    cancelThinkingClose()
    setThinkingPopoverOpen(true)
  }

  const scheduleThinkingClose = () => {
    cancelThinkingClose()
    thinkingCloseTimerRef.current = setTimeout(() => {
      setThinkingPopoverOpen(false)
      thinkingCloseTimerRef.current = null
    }, 120)
  }

  useEffect(() => () => cancelThinkingClose(), [])

  const handleSelect = (provider: AvailableProvider, nextModelName: string) => {
    if (isUnverifiedGateway(provider) || (isPotentiallyDynamicProviderType(provider.providerType) && !getProviderConfig(provider.providerType))) return
    switchProviderAndModel(provider.providerType, nextModelName)
    setOpen(false)
  }

  const retryGatewayCatalog = async () => {
    setRetryingGatewayCatalog(true)
    try {
      const gateway = await import('@/agent/providers/llm-gateway-provider')
      const token = await gateway.getValidAccessToken(
        gateway.getLLMGatewayBaseURL(), gateway.getLLMGatewayClientId(),
      )
      if (token) await gateway.updateGatewayModels(token, gateway.getGatewayAuthSessionGeneration())
    } catch (error) {
      console.error('[ModelQuickSwitch] Failed to refresh gateway models:', error)
    } finally {
      setRetryingGatewayCatalog(false)
      useSettingsStore.getState().triggerProviderRefresh()
    }
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

  // Always show the switcher so users can find it even when nothing is
  // configured (previously it was hidden when no providers existed).

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <BrandButton
          variant="ghost"
          className={`h-7 w-fit max-w-full min-w-0 justify-between gap-1.5 border-0 bg-transparent px-2.5 text-xs ${
            noUsableModel ? 'text-amber-600 dark:text-amber-400' : ''
          }`}
          aria-label={
            noModelSelected
              ? t('topbar.modelSwitcher.noUsableModelWarning')
              : selectedProviderUnregistered
                ? t(unregisteredWarningKey)
                : credentialExpired
                  ? t('topbar.modelSwitcher.credentialExpiredWarning')
                  : undefined
          }
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={`min-w-0 truncate ${noUsableModel ? 'text-amber-600 dark:text-amber-400' : 'text-secondary'}`}
              title={currentModelLabel}
            >
              {currentModelLabel}
            </span>
            {enableThinking && compact && (
              <span className="shrink-0 text-muted-foreground" aria-hidden>
                /
              </span>
            )}
            {enableThinking && compact && (
              <span className="shrink-0 truncate text-secondary" title={t(`conversation.thinkingLevels.${thinkingLevel}`)}>
                {t(`conversation.thinkingLevels.${thinkingLevel}`)}
              </span>
            )}
            {currentModelStale ? (
              <span
                className="relative flex h-2 w-2 shrink-0"
                title={t('topbar.modelSwitcher.currentModelDelistedTooltip')}
                aria-label={t('topbar.modelSwitcher.currentModelDelistedTooltip')}
              >
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
              </span>
            ) : null}
            {noUsableModel ? (
              <AlertTriangle
                className="h-3 w-3 shrink-0 text-amber-500"
                aria-hidden
              />
            ) : null}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-tertiary" />
        </BrandButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="flex max-h-[420px] w-[300px] flex-col overflow-hidden rounded-lg border border-border/80 bg-white p-0 shadow-md shadow-black/5 dark:bg-neutral-900"
      >
        {/* Search input — always visible when providers exist */}
        {(!loading || refreshingExistingList) && enrichedProviders.length > 0 && (
          <div className="border-b border-border/70 px-3 py-2">
            <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tertiary" />
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={t('topbar.modelSwitcher.searchPlaceholder')}
                className="h-8 w-full rounded-md border border-border/60 bg-transparent py-1 pl-8 pr-2 text-xs outline-none placeholder:text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                aria-label={t('topbar.modelSwitcher.searchPlaceholder')}
              />
            </div>
            <button
              type="button"
              onClick={() => setVisionOnly((v) => !v)}
              title={t('topbar.modelSwitcher.visionOnlyTooltip')}
              aria-label={t('topbar.modelSwitcher.visionOnlyTooltip')}
              aria-pressed={visionOnly}
              className={`flex h-8 shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                visionOnly
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border/60 text-tertiary hover:bg-muted'
              }`}
            >
              <Eye className="h-3.5 w-3.5" />
              <span>{t('topbar.modelSwitcher.visionOnly')}</span>
            </button>
            </div>
          </div>
        )}

        {!loading && !refreshingExistingList && gatewayCatalogUnavailable && (
          <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2 text-xs text-tertiary">
            <span>{t('topbar.modelSwitcher.catalogUnavailable')}</span>
            <button
              type="button"
              onClick={() => void retryGatewayCatalog()}
              disabled={retryingGatewayCatalog}
              className="shrink-0 text-primary hover:underline disabled:opacity-50"
            >
              {retryingGatewayCatalog ? t('topbar.modelSwitcher.loading') : t('topbar.modelSwitcher.retryCatalog')}
            </button>
          </div>
        )}

        {/* Refreshing indicator (stale-while-revalidate #188): the last accepted list stays
            visible below, dimmed, with a small spinner in the header while a reload is in
            flight — instead of hiding it behind the first-load skeleton. */}
        {refreshingExistingList && (
          <div className="flex items-center gap-2 border-b border-border/70 px-3 py-1.5 text-xs text-tertiary">
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
            <span>{t('topbar.modelSwitcher.refreshing')}</span>
          </div>
        )}

        {!refreshingExistingList && loading ? (
                      <div className="space-y-1.5 py-1.5">
            <div className="h-9 animate-pulse rounded-lg border border-border/60 bg-muted/40" />
            <div className="h-7 animate-pulse rounded-md bg-muted/30" />
            <div className="h-7 animate-pulse rounded-md bg-muted/30" />
          </div>
        ) : !refreshingExistingList && enrichedProviders.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 px-2 py-4 text-center">
            <span className="text-xs text-tertiary">{loadError ? t('topbar.modelSwitcher.temporarilyUnavailable') : t('topbar.modelSwitcher.noModels')}</span>
          </div>
        ) : isSearching ? (
          filteredFlatModels.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-tertiary">
              {t('topbar.modelSwitcher.noResults')}
            </div>
          ) : (
            <div className="min-h-0 max-h-[240px] flex-1 space-y-0.5 overflow-auto px-1.5 py-1.5">
              {filteredFlatModels.map(({ provider, model }, idx) => {
                const selected =
                  provider.providerType === providerType && model.id === modelName
                const isActive = idx === searchResultIdx
                const unverifiedGateway = isUnverifiedGateway(provider)
                return (
                  <button
                    key={`${provider.providerKey}:${model.id}`}
                    type="button"
                    onClick={() => handleSelect(provider, model.id)}
                    disabled={unverifiedGateway || (isPotentiallyDynamicProviderType(provider.providerType) && !getProviderConfig(provider.providerType))}
                    aria-selected={selected}
                    className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 ${
                      selected ? 'bg-primary/15 text-primary-800 dark:text-primary-200' : isActive ? 'bg-primary/10 text-primary-800 dark:text-primary-200' : 'hover:bg-primary/10 hover:text-primary-800 dark:hover:text-primary-200'
                    }`}>
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate" title={model.name}>{model.name}</span>
                      {model.stale ? (
                        <span
                          className="inline-flex shrink-0 items-center gap-0.5 rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[10px] font-medium text-amber-500"
                          title={t('topbar.modelSwitcher.delistedTooltip')}
                        >
                          <AlertTriangle className="h-2.5 w-2.5" />
                          {t('topbar.modelSwitcher.delisted')}
                        </span>
                      ) : model.hasVision ? (
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
          <div className="min-h-0 max-h-[240px] flex-1 space-y-0.5 overflow-auto px-1.5 py-1.5" aria-label={t('topbar.modelSwitcher.title')}>
            {enrichedProviders
              .filter((p) => !visionOnly || p.models.some((m) => m.hasVision))
              .map((provider) => {
                const isCurrentProvider = provider.providerType === providerType
                const isCollapsed = collapsedProviders[provider.providerKey] ?? false
                const visibleModels = visionOnly
                  ? provider.models.filter((m) => m.hasVision)
                  : provider.models

                return (
                  <div key={provider.providerKey} className="overflow-hidden rounded-lg">
                  <button
                    type="button"
                    onClick={() => toggleProviderCollapsed(provider.providerKey)}
                    className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs outline-none transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary"
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
                    </span>
                  </button>
                  {!isCollapsed ? (
                    <div className="space-y-0.5 border-t border-border/40 px-1.5 py-1.5">
                      {visibleModels.map((model) => {
                        const selected = isCurrentProvider && model.id === modelName
                        const unverifiedGateway = isUnverifiedGateway(provider)
                        return (
                          <button
                            key={`${provider.providerKey}:${model.id}`}
                            type="button"
                            onClick={() => handleSelect(provider, model.id)}
                            disabled={unverifiedGateway || (isPotentiallyDynamicProviderType(provider.providerType) && !getProviderConfig(provider.providerType))}
                            aria-selected={selected}
                            className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 ${selected ? 'bg-primary/15 text-primary-800 dark:text-primary-200' : 'hover:bg-primary/10 hover:text-primary-800 dark:hover:text-primary-200'}`}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate" title={model.name}>{model.name}</span>
                              {model.stale ? (
                                <span
                                  className="inline-flex shrink-0 items-center gap-0.5 rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[10px] font-medium text-amber-500"
                                  title={t('topbar.modelSwitcher.delistedTooltip')}
                                >
                                  <AlertTriangle className="h-2.5 w-2.5" />
                                  {t('topbar.modelSwitcher.delisted')}
                                </span>
                              ) : model.hasVision ? (
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

        {compact && setThinkingLevel && (
          <section className="border-t border-border/70 bg-muted/25 px-3 py-1.5">
            <Popover open={thinkingPopoverOpen} onOpenChange={setThinkingPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  onMouseEnter={openThinkingPopover}
                  onMouseLeave={scheduleThinkingClose}
                  className="flex w-full items-center justify-between rounded-md px-1.5 py-1 text-left outline-none transition-colors hover:bg-primary/10 hover:text-primary-800 dark:hover:text-primary-200 focus-visible:ring-2 focus-visible:ring-primary"
                  aria-label={t('conversation.thinkingMode')}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="text-xs font-semibold text-secondary">{t('conversation.thinkingMode')}</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {enableThinking ? t(`conversation.thinkingLevels.${thinkingLevel}`) : t('conversation.thinking')}
                    </span>
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-tertiary" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="right"
                align="end"
                sideOffset={8}
                onMouseEnter={openThinkingPopover}
                onMouseLeave={scheduleThinkingClose}
                className="w-[190px] rounded-lg border-border/80 bg-white p-2 shadow-md shadow-black/5 dark:bg-neutral-900"
              >
                <div className="flex items-center justify-between px-1.5 pb-1.5">
                  <span className="text-xs font-semibold text-secondary">{t('conversation.thinkingMode')}</span>
                  {setEnableThinking && <BrandSwitch checked={enableThinking} onCheckedChange={setEnableThinking} />}
                </div>
                <div className="space-y-0.5 border-t border-border/60 pt-1.5">
                  {thinkingLevels.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setThinkingLevel(value)}
                      aria-pressed={enableThinking && thinkingLevel === value}
                      className={`flex h-7 w-full items-center justify-between rounded-md px-2 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary ${enableThinking && thinkingLevel === value ? 'bg-primary/15 font-medium text-primary-800 dark:text-primary-200' : 'text-secondary hover:bg-primary/10 hover:text-primary-800 dark:hover:text-primary-200'}`}
                    >
                      {label}
                      {enableThinking && thinkingLevel === value ? <Check className="h-3.5 w-3.5" /> : null}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          </section>
        )}

      </PopoverContent>
    </Popover>
  )
}

export default ModelQuickSwitch
