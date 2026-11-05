/**
 * InlineModelSelector - 设置面板内使用的模型选择器
 *
 * 与顶栏 ModelQuickSwitch 不同，这个组件不使用 Popover/Portal，
 * 直接内联展示列表，避免 Radix Dialog modal 焦点陷阱冲突。
 */

import { useEffect, useMemo, useState } from 'react'
import { Check, Sparkles, ChevronDown, ChevronRight, PencilLine } from 'lucide-react'
import { useSettingsStore } from '@/store/settings.store'
import type { LLMProviderType } from '@/agent/providers/types'
import {
  getModelsForProvider,
  isCustomProviderType,
  getProviderMeta,
} from '@/agent/providers/types'
import { getModelContextWindow } from '@/agent/providers/model-store'
import type { ModelInfo } from '@/agent/providers/types'
import { useT } from '@/i18n'
import { BrandInput, BrandButton } from '@creatorweave/ui'
import { CapabilityBadge } from './ModelSettings'

// =============================================================================
// Types
// =============================================================================

interface ProviderWithModels {
  providerType: LLMProviderType
  displayName: string
  models: ModelInfo[]
}

// =============================================================================
// Component
// =============================================================================

export function InlineModelSelector() {
  const t = useT()
  const {
    providerType,
    modelName,
    hasApiKey,
    switchProviderAndModel,
    getAvailableProviders,
    _providerRefreshVersion: providerRefreshVersion,
  } = useSettingsStore()

  const [providers, setProviders] = useState<ProviderWithModels[]>([])
  const [loading, setLoading] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [manualInput, setManualInput] = useState(false)
  const [manualModelName, setManualModelName] = useState('')

  // 加载有 API Key 的服务商
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const result = await getAvailableProviders()
        // Skip a superseded run (current:false — a newer getAvailableProviders()
        // started while this one was awaiting): applying its stale snapshot
        // would let an older overlapping run that resolves late overwrite the
        // newer run's provider data (Sourcery: "Superseded model lists remain
        // selectable"). Same gate WorkspaceLayout uses.
        if (!cancelled && result.runCurrent !== false && result.every((p) => p.current)) {
          const withModels: ProviderWithModels[] = result.map((p) => {
            const staticModels = getModelsForProvider(p.providerType)
            const allModels = mergeModelLists(
              p.models.map((m) => ({ id: m.id, name: m.name })),
              staticModels,
              p.providerType,
            )
            return {
              providerType: p.providerType,
              displayName: p.displayName,
              models: allModels,
            }
          })
          // 默认展开当前服务商
          const initialCollapsed: Record<string, boolean> = {}
          for (const p of withModels) {
            initialCollapsed[p.providerType] = p.providerType !== providerType
          }
          setCollapsed(initialCollapsed)
          setProviders(withModels)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [getAvailableProviders, providerType, providerRefreshVersion])

  const currentProvider = useMemo(
    () => providers.find((p) => p.providerType === providerType),
    [providers, providerType],
  )

  const selectedModel = useMemo(
    () => currentProvider?.models.find((m) => m.id === modelName),
    [currentProvider, modelName],
  )

  const handleSelect = (pType: LLMProviderType, nextModelName: string) => {
    switchProviderAndModel(pType, nextModelName)
  }

  const handleManualConfirm = () => {
    if (manualModelName.trim()) {
      switchProviderAndModel(providerType, manualModelName.trim())
      setManualInput(false)
    }
  }

  const toggleProvider = (pType: LLMProviderType) => {
    setCollapsed((prev) => ({ ...prev, [pType]: !prev[pType] }))
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-secondary">
          {t('settings.defaultModel.title')}
        </label>
        <span className="text-[11px] text-tertiary">{t('settings.defaultModel.description')}</span>
      </div>

      {/* 当前选择状态 */}
      <div className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2">
        <Sparkles className="h-4 w-4 shrink-0 text-[var(--brand,#0d9488)]" />
        <span className="text-sm font-medium text-secondary truncate">
          {!hasApiKey || !providerType || !modelName
            ? t('topbar.modelSwitcher.unavailable')
            : `${currentProvider?.displayName || getProviderMeta(providerType)?.displayName || providerType} / ${selectedModel?.name || modelName}`}
        </span>
      </div>

      {/* 当前模型 capabilities */}
      {selectedModel && !isCustomProviderType(providerType) && (
        <div className="flex flex-wrap gap-1.5">
          {selectedModel.capabilities.map((cap) => (
            <CapabilityBadge key={cap} capability={cap} />
          ))}
        </div>
      )}

      {/* 手动输入入口 */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            setManualInput(!manualInput)
            if (!manualInput) setManualModelName(modelName)
          }}
          className="inline-flex items-center gap-1 text-[11px] text-tertiary hover:text-[var(--brand-light,#14b8a6)] transition-colors"
        >
          <PencilLine className="h-3 w-3" />
          {t('settings.defaultModel.manualInput')}
        </button>
      </div>

      {/* 手动输入模型名 */}
      {manualInput && (
        <div className="flex gap-2 animate-in fade-in slide-in-from-top-1 duration-150">
          <BrandInput
            value={manualModelName}
            onChange={(e) => setManualModelName(e.target.value)}
            placeholder={t('settings.defaultModel.manualPlaceholder')}
            className="h-9 text-sm"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleManualConfirm()
              if (e.key === 'Escape') setManualInput(false)
            }}
          />
          <BrandButton variant="primary" className="h-9 px-3 text-xs" onClick={handleManualConfirm}>
            {t('settings.save')}
          </BrandButton>
          <BrandButton variant="outline" className="h-9 px-3 text-xs" onClick={() => setManualInput(false)}>
            {t('settings.modelManagement.cancel')}
          </BrandButton>
        </div>
      )}

      {/* 服务商列表 */}
      <div className="space-y-1">
        <div className="px-1 text-[11px] font-semibold text-tertiary">
          {t('settings.defaultModel.selectModel')}
        </div>
        {loading && (
          <div className="py-4 text-center text-xs text-tertiary">{t('common.loading')}</div>
        )}
        {providers.map((provider) => {
          const isCurrentProvider = provider.providerType === providerType
          const isCollapsed = collapsed[provider.providerType] ?? true

          return (
            <div key={provider.providerType} className="rounded-lg border border-border/60 overflow-hidden">
              <button
                type="button"
                onClick={() => toggleProvider(provider.providerType)}
                className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-2">
                  {isCollapsed ? (
                    <ChevronRight className="h-3.5 w-3.5 text-tertiary" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-tertiary" />
                  )}
                  <span className="text-[13px] font-semibold text-secondary">{provider.displayName}</span>
                  {isCurrentProvider && (
                    <span className="text-[10px] text-[var(--brand-light,#14b8a6)]">●</span>
                  )}
                </div>
              </button>

              {!isCollapsed && (
                <div className="border-t border-border/40 px-2 py-1.5 space-y-0.5">
                  {provider.models.map((model) => {
                    const selected = isCurrentProvider && model.id === modelName
                    return (
                      <button
                        key={`${provider.providerType}:${model.id}`}
                        type="button"
                        onClick={() => handleSelect(provider.providerType, model.id)}
                        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted transition-colors"
                      >
                        <span className="truncate">{model.name}</span>
                        {selected ? (
                          <Check className="h-4 w-4 shrink-0 text-[var(--brand,#0d9488)]" />
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
        {providers.length === 0 && !loading && (
          <div className="py-6 text-center text-xs text-tertiary">
            {t('settings.defaultModel.noProviders')}
          </div>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// Helpers
// =============================================================================

function mergeModelLists(
  dynamicOrSimple: Array<{ id: string; name: string }>,
  staticModels: ModelInfo[],
  providerType: LLMProviderType,
): ModelInfo[] {
  const seen = new Set<string>()
  const result: ModelInfo[] = []

  for (const m of staticModels) {
    if (!seen.has(m.id)) {
      seen.add(m.id)
      result.push(m)
    }
  }

  for (const m of dynamicOrSimple) {
    if (!seen.has(m.id)) {
      seen.add(m.id)
      result.push({
        id: m.id,
        name: m.name,
        capabilities: ['code'],
        contextWindow: getModelContextWindow(providerType, m.id),
      })
    }
  }

  return result
}
