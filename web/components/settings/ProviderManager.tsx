/**
 * ProviderManager - 服务商管理面板
 *
 * 功能：
 * - 列出所有服务商（内置 + 自定义），分组展示
 * - 每个服务商可展开管理：API Key、模型列表
 * - 模型列表：/models 动态获取 + 硬编码 + 手动输入补充
 * - 自定义服务商额外支持编辑 baseURL
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Eye,
  EyeOff,
  AlertTriangle,
  Check,
  ExternalLink,
  Plus,
  X,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Search,
  Loader2,
  CheckCircle2,
  XCircle,
  Copy,
} from 'lucide-react'
import { toast } from 'sonner'
import { useSettingsStore } from '@/store/settings.store'
import type { CustomProviderConfig } from '@/store/settings.store'
import { saveApiKey, loadApiKey, deleteApiKey } from '@/security/api-key-store'
import {
  getProvidersByCategory,
  getModelsForProvider,
  getProviderConfig,
  isCustomProviderType,
} from '@/agent/providers/types'
import { supportsImageInput } from '@/agent/llm/pi-ai-model-resolver'
import { DEEPSEEK_PROVIDER_TYPE, fetchDeepSeekBalance, type DeepSeekBalanceResponse } from '@/agent/providers/deepseek-provider'
import type {
  LLMProviderType,
  ModelInfo,
  ProviderCategory,
} from '@/agent/providers/types'
import { useDynamicModels } from '@/agent/providers/use-dynamic-models'
import { canFetchModels } from '@/agent/providers/model-fetcher'
import { getCachedModels, getModelContextWindow } from '@/agent/providers/model-store'
import { useT } from '@/i18n'
import { useI18nStore } from '@/i18n/store'
import { BrandInput, BrandButton, BrandDialog, BrandDialogContent, BrandDialogHeader, BrandDialogBody, BrandDialogFooter, BrandDialogTitle, BrandDialogClose } from '@creatorweave/ui'
import { LLM_GATEWAY_PROVIDER_TYPE, getLLMGatewayApiKeyProviderKey, getLLMGatewayBaseURL, getLLMGatewayClientId, updateGatewayModels, isLLMGatewayConfigured, fetchGatewayRateLimits, type RateLimitsResponse } from '@/agent/providers/llm-gateway-provider'
import { performDeviceCodeFlow, logoutGateway as logoutGatewayAuth, getValidAccessToken, fetchGatewayModels } from '@/agent/providers/llm-gateway-auth'
import type { AuthState, RateLimitWindow } from '@/agent/providers/llm-gateway-auth'

// =============================================================================
// Constants
// =============================================================================

// Category order is locale-aware: Chinese users see Chinese providers
// first (the default for this product), non-Chinese users see international
// providers first. Custom providers stay on top in both orders (they are
// user-created and thus most relevant).
function categoryOrderForLocale(locale: string): ProviderCategory[] {
  return /^zh/i.test(locale)
    ? ['custom', 'chinese', 'international']
    : ['custom', 'international', 'chinese']
}

/**
 * Map provider types with a Chinese-brand display name to their i18n key.
 * zh-CN keeps the original Chinese brand; other locales use the company's
 * pinyin/English brand — NOT the separate international services (e.g.
 * Zhipu's overseas arm "Z.ai" is a different service from open.bigmodel.cn,
 * so showing "Z.ai" here would mislead users into registering there).
 */
const PROVIDER_NAME_I18N_KEYS: Partial<Record<LLMProviderType, string>> = {
  glm: 'settings.providerNames.glm',
  'glm-coding': 'settings.providerNames.glmCoding',
  'minimax-cn': 'settings.providerNames.minimaxChina',
  qwen: 'settings.providerNames.qwen',
  'volcengine-coding': 'settings.providerNames.volcengineCoding',
}

/** Resolve a provider display name; falls back to the static meta name. */
function localizedProviderName(t: (key: string) => string, type: LLMProviderType, fallback: string): string {
  const key = PROVIDER_NAME_I18N_KEYS[type]
  if (!key) return fallback
  const translated = t(key)
  return translated !== key ? translated : fallback
}

// =============================================================================
// ProviderCard - 单个服务商卡片
// =============================================================================

interface ProviderCardProps {
  providerType: LLMProviderType
  displayName: string
  website?: string
  isCustom: boolean
  customProvider?: CustomProviderConfig
  isExpanded: boolean
  onToggle: () => void
}

function ProviderCard({
  providerType,
  displayName,
  website,
  isCustom,
  customProvider,
  isExpanded,
  onToggle,
}: ProviderCardProps) {
  const t = useT()
  const {
    customProviders,
    updateCustomProvider,
    removeCustomProvider,
    addCustomProviderModel,
    setCustomProviderApiMode,
    invalidateApiKeyCache,
    pinnedModelsByProvider,
    pinModel,
    unpinModel,
    removePinnedModels,
    markPinnedModelsSeen,
    getStalePinnedModels,
    triggerProviderRefresh,
  } = useSettingsStore()

  const providerKey = providerType
  const supportsModelRefresh = canFetchModels(providerType)
  const config = getProviderConfig(providerType)
  const baseUrl = isCustom
    ? customProvider?.baseUrl || ''
    : config?.baseURL || ''

  // API Key state
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saved, setSaved] = useState(false)
  const [hasKey, setHasKey] = useState(false)

  // Dynamic models
  const {
    models: dynamicModels,
    source: modelsSource,
    loading: modelsLoading,
    refresh: refreshModels,
  } = useDynamicModels(providerType, providerKey)

  // Balance query state (DeepSeek only)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [balanceResult, setBalanceResult] = useState<DeepSeekBalanceResponse | null>(null)
  const [balanceError, setBalanceError] = useState<string | null>(null)
  const isDeepSeek = providerType === DEEPSEEK_PROVIDER_TYPE

  // DeepSeek: auto-fetch balance after saving a key (covers the initial save
  // flow) and when the card is expanded and we have a key but no result yet.
  useEffect(() => {
    if (!isDeepSeek || !hasKey || !isExpanded) return
    if (balanceLoading || balanceResult || balanceError) return
    void handleRefreshBalance()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDeepSeek, hasKey, isExpanded, balanceLoading, balanceResult, balanceError])

  const handleRefreshBalance = useCallback(async () => {
    if (!hasKey && !apiKey.trim()) {
      setBalanceError(t('settings.deepseekBalance.queryFailed'))
      return
    }
    const trimmedKey = apiKey.trim() || (await loadApiKey(providerKey).catch(() => null)) || ''
    if (!trimmedKey) {
      setBalanceError(t('settings.deepseekBalance.queryFailed'))
      return
    }
    setBalanceLoading(true)
    setBalanceError(null)
    try {
      const url = isCustom
        ? customProvider?.baseUrl || ''
        : config?.baseURL || ''
      const result = await fetchDeepSeekBalance(trimmedKey, url || undefined)
      setBalanceResult(result)
    } catch (e) {
      setBalanceError((e as Error).message || t('settings.deepseekBalance.queryFailed'))
    } finally {
      setBalanceLoading(false)
    }
  }, [hasKey, apiKey, providerKey, isCustom, customProvider, config, t])

  // Model management state
  const [addingModel, setAddingModel] = useState(false)
  const [newModelDraft, setNewModelDraft] = useState('')
  const [deletingProviderId, setDeletingProviderId] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editBaseUrl, setEditBaseUrl] = useState('')

  // Add model dialog state
  const [showAddModelDialog, setShowAddModelDialog] = useState(false)
  const [addModelSearch, setAddModelSearch] = useState('')

  // Merge model lists: dynamic + static + custom provider models
  const allModels = useMemo<ModelInfo[]>(() => {
    const seen = new Set<string>()
    const result: ModelInfo[] = []

    if (isCustom && customProvider) {
      // Start with configured model IDs (bare bones — no contextWindow info)
      for (const id of customProvider.models) {
        if (!seen.has(id)) {
          seen.add(id)
          result.push({
            id,
            name: id,
            capabilities: ['code'] as const,
            contextWindow: getModelContextWindow(providerType, id),
          })
        }
      }

      // Overlay dynamic models on top — they carry API-provided context_length
      // from the fetch (OpenRouter-style APIs). Preserve the model ID from the
      // dynamic list but use the rich info (contextWindow) from the API.
      for (const dm of dynamicModels) {
        const existingIdx = result.findIndex((m) => m.id === dm.id)
        if (existingIdx >= 0) {
          // Enrich with API data (contextWindow, capabilities, name)
          result[existingIdx] = dm
        } else if (!seen.has(dm.id)) {
          seen.add(dm.id)
          result.push(dm)
        }
      }

      return result
    }

    // Static models first (have capability info)
    const staticModels = getModelsForProvider(providerType)
    for (const m of staticModels) {
      if (!seen.has(m.id)) {
        seen.add(m.id)
        result.push(m)
      }
    }

    // Then dynamic models (from /models API)
    for (const m of dynamicModels) {
      if (!seen.has(m.id)) {
        seen.add(m.id)
        result.push(m)
      }
    }

    return result
  }, [isCustom, customProvider, providerType, dynamicModels])

  // Record confirmed pins against the merged list (dynamic fetch + static +
  // custom provider entries). This is what powers stale detection: a pin
  // seen here at least once, then missing from a later list, gets flagged.
  useEffect(() => {
    if (allModels.length === 0) return
    markPinnedModelsSeen(providerType, allModels.map((m) => m.id))
  }, [allModels, markPinnedModelsSeen, providerType])

  // Pinned models for this provider (resolved to ModelInfo for display)
  const pinnedModels = useMemo(() => {
    const pinnedIds = pinnedModelsByProvider[providerType] || []
    // Empty list = no trustworthy data (fetch pending/failed) → never flag.
    const staleIds = new Set(
      allModels.length > 0 ? getStalePinnedModels(providerType, allModels.map((m) => m.id)) : []
    )
    return pinnedIds
      .map((id) => {
        const found = allModels.find((m) => m.id === id)
        // Fallback: resolve contextWindow via the full lookup chain
        // (dynamic cache → OpenRouter snapshot → static registry → default).
        // This ensures pinned models always show accurate context info
        // even when they're not in the current dynamic/static model list.
        return found || {
          id,
          name: id,
          capabilities: [] as const,
          contextWindow: getModelContextWindow(providerType, id),
        }
      })
      .map((m) => ({ ...m, stale: staleIds.has(m.id) }))
  }, [pinnedModelsByProvider, providerType, allModels, getStalePinnedModels])

  // Filtered models for the "add model" dialog (all - pinned)
  const filteredModels = useMemo(() => {
    const pinnedIds = new Set(pinnedModelsByProvider[providerType] || [])
    const remaining = allModels.filter((m) => !pinnedIds.has(m.id))
    if (!addModelSearch.trim()) return remaining
    const q = addModelSearch.toLowerCase()
    return remaining.filter((m) =>
      m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    )
  }, [allModels, pinnedModelsByProvider, providerType, addModelSearch])

  // Enrich filtered models with vision capability (from OpenRouter snapshot).
  // Mirrors the eye-icon pattern in ModelQuickSwitch so users can see at
  // a glance which models accept image input.  supportsImageInput is a sync
  // snapshot lookup that never throws.
  const filteredModelsWithVision = useMemo(() => {
    return filteredModels.map((m) => ({ ...m, hasVision: supportsImageInput(m.id) }))
  }, [filteredModels])

  // Load API Key (always check on mount; reload when expanded for freshness).
  // Errors are surfaced to the user instead of silently swallowed — when
  // loadApiKey returns null due to a DB init failure, users previously saw
  // "no key configured" and assumed their saved key had vanished.
  useEffect(() => {
    let cancelled = false
    loadApiKey(providerKey)
      .then((key) => {
        if (cancelled) return
        setApiKey(key || '')
        setHasKey(!!key)
      })
      .catch((error) => {
        if (cancelled) return
        console.error('[ProviderManager] Failed to load API key:', error)
        toast.error(t('settings.toast.apiKeyLoadFailed'))
        setHasKey(false)
      })
    return () => {
      cancelled = true
    }
  }, [providerKey, isExpanded, t])

  // Populate edit form
  useEffect(() => {
    if (isEditing && customProvider) {
      setEditName(customProvider.name)
      setEditBaseUrl(customProvider.baseUrl)
    }
  }, [isEditing, customProvider])

  // Remove all stale pinned models for this provider ("clean up delisted" button).
  const handleClearStalePinned = useCallback(() => {
    const staleIds = getStalePinnedModels(providerType, allModels.map((m) => m.id))
    if (staleIds.length === 0) return
    const removed = removePinnedModels(providerType, staleIds)
    if (removed.length > 0) {
      toast.success(t('settings.pinnedModels.staleRemoved', { count: removed.length }))
    }
  }, [getStalePinnedModels, removePinnedModels, providerType, allModels, t])

  const clearApiKey = useCallback(async () => {
    await deleteApiKey(providerKey)
    setApiKey('')
    setHasKey(false)
    setSaved(false)
    setShowKey(false)
    invalidateApiKeyCache(providerKey)

    // Update global hasApiKey state if this is the active provider
    const activeConfig = useSettingsStore.getState().getEffectiveProviderConfig()
    if (activeConfig && activeConfig.apiKeyProviderKey === providerKey) {
      useSettingsStore.getState().setHasApiKey(false)
    }

    triggerProviderRefresh()
    toast.success(t('settings.toast.apiKeyCleared'))
  }, [invalidateApiKeyCache, providerKey, triggerProviderRefresh, t])

  const handleSaveKey = useCallback(async () => {
    const trimmedKey = apiKey.trim()
    if (!trimmedKey) {
      // Custom providers (Ollama, LM Studio, …) may run keyless — an empty
      // input just clears the stored key without forcing the user to enter one.
      await clearApiKey()
      return
    }
    await saveApiKey(providerKey, trimmedKey)
    setHasKey(true)
    setSaved(true)
    invalidateApiKeyCache(providerKey)
    // Update global hasApiKey state if this is the active provider
    const activeConfig = useSettingsStore.getState().getEffectiveProviderConfig()
    if (activeConfig && activeConfig.apiKeyProviderKey === providerKey) {
      useSettingsStore.getState().setHasApiKey(true)
    }

    // Auto-refresh model list after saving API key so users don't need a manual refresh click.
    const url = isCustom
      ? customProvider?.baseUrl || ''
      : config?.baseURL || ''
    await refreshModels(trimmedKey, url)

    // For custom providers, sync fetched dynamic models into persisted customProvider.models.
    if (isCustom && customProvider) {
      const cached = getCachedModels(providerType, providerKey)
      if (cached && cached.length > 0) {
        for (const model of cached) {
          if (!customProvider.models.includes(model.id)) {
            addCustomProviderModel(customProvider.id, model.id)
          }
        }
      }
    }

    // Notify top-bar model switcher and settings panel to refresh their provider lists
    triggerProviderRefresh()

    setTimeout(() => setSaved(false), 2000)
  }, [
    apiKey,
    clearApiKey,
    providerKey,
    invalidateApiKeyCache,
    isCustom,
    customProvider,
    config,
    refreshModels,
    providerType,
    addCustomProviderModel,
    triggerProviderRefresh,
  ])

  const handleRefreshModels = useCallback(async () => {
    let key: string | null
    try {
      key = await loadApiKey(providerKey)
    } catch (error) {
      console.error('[ProviderManager] Failed to load API key for refresh:', error)
      toast.error(t('settings.toast.apiKeyLoadFailed'))
      return
    }
    if (!key && !isCustom) {
      toast.error(t('settings.toast.apiKeyRequired'))
      return
    }
    const url = isCustom
      ? customProvider?.baseUrl || ''
      : config?.baseURL || ''
    await refreshModels(key || undefined, url)

    // For custom providers, sync fetched models to customProvider.models
    if (isCustom && customProvider) {
      const cached = getCachedModels(providerType, providerKey)
      if (cached && cached.length > 0) {
        let added = 0
        for (const model of cached) {
          if (!customProvider.models.includes(model.id)) {
            addCustomProviderModel(customProvider.id, model.id)
            added++
          }
        }
        if (added > 0) {
          toast.success(t('settings.toast.modelsRefreshed'))
        } else {
          toast.success(t('settings.toast.modelsRefreshed'))
        }
      }
    } else if (modelsSource === 'dynamic') {
      toast.success(t('settings.toast.modelsRefreshed'))
    }
  }, [providerKey, isCustom, customProvider, config, refreshModels, modelsSource, t, providerType, addCustomProviderModel])

  const handleSaveCustom = useCallback(() => {
    if (!customProvider) return
    const ok = updateCustomProvider(customProvider.id, {
      name: editName,
      baseUrl: editBaseUrl,
    })
    if (!ok) {
      toast.error(t('settings.toast.invalidProviderInfo'))
      return
    }
    setIsEditing(false)
    toast.success(t('settings.toast.customProviderUpdated'))
  }, [customProvider, editName, editBaseUrl, updateCustomProvider, t])

  return (
    <div className="rounded-lg border border-border/60 overflow-hidden">
      {/* Header */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3.5 py-2.5 text-left hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-tertiary" />
          ) : (
            <ChevronRight className="h-4 w-4 text-tertiary" />
          )}
          <div
            className="h-2 w-2 shrink-0 rounded-full"
            style={{
              background: hasKey
                ? 'var(--brand,#0d9488)'
                : 'var(--border,#2a2a2a)',
              boxShadow: hasKey ? '0 0 6px var(--brand,#0d9488)' : 'none',
            }}
          />
          <span className="text-[13px] font-semibold text-secondary">{displayName}</span>
        </div>
        <div className="flex items-center gap-2">
          {hasKey ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--brand,#0d9488)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--brand,#0d9488)]">
              ✓ Key
            </span>
          ) : (
            <span className="text-[10px] text-tertiary/60">—</span>
          )}
          {website && (
            <a
              href={website}
              target="_blank"
              rel="noopener noreferrer"
              className="text-tertiary hover:text-primary"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t border-border/60 px-3.5 py-3 space-y-4">
          {/* Base URL (read-only for built-in) */}
          <div>
            <p className="text-[11px] font-medium text-secondary">{t('settings.customBaseUrl.label')}</p>
            <p className="mt-0.5 break-all font-mono text-[11px] text-tertiary">
              {baseUrl || t('settings.notConfigured')}
            </p>
          </div>

          {/* API Mode indicator for custom providers (non-edit mode) */}
          {isCustom && customProvider && !isEditing && (
            <div>
              <p className="text-[11px] font-medium text-secondary">{t('settings.apiMode.label')}</p>
              <p className="mt-0.5 text-[11px] text-tertiary">
                {(customProvider.apiMode || 'chat-completions') === 'chat-completions'
                  ? 'Chat Completions (/chat/completions)'
                  : 'Responses API (/responses)'}
              </p>
            </div>
          )}

          {/* Custom Provider Edit (only for custom) */}
          {isCustom && customProvider && (
            <div>
              {isEditing ? (
                <div className="space-y-2.5 rounded-md border border-[var(--brand-border,rgba(13,148,136,0.25))] p-3" style={{ background: 'var(--brand-bg, rgba(13,148,136,0.04))' }}>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-secondary">{t('settings.modelManagement.providerName')}</label>
                    <BrandInput
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="h-9 text-[13px]"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-secondary">{t('settings.customBaseUrl.label')}</label>
                    <BrandInput
                      value={editBaseUrl}
                      onChange={(e) => setEditBaseUrl(e.target.value)}
                      className="h-9 font-mono text-[12px]"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-secondary">{t('settings.apiMode.label')}</label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className={`flex-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                          (customProvider.apiMode || 'chat-completions') === 'chat-completions'
                            ? 'text-white'
                            : 'text-tertiary border border-border hover:bg-muted'
                        }`}
                        style={
                          (customProvider.apiMode || 'chat-completions') === 'chat-completions'
                            ? { background: 'var(--brand, #0d9488)' }
                            : undefined
                        }
                        onClick={() => setCustomProviderApiMode(customProvider.id, 'chat-completions')}
                      >
                        Chat Completions
                      </button>
                      <button
                        type="button"
                        className={`flex-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                          customProvider.apiMode === 'responses'
                            ? 'text-white'
                            : 'text-tertiary border border-border hover:bg-muted'
                        }`}
                        style={
                          customProvider.apiMode === 'responses'
                            ? { background: 'var(--brand, #0d9488)' }
                            : undefined
                        }
                        onClick={() => setCustomProviderApiMode(customProvider.id, 'responses')}
                      >
                        Responses API
                      </button>
                    </div>
                    <p className="mt-1 text-[10px] text-tertiary">{t('settings.apiMode.hint')}</p>
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <BrandButton variant="outline" className="h-8 text-[12px]" onClick={() => setIsEditing(false)}>
                      {t('settings.modelManagement.cancel')}
                    </BrandButton>
                    <button
                      type="button"
                      className="inline-flex items-center justify-center rounded-md px-3 h-8 text-[12px] font-medium text-white transition-colors"
                      style={{ background: 'var(--brand, #0d9488)' }}
                      onClick={handleSaveCustom}
                    >
                      {t('settings.modelManagement.save')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-1 mb-2">
                  <button
                    type="button"
                    className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-tertiary hover:bg-muted hover:text-primary transition-colors"
                    onClick={() => setIsEditing(true)}
                  >
                    ✏️ {t('settings.modelManagement.editProvider')}
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-tertiary hover:bg-[rgba(239,68,68,0.08)] hover:text-[#ef4444] transition-colors"
                    onClick={() => setDeletingProviderId(customProvider.id)}
                  >
                    🗑 {t('settings.modelManagement.deleteProvider')}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* API Key */}
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-secondary">
              {t('settings.apiKey')}
              {isCustom && <span className="ml-1 font-normal text-tertiary">({t('settings.optional')})</span>}
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={t('settings.apiKeyPlaceholder')}
                  className="flex w-full rounded-lg border border-neutral-200 bg-transparent px-3 py-2 pr-16 text-[12px] focus-visible:border-primary-600 focus-visible:outline-none dark:border-border"
                  style={{ WebkitTextSecurity: showKey ? 'none' : 'disc' } as React.CSSProperties}
                  autoComplete="off"
                  data-form-type="other"
                  data-lpignore="true"
                />
                <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1">
                  {(hasKey || apiKey.trim()) && (
                    <button
                      type="button"
                      onClick={clearApiKey}
                      className="text-tertiary hover:text-primary"
                      aria-label={t('common.clear')}
                      title={t('common.clear')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="text-tertiary hover:text-primary"
                    aria-label={showKey ? t('settings.hideApiKey') : t('settings.showApiKey')}
                    title={showKey ? t('settings.hideApiKey') : t('settings.showApiKey')}
                  >
                    {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
              <BrandButton variant="primary" className="h-9 text-[12px]" onClick={handleSaveKey}>
                {saved ? <Check className="h-4 w-4" /> : t('settings.save')}
              </BrandButton>
            </div>
            {isCustom && (
              <p className="text-[10px] leading-relaxed text-tertiary">{t('settings.apiKeyOptionalHint')}</p>
            )}
          </div>

          {/* Account Balance (DeepSeek only) */}
          {isDeepSeek && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[12px] font-medium text-secondary">
                  {t('settings.deepseekBalance.title')}
                </label>
                <button
                  type="button"
                  onClick={handleRefreshBalance}
                  disabled={balanceLoading}
                  className="text-tertiary hover:text-primary disabled:opacity-50"
                  title={t('settings.deepseekBalance.refresh')}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${balanceLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>

              {balanceLoading && (
                <p className="text-[11px] text-tertiary">{t('settings.deepseekBalance.refreshing')}</p>
              )}

              {!balanceLoading && balanceError && (
                <p className="text-[11px] text-red-500 break-all">{balanceError}</p>
              )}

              {!balanceLoading && balanceResult && !balanceError && (
                <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 space-y-1.5">
                  {balanceResult.is_available === false && (
                    <p className="text-[11px] text-amber-500">
                      {t('settings.deepseekBalance.unavailable')}
                    </p>
                  )}
                  {balanceResult.balance_infos.length === 0 ? (
                    <p className="text-[11px] text-tertiary">{t('settings.deepseekBalance.empty')}</p>
                  ) : (
                    balanceResult.balance_infos.map((info) => (
                      <div key={info.currency} className="space-y-1">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="font-medium text-secondary">
                            {t('settings.deepseekBalance.total', { currency: info.currency })}
                          </span>
                          <span className="font-mono font-semibold text-primary">{info.total_balance}</span>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-tertiary">
                          <span>{t('settings.deepseekBalance.granted')}</span>
                          <span className="font-mono">{info.granted_balance}</span>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-tertiary">
                          <span>{t('settings.deepseekBalance.toppedUp')}</span>
                          <span className="font-mono">{info.topped_up_balance}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {!balanceLoading && !balanceResult && !balanceError && (
                <p className="text-[11px] text-tertiary/60">
                  {t('settings.deepseekBalance.hint')}
                </p>
              )}
            </div>
          )}

          {/* My Models (pinned) — works for both built-in and custom providers */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[12px] font-medium text-secondary">
                {t('settings.pinnedModels.title')}
              </label>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-medium text-tertiary">
                  {t('settings.pinnedModels.count', { count: pinnedModels.length })}
                </span>
                {supportsModelRefresh && (
                  <button
                    type="button"
                    onClick={handleRefreshModels}
                    disabled={modelsLoading}
                    className="text-tertiary hover:text-primary disabled:opacity-50"
                    title={t('settings.modelSelection.refreshModels')}
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${modelsLoading ? 'animate-spin' : ''}`} />
                  </button>
                )}
              </div>
            </div>

            {/* Pinned model tags */}
            {pinnedModels.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {pinnedModels.map((model) => (
                  <span
                    key={model.id}
                    title={model.stale ? t('settings.pinnedModels.staleTooltip') : undefined}
                    className={
                      model.stale
                        ? 'group inline-flex items-center gap-1 rounded-full border border-dashed border-amber-500/50 bg-amber-500/10 px-2 py-[3px] text-[11px] text-amber-500 transition-colors cursor-default'
                        : 'group inline-flex items-center gap-1 rounded-full border border-[var(--brand-border,rgba(13,148,136,0.12))] bg-[var(--brand-bg,rgba(13,148,136,0.05))] px-2 py-[3px] text-[11px] text-[var(--brand-light,#14b8a6)]/80 transition-colors cursor-default'
                    }
                  >
                    {model.stale ? <AlertTriangle className="h-3 w-3 shrink-0" /> : null}
                    {model.name}
                    <span className="text-[9px] text-tertiary">
                      {model.contextWindow != null &&
                        model.contextWindow >= 1000000
                        ? `${(model.contextWindow / 1000000).toFixed(0)}M`
                        : model.contextWindow != null &&
                          model.contextWindow >= 1000
                          ? `${(model.contextWindow / 1000).toFixed(0)}K`
                          : ''}
                    </span>
                    <button
                      type="button"
                      className="invisible text-tertiary hover:text-[#ef4444] group-hover:visible"
                      onClick={() => unpinModel(providerType, model.id)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                {pinnedModels.some((m) => m.stale) ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full border border-amber-500/50 px-2 py-[3px] text-[11px] font-medium text-amber-500 transition-colors hover:bg-amber-500/10"
                    onClick={handleClearStalePinned}
                  >
                    <X className="h-3 w-3" />
                    {t('settings.pinnedModels.clearStale', {
                      count: pinnedModels.filter((m) => m.stale).length,
                    })}
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="text-[11px] text-tertiary/60">
                {t('settings.pinnedModels.empty')}
              </p>
            )}

            {/* Add model button + manual input */}
            <div className="flex flex-wrap items-center gap-1.5">
              {hasKey && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--border,#2a2a2a)] px-2 py-[3px] text-[11px] text-tertiary transition-colors hover:border-[var(--brand-border,rgba(13,148,136,0.25))] hover:bg-[var(--brand-bg,rgba(13,148,136,0.06))] hover:text-[var(--brand-light,#14b8a6)]"
                  onClick={() => {
                    setShowAddModelDialog(true)
                    setAddModelSearch('')
                  }}
                >
                  <Plus className="h-3 w-3" />
                  {t('settings.pinnedModels.addFromApi')}
                </button>
              )}
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--border,#2a2a2a)] px-2 py-[3px] text-[11px] text-tertiary transition-colors hover:border-[var(--brand-border,rgba(13,148,136,0.25))] hover:bg-[var(--brand-bg,rgba(13,148,136,0.06))] hover:text-[var(--brand-light,#14b8a6)]"
                onClick={() => {
                  setAddingModel(!addingModel)
                  setNewModelDraft('')
                }}
              >
                <Plus className="h-3 w-3" />
                {t('settings.pinnedModels.addManual')}
              </button>
            </div>

            {/* Manual model input */}
            {addingModel && (
              <div className="flex gap-1.5 animate-in fade-in slide-in-from-top-1 duration-150">
                <BrandInput
                  value={newModelDraft}
                  onChange={(e) => setNewModelDraft(e.target.value)}
                  placeholder={t('settings.modelManagement.newModelName')}
                  className="h-8 flex-1 text-[12px]"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newModelDraft.trim()) {
                      pinModel(providerType, newModelDraft.trim())
                      if (isCustom && customProvider) {
                        addCustomProviderModel(customProvider.id, newModelDraft.trim())
                      }
                      setNewModelDraft('')
                      setAddingModel(false)
                    }
                    if (e.key === 'Escape') setAddingModel(false)
                  }}
                />
                <BrandButton variant="outline" className="h-8 px-2 text-[11px]" onClick={() => setAddingModel(false)}>
                  {t('settings.modelManagement.cancel')}
                </BrandButton>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md px-2.5 h-8 text-[11px] font-medium text-white"
                  style={{ background: 'var(--brand, #0d9488)' }}
                  onClick={() => {
                    const trimmed = newModelDraft.trim()
                    if (!trimmed) return
                    pinModel(providerType, trimmed)
                    if (isCustom && customProvider) {
                      addCustomProviderModel(customProvider.id, trimmed)
                    }
                    setNewModelDraft('')
                    setAddingModel(false)
                  }}
                >
                  {t('settings.modelManagement.addModel')}
                </button>
              </div>
            )}
          </div>

          {/* Add Model from API Dialog */}
          <BrandDialog open={showAddModelDialog} onOpenChange={setShowAddModelDialog}>
            <BrandDialogContent className="!max-w-[420px] !w-[420px] !max-h-[70vh] !flex !flex-col !p-0">
              <BrandDialogHeader>
                <BrandDialogTitle className="!text-[13px]">
                  {t('settings.pinnedModels.dialogTitle')}
                </BrandDialogTitle>
                <BrandDialogClose className="text-tertiary hover:text-primary">
                  <X className="h-4 w-4" />
                </BrandDialogClose>
              </BrandDialogHeader>

              {/* Search */}
              <div className="px-4 py-2 border-b border-border">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-tertiary" />
                  <input
                    type="text"
                    value={addModelSearch}
                    onChange={(e) => setAddModelSearch(e.target.value)}
                    placeholder={t('settings.pinnedModels.searchPlaceholder')}
                    className="flex w-full rounded-md border border-border bg-transparent py-1.5 pl-8 pr-3 text-[12px] focus-visible:outline-none focus-visible:border-[var(--brand-border,rgba(13,148,136,0.25))]"
                    autoFocus
                  />
                </div>
              </div>

              {/* Model list */}
              <div className="flex-1 overflow-auto px-2 py-2">
                {filteredModels.length === 0 ? (
                  <div className="px-3 py-6 text-center text-[12px] text-tertiary">
                    {allModels.length === 0
                      ? t('settings.pinnedModels.noApiModels')
                      : t('settings.pinnedModels.noMatch')}
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {filteredModelsWithVision.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left hover:bg-muted transition-colors"
                        onClick={() => {
                          pinModel(providerType, model.id)
                          setAddModelSearch('')
                        }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-[12px] text-secondary">
                              {model.name}
                            </span>
                            {model.hasVision ? (
                              <Eye
                                className="h-3 w-3 shrink-0 text-[var(--brand,#0d9488)]"
                                aria-label={t('topbar.modelSwitcher.visionCapable')}
                              />
                            ) : null}
                          </div>
                          <div className="truncate text-[10px] text-tertiary font-mono">
                            {model.id}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0 ml-2">
                          {model.contextWindow != null && model.contextWindow > 0 && (
                            <span className="text-[9px] text-tertiary">
                              {model.contextWindow >= 1000000
                                ? `${(model.contextWindow / 1000000).toFixed(0)}M`
                                : model.contextWindow >= 1000
                                  ? `${(model.contextWindow / 1000).toFixed(0)}K`
                                  : ''}
                            </span>
                          )}
                          <Plus className="h-3.5 w-3.5 text-tertiary" />
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Footer hint */}
              <BrandDialogFooter className="!min-h-0 !py-2 !px-4">
                <p className="text-[10px] text-tertiary">
                  {t('settings.pinnedModels.dialogHint', { count: filteredModels.length })}
                </p>
              </BrandDialogFooter>
            </BrandDialogContent>
          </BrandDialog>

          {/* Delete Confirm Dialog */}
          <BrandDialog open={!!deletingProviderId} onOpenChange={(open) => { if (!open) setDeletingProviderId(null) }}>
            <BrandDialogContent className="!max-w-[340px] !w-[340px] !p-0">
              <BrandDialogBody className="!pt-5">
                <BrandDialogTitle className="!text-[14px]">
                  {t('settings.modelManagement.confirmDeleteTitle')}
                </BrandDialogTitle>
                <p className="mt-2 text-[13px] leading-relaxed text-secondary">
                  {t('settings.modelManagement.confirmDeleteMessage', {
                    name: customProviders.find((p) => p.id === deletingProviderId)?.name || '',
                  })}
                </p>
              </BrandDialogBody>
              <BrandDialogFooter>
                <BrandButton variant="outline" className="h-8 text-[12px]" onClick={() => setDeletingProviderId(null)}>
                  {t('settings.modelManagement.cancel')}
                </BrandButton>
                <BrandButton variant="danger" onClick={() => {
                  removeCustomProvider(deletingProviderId!)
                  setDeletingProviderId(null)
                }}>
                  {t('settings.modelManagement.confirmDelete')}
                </BrandButton>
              </BrandDialogFooter>
            </BrandDialogContent>
          </BrandDialog>
        </div>
      )}
    </div>
  )
}

// =============================================================================
// New Provider Form
// =============================================================================

function NewProviderForm({ onClose }: { onClose: () => void }) {
  const t = useT()
  const { createCustomProvider } = useSettingsStore()
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiMode, setApiMode] = useState<import('@/store/settings.store').CustomApiMode>('chat-completions')

  const handleCreate = useCallback(() => {
    const ok = createCustomProvider({ name, baseUrl, apiMode })
    if (!ok) {
      toast.error(t('settings.toast.providerNameRequired'))
      return
    }
    toast.success(t('settings.toast.customProviderAdded'))
    onClose()
  }, [createCustomProvider, name, baseUrl, apiMode, t, onClose])

  return (
    <div
      className="rounded-lg border p-3.5 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200"
      style={{ borderColor: 'var(--brand-border, rgba(13,148,136,0.25))', background: 'var(--brand-bg, rgba(13,148,136,0.06))' }}
    >
      <div className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: 'var(--brand-light, #14b8a6)' }}>
        <Plus className="h-3.5 w-3.5" />
        {t('settings.modelManagement.newProvider')}
      </div>
      <div className="space-y-2.5">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-secondary">{t('settings.modelManagement.providerName')}</label>
          <BrandInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('settings.modelManagement.providerNamePlaceholder')}
            className="h-9 text-[13px]"
            autoFocus
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-secondary">{t('settings.customBaseUrl.label')}</label>
          <BrandInput
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={t('settings.customBaseUrl.placeholder')}
            className="h-9 font-mono text-[12px]"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-secondary">{t('settings.apiMode.label')}</label>
          <div className="flex gap-2">
            <button
              type="button"
              className={`flex-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                apiMode === 'chat-completions'
                  ? 'text-white'
                  : 'text-tertiary border border-border hover:bg-muted'
              }`}
              style={
                apiMode === 'chat-completions'
                  ? { background: 'var(--brand, #0d9488)' }
                  : undefined
              }
              onClick={() => setApiMode('chat-completions')}
            >
              Chat Completions
            </button>
            <button
              type="button"
              className={`flex-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                apiMode === 'responses'
                  ? 'text-white'
                  : 'text-tertiary border border-border hover:bg-muted'
              }`}
              style={
                apiMode === 'responses'
                  ? { background: 'var(--brand, #0d9488)' }
                  : undefined
              }
              onClick={() => setApiMode('responses')}
            >
              Responses API
            </button>
          </div>
          <p className="mt-1 text-[10px] text-tertiary">{t('settings.apiMode.hint')}</p>
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-t pt-3 dark:border-t">
        <BrandButton variant="outline" className="h-8 text-[12px]" onClick={onClose}>
          {t('settings.modelManagement.cancel')}
        </BrandButton>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-3 h-8 text-[12px] font-medium text-white transition-colors"
          style={{ background: 'var(--brand, #0d9488)' }}
          onClick={handleCreate}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('settings.modelManagement.create')}
        </button>
      </div>
    </div>
  )
}

// =============================================================================
// LLM Gateway Card - Special provider card for Device Code Flow
// =============================================================================

/** Format an ISO reset timestamp as a compact relative string. */
function formatResetTime(iso: string | null, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (!iso) return t('settings.gatewayRateLimits.resetUnknown')
  const d = new Date(iso)
  const diffMs = d.getTime() - Date.now()
  const diffH = Math.round(diffMs / 3_600_000)
  if (diffH <= 0) return t('settings.gatewayRateLimits.resetSoon')
  if (diffH < 24) return t('settings.gatewayRateLimits.resetInHours', { count: diffH })
  return t('settings.gatewayRateLimits.resetInDays', { count: Math.round(diffH / 24) })
}

function LLMGatewayCard({
  isExpanded,
  onToggle,
}: {
  isExpanded: boolean
  onToggle: () => void
}) {
  const t = useT()
  const { triggerProviderRefresh, pinModel, unpinModel, removePinnedModels, markPinnedModelsSeen, getStalePinnedModels, pinnedModelsByProvider } = useSettingsStore()
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [allModels, setAllModels] = useState<Array<{ id: string; name: string }>>([])
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const [addingManual, setAddingManual] = useState(false)
  const [manualDraft, setManualDraft] = useState('')

  // Rate-limits query state for the quota progress bars
  const [rateLimitsLoading, setRateLimitsLoading] = useState(false)
  const [rateLimitsResult, setRateLimitsResult] = useState<RateLimitsResponse | null>(null)
  const [rateLimitsError, setRateLimitsError] = useState<string | null>(null)

  // Inline auth flow state
  const [authState, setAuthState] = useState<AuthState & { userCode?: string; verificationUri?: string }>({
    status: 'idle',
  })
  const [copied, setCopied] = useState(false)

  const isAuthRunning = authState.status === 'requesting' || authState.status === 'waiting' || authState.status === 'polling'

  const pinnedIds = pinnedModelsByProvider[LLM_GATEWAY_PROVIDER_TYPE] || []
  // allModels starts empty on mount (models fetch after expand+login) — an
  // empty list is NOT authoritative, so suppress stale flags until it loads.
  const staleIds = useMemo(
    () => new Set(
      allModels.length > 0
        ? getStalePinnedModels(LLM_GATEWAY_PROVIDER_TYPE, allModels.map((m) => m.id))
        : []
    ),
    [getStalePinnedModels, allModels]
  )
  const pinned = pinnedIds.map((id) => {
    const found = allModels.find((m) => m.id === id)
    return { ...(found || { id, name: id }), stale: staleIds.has(id) }
  })

  const handleClearStalePinnedGateway = useCallback(() => {
    const ids = [...staleIds]
    if (ids.length === 0) return
    const removed = removePinnedModels(LLM_GATEWAY_PROVIDER_TYPE, ids)
    if (removed.length > 0) {
      toast.success(t('settings.pinnedModels.staleRemoved', { count: removed.length }))
    }
  }, [staleIds, removePinnedModels, t])

  const unpinned = allModels.filter((m) => !pinnedIds.includes(m.id))
  const filteredUnpinned = !modelSearch.trim()
    ? unpinned
    : unpinned.filter((m) =>
        m.id.toLowerCase().includes(modelSearch.toLowerCase()) ||
        m.name.toLowerCase().includes(modelSearch.toLowerCase())
      )

  // Enrich with vision capability for the "add model" picker (LLM Gateway).
  // supportsImageInput is a sync snapshot lookup that never throws.
  const filteredUnpinnedWithVision = useMemo(() => {
    return filteredUnpinned.map((m) => ({ ...m, hasVision: supportsImageInput(m.id) }))
  }, [filteredUnpinned])

  // Check login status.  Errors here previously left `isLoggedIn = false`
// silently — the same "key disappeared" symptom users reported for built-in
// providers.  Surface a toast so users know it's a transient DB init issue.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { loadApiKey } = await import('@/security/api-key-store')
        const key = await loadApiKey(getLLMGatewayApiKeyProviderKey())
        if (!cancelled) setIsLoggedIn(!!key)
      } catch (error) {
        if (cancelled) return
        console.error('[LLMGatewayCard] Failed to check login status:', error)
        toast.error(t('settings.toast.apiKeyLoadFailed'))
        setIsLoggedIn(false)
      }
    })()
    return () => { cancelled = true }
  }, [isExpanded, t])

  // Fetch models when logged in
  useEffect(() => {
    if (!isLoggedIn || !isExpanded) return
    let cancelled = false
    ;(async () => {
      try {
        const baseURL = getLLMGatewayBaseURL()
        const clientId = getLLMGatewayClientId()
        const token = await getValidAccessToken(baseURL, clientId)
        if (token && !cancelled) {
          const models = await fetchGatewayModels(baseURL, token)
          setAllModels(models)
          // Gateway /models response is authoritative — record confirmed pins
          // so pins absent from a later fetch get flagged as stale.
          if (models.length > 0) {
            markPinnedModelsSeen(LLM_GATEWAY_PROVIDER_TYPE, models.map((m) => m.id))
          }
        }
      } catch {
        // ignore
      }
    })()
    return () => { cancelled = true }
  }, [isLoggedIn, isExpanded, markPinnedModelsSeen])

  // Direct Device Code Flow — triggered by the login button, no extra dialog
  const handleLogin = useCallback(async () => {
    const baseURL = getLLMGatewayBaseURL()
    const clientId = getLLMGatewayClientId()

    if (!clientId) {
      setAuthState({ status: 'error', error: t('settings.gateway.clientIdMissing') })
      return
    }

    try {
      const tokens = await performDeviceCodeFlow(baseURL, clientId, (state) => {
        setAuthState(state)
      })

      // Save access_token as the "API key" for this provider
      const keyId = getLLMGatewayApiKeyProviderKey()
      const { saveApiKey } = await import('@/security/api-key-store')
      await saveApiKey(keyId, tokens.access_token)
      useSettingsStore.getState().invalidateApiKeyCache(keyId)
      // Sync global hasApiKey so TopBar / ModelQuickSwitch stop showing "unavailable"
      useSettingsStore.getState().setHasApiKey(true)

      // Fetch and register model list
      await updateGatewayModels(tokens.access_token)

      setIsLoggedIn(true)
      triggerProviderRefresh()
    } catch (e) {
      setAuthState({
        status: 'error',
        error: (e as Error).message || t('settings.gateway.authFailed'),
      })
    }
  }, [triggerProviderRefresh, t])

  const handleLogout = useCallback(async () => {
    const { deleteApiKey } = await import('@/security/api-key-store')
    const keyId = getLLMGatewayApiKeyProviderKey()
    logoutGatewayAuth()
    await deleteApiKey(keyId)
    useSettingsStore.getState().invalidateApiKeyCache(keyId)
    // Re-check from DB so we don't flip hasApiKey off when another provider is active
    if (useSettingsStore.getState().providerType === LLM_GATEWAY_PROVIDER_TYPE) {
      useSettingsStore.getState().setHasApiKey(false)
    }
    setIsLoggedIn(false)
    setAllModels([])
    setAuthState({ status: 'idle' })
    // Clear cached rate-limits so next login refetches
    setRateLimitsResult(null)
    setRateLimitsError(null)
    triggerProviderRefresh()
  }, [triggerProviderRefresh])

  const handleCopyCode = useCallback(() => {
    if (authState.userCode) {
      navigator.clipboard.writeText(authState.userCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [authState.userCode])

  const handleAddManual = useCallback(() => {
    const trimmed = manualDraft.trim()
    if (!trimmed) return
    pinModel(LLM_GATEWAY_PROVIDER_TYPE, trimmed)
    setManualDraft('')
    setAddingManual(false)
  }, [manualDraft, pinModel])

  const handleFetchRateLimits = useCallback(async () => {
    setRateLimitsLoading(true)
    setRateLimitsError(null)
    try {
      const result = await fetchGatewayRateLimits()
      setRateLimitsResult(result)
      if (process.env.NODE_ENV !== 'production') {
        console.log('[llm-gateway] GET /v1/rate-limits response:', result)
      }
    } catch (e) {
      const msg = (e as Error).message || t('settings.gatewayRateLimits.queryFailed')
      setRateLimitsError(msg)
      if (process.env.NODE_ENV !== 'production') {
        console.error('[llm-gateway] GET /v1/rate-limits error:', e)
      }
    } finally {
      setRateLimitsLoading(false)
    }
  }, [t])

  // Auto-fetch rate limits when the card is expanded and logged in
  useEffect(() => {
    if (!isLoggedIn || !isExpanded) return
    if (rateLimitsResult || rateLimitsError) return // already loaded this session
    void handleFetchRateLimits()
  }, [isLoggedIn, isExpanded, handleFetchRateLimits, rateLimitsResult, rateLimitsError])

  return (
    <div className="rounded-lg border border-[var(--brand-border,rgba(13,148,136,0.25))] overflow-hidden"
      style={{ background: isExpanded ? 'var(--brand-bg, rgba(13,148,136,0.04))' : undefined }}
    >
      {/* Header */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3.5 py-2.5 text-left hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-tertiary" />
          ) : (
            <ChevronRight className="h-4 w-4 text-tertiary" />
          )}
          <div
            className="h-2 w-2 shrink-0 rounded-full"
            style={{
              background: isLoggedIn ? 'var(--brand,#0d9488)' : 'var(--border,#2a2a2a)',
              boxShadow: isLoggedIn ? '0 0 6px var(--brand,#0d9488)' : 'none',
            }}
          />
          <span className="text-[13px] font-semibold text-secondary">{t('settings.gateway.name')}</span>

        </div>
        <div className="flex items-center gap-2">
          {isLoggedIn ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--brand,#0d9488)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--brand,#0d9488)]">
              {t('settings.gateway.loggedIn')}
            </span>
          ) : isAuthRunning ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-tertiary">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('settings.gateway.loggingIn')}
            </span>
          ) : (
            <span className="text-[10px] text-tertiary/60">{t('settings.gateway.loggedOut')}</span>
          )}
        </div>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t border-border/60 px-3.5 py-3 space-y-3">
          <div>
            <p className="text-[11px] font-medium text-secondary">{t('settings.gateway.serviceUrl')}</p>
            <p className="mt-0.5 font-mono text-[11px] text-tertiary">
              {process.env.NEXT_PUBLIC_JIANGUOYUN_AI_BASE_URL || 'https://ai.jianguoyun.com'}
            </p>
          </div>

          {isLoggedIn ? (
            <>
              {/* Pinned models (user's selected models) */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[12px] font-medium text-secondary">
                    {t('settings.pinnedModels.title')}
                  </label>
                  <span className="text-[10px] font-medium text-tertiary">
                    {t('settings.pinnedModels.count', { count: pinned.length })}
                  </span>
                </div>

                {pinned.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {pinned.map((m) => (
                      <span
                        key={m.id}
                        title={m.stale ? t('settings.pinnedModels.staleTooltip') : undefined}
                        className={
                          m.stale
                            ? 'group inline-flex items-center gap-1 rounded-full border border-dashed border-amber-500/50 bg-amber-500/10 px-2 py-[3px] text-[11px] text-amber-500 transition-colors cursor-default'
                            : 'group inline-flex items-center gap-1 rounded-full border border-[var(--brand-border,rgba(13,148,136,0.12))] bg-[var(--brand-bg,rgba(13,148,136,0.05))] px-2 py-[3px] text-[11px] text-[var(--brand-light,#14b8a6)]/80 transition-colors cursor-default'
                        }
                      >
                        {m.stale ? <AlertTriangle className="h-3 w-3 shrink-0" /> : null}
                        {m.name}
                        <button
                          type="button"
                          className="invisible text-tertiary hover:text-[#ef4444] group-hover:visible"
                          onClick={() => unpinModel(LLM_GATEWAY_PROVIDER_TYPE, m.id)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                    {pinned.some((m) => m.stale) ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-full border border-amber-500/50 px-2 py-[3px] text-[11px] font-medium text-amber-500 transition-colors hover:bg-amber-500/10"
                        onClick={handleClearStalePinnedGateway}
                      >
                        <X className="h-3 w-3" />
                        {t('settings.pinnedModels.clearStale', {
                          count: pinned.filter((m) => m.stale).length,
                        })}
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-[11px] text-tertiary/60">
                    {t('settings.pinnedModels.empty')}
                  </p>
                )}

                {/* Add model buttons */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {allModels.length > 0 && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--border,#2a2a2a)] px-2 py-[3px] text-[11px] text-tertiary transition-colors hover:border-[var(--brand-border,rgba(13,148,136,0.25))] hover:bg-[var(--brand-bg,rgba(13,148,136,0.06))] hover:text-[var(--brand-light,#14b8a6)]"
                      onClick={() => { setShowModelPicker(true); setModelSearch('') }}
                    >
                      <Plus className="h-3 w-3" />
                      {t('settings.pinnedModels.addFromApi')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--border,#2a2a2a)] px-2 py-[3px] text-[11px] text-tertiary transition-colors hover:border-[var(--brand-border,rgba(13,148,136,0.25))] hover:bg-[var(--brand-bg,rgba(13,148,136,0.06))] hover:text-[var(--brand-light,#14b8a6)]"
                    onClick={() => { setAddingManual(!addingManual); setManualDraft('') }}
                  >
                    <Plus className="h-3 w-3" />
                    {t('settings.pinnedModels.addManual')}
                  </button>
                </div>

                {/* Manual model input */}
                {addingManual && (
                  <div className="flex gap-1.5 animate-in fade-in slide-in-from-top-1 duration-150">
                    <BrandInput
                      value={manualDraft}
                      onChange={(e) => setManualDraft(e.target.value)}
                      placeholder={t('settings.modelManagement.newModelName')}
                      className="h-8 flex-1 text-[12px]"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleAddManual()
                        if (e.key === 'Escape') setAddingManual(false)
                      }}
                    />
                    <BrandButton variant="outline" className="h-8 px-2 text-[11px]" onClick={() => setAddingManual(false)}>
                      {t('settings.modelManagement.cancel')}
                    </BrandButton>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md px-2.5 h-8 text-[11px] font-medium text-white"
                      style={{ background: 'var(--brand, #0d9488)' }}
                      onClick={handleAddManual}
                    >
                      {t('settings.modelManagement.addModel')}
                    </button>
                  </div>
                )}
              </div>

              {/* Model Picker Dialog */}
              <BrandDialog open={showModelPicker} onOpenChange={setShowModelPicker}>
                <BrandDialogContent className="!max-w-[420px] !w-[420px] !max-h-[70vh] !flex !flex-col !p-0">
                  <BrandDialogHeader>
                    <BrandDialogTitle className="!text-[13px]">
                      {t('settings.pinnedModels.dialogTitle')}
                    </BrandDialogTitle>
                    <BrandDialogClose className="text-tertiary hover:text-primary">
                      <X className="h-4 w-4" />
                    </BrandDialogClose>
                  </BrandDialogHeader>

                  <div className="px-4 py-2 border-b border-border">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-tertiary" />
                      <input
                        type="text"
                        value={modelSearch}
                        onChange={(e) => setModelSearch(e.target.value)}
                        placeholder={t('settings.pinnedModels.searchPlaceholder')}
                        className="flex w-full rounded-md border border-border bg-transparent py-1.5 pl-8 pr-3 text-[12px] focus-visible:outline-none focus-visible:border-[var(--brand-border,rgba(13,148,136,0.25))]"
                        autoFocus
                      />
                    </div>
                  </div>

                  <div className="flex-1 overflow-auto px-2 py-2">
                    {filteredUnpinned.length === 0 ? (
                      <div className="px-3 py-6 text-center text-[12px] text-tertiary">
                        {allModels.length === 0
                          ? t('settings.pinnedModels.noApiModels')
                          : t('settings.pinnedModels.noMatch')}
                      </div>
                    ) : (
                      <div className="space-y-0.5">
                        {filteredUnpinnedWithVision.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left hover:bg-muted transition-colors"
                            onClick={() => {
                              pinModel(LLM_GATEWAY_PROVIDER_TYPE, m.id)
                              setModelSearch('')
                            }}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-[12px] text-secondary">{m.name}</span>
                                {m.hasVision ? (
                                  <Eye
                                    className="h-3 w-3 shrink-0 text-[var(--brand,#0d9488)]"
                                    aria-label={t('topbar.modelSwitcher.visionCapable')}
                                  />
                                ) : null}
                              </div>
                              <div className="truncate text-[10px] text-tertiary font-mono">{m.id}</div>
                            </div>
                            <Plus className="h-3.5 w-3.5 text-tertiary shrink-0 ml-2" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <BrandDialogFooter className="!min-h-0 !py-2 !px-4">
                    <p className="text-[10px] text-tertiary">
                      {t('settings.pinnedModels.dialogHint', { count: filteredUnpinned.length })}
                    </p>
                  </BrandDialogFooter>
                </BrandDialogContent>
              </BrandDialog>

              {/* Rate-limits status */}
              {(rateLimitsResult || rateLimitsError) && (
                <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 space-y-2">
                  {rateLimitsError ? (
                    <p className="text-[11px] text-red-500 break-all">{rateLimitsError}</p>
                  ) : rateLimitsResult ? (
                    [
                      { label: t('settings.gatewayRateLimits.fiveHour'), data: rateLimitsResult.five_hour },
                      { label: t('settings.gatewayRateLimits.week'), data: rateLimitsResult.week },
                    ]
                      .filter((w): w is { label: string; data: RateLimitWindow } => {
                        const d = w.data
                        return (
                          !!d &&
                          typeof d.used === 'number' &&
                          typeof d.limit === 'number' &&
                          typeof d.remaining_percentage === 'number' &&
                          (typeof d.next_reset_at === 'string' || d.next_reset_at === null || d.next_reset_at === undefined)
                        )
                      })
                      .map(({ label, data }) => {
                      const usedPct = Math.max(0, 100 - data.remaining_percentage)
                      const color =
                        usedPct >= 85 ? '#ef4444' : usedPct >= 60 ? '#f59e0b' : 'var(--brand, #0d9488)'
                      return (
                        <div key={label}>
                          <div className="flex items-center justify-between text-[11px] mb-1">
                            <span className="text-secondary">{label}</span>
                            <span className="font-mono text-tertiary">
                              ¥{data.used.toFixed(1)} / ¥{data.limit}
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-border/40 overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{ width: `${usedPct}%`, background: color }}
                            />
                          </div>
                          <div className="text-[10px] text-tertiary/70 mt-0.5">
                            {formatResetTime(data.next_reset_at, t)}
                          </div>
                        </div>
                      )
                    })
                  ) : null}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <BrandButton
                  variant="outline"
                  className="flex-1 h-8 text-[11px]"
                  onClick={handleFetchRateLimits}
                  disabled={rateLimitsLoading}
                >
                  {rateLimitsLoading ? t('settings.gatewayRateLimits.refreshing') : t('settings.gatewayRateLimits.refresh')}
                </BrandButton>
                <BrandButton
                  variant="outline"
                  className="flex-1 h-8 text-[11px]"
                  onClick={handleLogout}
                >
                  {t('settings.gateway.logout')}
                </BrandButton>
              </div>
            </>
          ) : (
            /* ── Inline login flow (no dialog) ── */
            <>
              {/* idle: show the login button */}
              {authState.status === 'idle' && (
                <button
                  type="button"
                  className="w-full inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-[12px] font-medium text-white"
                  style={{ background: 'var(--brand, #0d9488)' }}
                  onClick={handleLogin}
                >
                  {t('settings.gateway.login')}
                </button>
              )}

              {/* requesting: creating session */}
              {authState.status === 'requesting' && (
                <div className="flex items-center justify-center gap-2 py-2 text-[12px] text-secondary">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('settings.gateway.creatingSession')}
                </div>
              )}

              {/* waiting / polling: show user_code */}
              {(authState.status === 'waiting' || authState.status === 'polling') && authState.userCode && (
                <div className="space-y-3">
                  {/* User code */}
                  <div
                    className="rounded-lg border border-[var(--brand-border,rgba(13,148,136,0.25))] p-3 text-center"
                    style={{ background: 'var(--brand-bg, rgba(13,148,136,0.06))' }}
                  >
                    <p className="text-[10px] text-tertiary mb-1.5">{t('settings.gateway.enterCodeHint')}</p>
                    <div className="flex items-center justify-center gap-2">
                      <span className="text-xl font-mono font-bold tracking-[0.15em] text-primary">
                        {authState.userCode}
                      </span>
                      <button
                        type="button"
                        onClick={handleCopyCode}
                        className="text-tertiary hover:text-primary transition-colors"
                        title={t('settings.gateway.copy')}
                      >
                        {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>

                  {/* Verification link (re-open if user missed it) */}
                  {authState.verificationUri && (
                    <a
                      href={
                        authState.verificationUri.includes('user_code=')
                          ? authState.verificationUri
                          : `${authState.verificationUri}${
                              authState.verificationUri.includes('?') ? '&' : '?'
                            }user_code=${encodeURIComponent(authState.userCode || '')}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium text-white"
                      style={{ background: 'var(--brand, #0d9488)' }}
                    >
                      <ExternalLink className="h-3 w-3" />
                      {t('settings.gateway.openAuthPage')}
                    </a>
                  )}

                  {/* Polling status */}
                  {authState.status === 'polling' && (
                    <div className="flex items-center justify-center gap-1.5 text-[11px] text-tertiary">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t('settings.gateway.waitingForAuth')}
                    </div>
                  )}
                </div>
              )}

              {/* success */}
              {authState.status === 'success' && (
                <div className="flex items-center justify-center gap-2 py-2 text-[12px] font-medium text-green-500">
                  <CheckCircle2 className="h-5 w-5" />
                  {t('settings.gateway.loginSuccess')}
                </div>
              )}

              {/* error */}
              {authState.status === 'error' && (
                <div className="space-y-2">
                  <div className="flex items-start gap-2 py-1">
                    <XCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[12px] font-medium text-secondary">{t('settings.gateway.loginFailed')}</p>
                      <p className="text-[11px] text-secondary">{authState.error}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="w-full inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-[12px] font-medium text-white"
                    style={{ background: 'var(--brand, #0d9488)' }}
                    onClick={() => { setAuthState({ status: 'idle' }); handleLogin() }}
                  >
                    {t('settings.gateway.retry')}
                  </button>
                </div>
              )}

              <p className="text-[10px] text-tertiary">
                {t('settings.gateway.authHint')}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// Main ProviderManager Component
// =============================================================================

export function ProviderManager() {
  const t = useT()
  const { customProviders } = useSettingsStore()
  const [expandedProvider, setExpandedProvider] = useState<LLMProviderType | null>(null)
  const [showNewProvider, setShowNewProvider] = useState(false)
  // Locale drives the category ordering (zh: Chinese providers first,
  // others: international first). Subscribed reactively.
  const locale = useI18nStore((s) => s.locale)

  // `customProviders` is intentionally listed as a dep even though
// getProvidersByCategory() doesn't reference it directly — it reads from
// the module-level DYNAMIC_PROVIDER_METAS map, which is updated whenever
// the customProviders store slice changes.  Without this dep, the memo
// would return a stale provider list and the UI wouldn't refresh when
// users add/remove custom providers.
const groupedProviders = useMemo(
  () => getProvidersByCategory(),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [customProviders]
)

  const toggleProvider = useCallback(
    (type: LLMProviderType) => {
      setExpandedProvider((prev) => (prev === type ? null : type))
    },
    [],
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-secondary">
          {t('settings.providerManager.title')}
        </label>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-2.5 h-7 text-[11px] font-medium text-white"
          style={{ background: 'var(--brand, #0d9488)' }}
          onClick={() => setShowNewProvider(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('settings.modelManagement.add')}
        </button>
      </div>

      {/* New Provider Form */}
      {showNewProvider && (
        <NewProviderForm onClose={() => setShowNewProvider(false)} />
      )}

      {/* LLM Gateway Card (坚果云 AI) */}
      {isLLMGatewayConfigured() && (
        <LLMGatewayCard
          isExpanded={expandedProvider === LLM_GATEWAY_PROVIDER_TYPE}
          onToggle={() => toggleProvider(LLM_GATEWAY_PROVIDER_TYPE)}
        />
      )}

      {/* Provider Cards by Category — order is locale-aware (Chinese
          providers first for zh users, international first otherwise).
          Subscribing to locale (not getState) so switching language
          re-renders the list immediately. */}
      {categoryOrderForLocale(locale).map((category) => {
        const providers = groupedProviders[category]
          .filter(({ type }) => type !== LLM_GATEWAY_PROVIDER_TYPE)
        // Hide empty groups entirely — including custom. Previously custom
        // was exempted, which rendered a lone "Custom" header with no cards
        // when the user hadn't added any custom provider yet.
        if (providers.length === 0) return null
        return (
          <div key={category} className="space-y-1">
            <div className="px-1 text-[11px] font-semibold text-tertiary uppercase tracking-wider">
              {t(`settings.categories.${category}` as const)}
            </div>
            {providers.map(({ type, meta }) => (
              <ProviderCard
                key={type}
                providerType={type}
                // Locale-aware display name for the Chinese-brand providers
                // (zh: 原中文品牌 / others: company pinyin/English brand).
                // Falls back to the static meta.displayName for providers
                // without an i18n mapping (OpenAI, Anthropic, ...).
                displayName={localizedProviderName(t, type, meta.displayName)}
                website={meta.website}
                isCustom={isCustomProviderType(type)}
                customProvider={
                  isCustomProviderType(type)
                    ? customProviders.find((p) => p.id === type)
                    : undefined
                }
                isExpanded={expandedProvider === type}
                onToggle={() => toggleProvider(type)}
              />
            ))}
          </div>
        )
      })}

    </div>
  )
}
