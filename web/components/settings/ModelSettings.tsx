/**
 * ModelSettings - LLM 设置面板
 *
 * 拆分为两个子区域：
 * 1. 默认模型选择 (Select) - 选择当前使用的服务商和模型
 * 2. 服务商管理 (ProviderManager) - 管理所有服务商的配置
 *
 * 高级参数和 Token 统计保留在此组件中
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Code,
  PenTool,
  Brain,
  ScanEye,
  Zap,
  BookOpen,
  Info,
  ChevronDown,
  RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'
import { useSettingsStore } from '@/store/settings.store'
import type { ExtendedThinkingLevel } from '@/agent/llm/pi-ai-custom-openai-fetch'
import type { LLMProviderType, ModelCapability } from '@/agent/providers/types'
import { useT } from '@/i18n'
import { resolveModelOutputCap } from '@/agent/llm/pi-ai-model-resolver'
import { BrandSlider } from '@creatorweave/ui'
import { BrandSwitch } from '@creatorweave/ui'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@creatorweave/ui'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
} from '@creatorweave/ui'
import { ProviderManager } from './ProviderManager'

// =============================================================================
// Constants
// =============================================================================

const CAPABILITY_COLORS: Record<ModelCapability, string> = {
  code: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  writing: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  reasoning: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  vision: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  fast: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
  'long-context': 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
}

const CAPABILITY_ICONS: Record<ModelCapability, typeof Code> = {
  code: Code,
  writing: PenTool,
  reasoning: Brain,
  vision: ScanEye,
  fast: Zap,
  'long-context': BookOpen,
}

// =============================================================================
// Capability Badge (shared)
// =============================================================================

export function CapabilityBadge({ capability }: { capability: ModelCapability }) {
  const t = useT()
  const color = CAPABILITY_COLORS[capability]
  const Icon = CAPABILITY_ICONS[capability]
  const label = t(`settings.capabilities.${capability}` as const)

  if (!color || !Icon) return null

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${color}`}
    >
      <Icon className="h-2.5 w-2.5" />
      {label}
    </span>
  )
}

// =============================================================================
// Token Stats
// =============================================================================

interface TokenStats {
  totalTokens: number
  promptTokens: number
  completionTokens: number
  requestCount: number
}

function useTokenStats(): TokenStats {
  const [stats, setStats] = useState<TokenStats>({
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    requestCount: 0,
  })

  useEffect(() => {
    try {
      const stored = localStorage.getItem('bfosa-token-stats')
      if (stored) {
        setStats(JSON.parse(stored))
      }
    } catch {
      // ignore parse errors
    }
  }, [])

  return stats
}

function TokenStatsDisplay() {
  const t = useT()
  const stats = useTokenStats()

  if (stats.requestCount === 0) {
    return (
      <div className="rounded-lg border border bg-muted p-3 dark:border-border dark:bg-muted/50">
        <div className="flex items-center gap-2 text-sm text-tertiary dark:text-tertiary">
          <Info className="h-4 w-4" />
          <span>{t('settings.tokenStats.noUsage')}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border p-3 dark:border-border">
          <p className="text-xs text-tertiary dark:text-tertiary">{t('settings.tokenStats.totalTokens')}</p>
          <p className="mt-1 text-lg font-semibold text-secondary dark:text-secondary">
            {stats.totalTokens.toLocaleString()}
          </p>
        </div>
        <div className="rounded-lg border border p-3 dark:border-border">
          <p className="text-xs text-tertiary dark:text-tertiary">{t('settings.tokenStats.requestCount')}</p>
          <p className="mt-1 text-lg font-semibold text-secondary dark:text-secondary">
            {stats.requestCount.toLocaleString()}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border p-3 dark:border-border">
          <p className="text-xs text-tertiary dark:text-tertiary">{t('settings.tokenStats.inputTokens')}</p>
          <p className="mt-1 text-sm font-medium text-secondary dark:text-secondary">
            {stats.promptTokens.toLocaleString()}
          </p>
        </div>
        <div className="rounded-lg border border p-3 dark:border-border">
          <p className="text-xs text-tertiary dark:text-tertiary">{t('settings.tokenStats.outputTokens')}</p>
          <p className="mt-1 text-sm font-medium text-secondary dark:text-secondary">
            {stats.completionTokens.toLocaleString()}
          </p>
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// Main ModelSettings Component
// =============================================================================

interface ModelSettingsProps {
  /** Whether the parent dialog is open (triggers key reload) */
  open?: boolean
}

export function ModelSettings({ open }: ModelSettingsProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const {
    providerType,
    modelName,
    temperature,
    maxIterations,
    compressionAbsoluteCapEnabled,
    compressionAbsoluteCap,
    enableThinking,
    thinkingLevel,
    setTemperature,
    setMaxIterations,
    setCompressionAbsoluteCapEnabled,
    setCompressionAbsoluteCap,
    setEnableThinking,
    setThinkingLevel,
    switchProviderAndModel,
    getAvailableProviders,
    _providerRefreshVersion: providerRefreshVersion,
  } = useSettingsStore()
  const t = useT()

  const [showAdvanced, setShowAdvanced] = useState(false)
  // Cap input keeps a local draft while typing: the store clamps to 32K–1M, so
  // committing per keystroke would rewrite "3" into "32000" mid-edit.
  const [capDraft, setCapDraft] = useState<string | null>(null)
  const [referenceRefreshing, setReferenceRefreshing] = useState(false)
  const [providers, setProviders] = useState<
    Array<{
      providerType: LLMProviderType
      displayName: string
      models: Array<{ id: string; name: string }>
      providerKey: string
    }>
  >([])

  // Load available providers
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const result = await getAvailableProviders()
        // Skip a superseded run (current:false — a newer getAvailableProviders()
        // started while this one was awaiting): applying its stale snapshot
        // would let an older overlapping run that resolves late overwrite the
        // newer run's provider data (Sourcery: "Superseded model lists remain
        // selectable"). Same gate WorkspaceLayout uses.
        if (!cancelled && result.runCurrent !== false && result.every((p) => p.current)) {
          setProviders(result)
        }
      } catch {
        // ignore
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [getAvailableProviders, open, providerRefreshVersion])

  // Build flat options for Select: value = "providerType:modelId"
  const currentSelectValue = `${providerType}:${modelName}`

  const handleSelectChange = useCallback(
    (value: string) => {
      const idx = value.indexOf(':')
      if (idx < 0) return
      const pType = value.slice(0, idx) as LLMProviderType
      const mId = value.slice(idx + 1)
      switchProviderAndModel(pType, mId)
    },
    [switchProviderAndModel],
  )

  // ── Force-refresh the OpenRouter model reference (pricing / context / vision)
  // Bypasses the daily auto-refresh throttle (refreshOpenRouterModelsNow
  // persists a fresh timestamp on success, so the next boot skips the fetch).
  // Concurrency is safe: the module dedupes in-flight refreshes, and the
  // disabled state keeps the button inert while one is running.
  const handleRefreshReference = useCallback(async () => {
    setReferenceRefreshing(true)
    try {
      const { refreshOpenRouterModelsNow } = await import('@/agent/providers/openrouter-pricing')
      const ok = await refreshOpenRouterModelsNow()
      if (ok) {
        toast.success(t('settings.defaultModel.refreshReferenceSuccess'))
      } else {
        toast.error(t('settings.defaultModel.refreshReferenceFailed'))
      }
    } catch {
      toast.error(t('settings.defaultModel.refreshReferenceFailed'))
    } finally {
      setReferenceRefreshing(false)
    }
  }, [t])

  // Convert temperature (0-1) to slider value (0-100)
  const temperatureValue = Math.round(temperature * 100)

  // Effective output cap is determined by the model (pi-ai catalog value or the
  // 64K fallback), not by user settings — shown read-only below.
  const maxTokensDisplay = useMemo(
    () => resolveModelOutputCap(providerType, modelName),
    [providerType, modelName]
  )
  const handleTemperatureChange = useCallback(
    (value: number[]) => {
      setTemperature(value[0] / 100)
    },
    [setTemperature]
  )
  const handleMaxIterationsChange = useCallback(
    (value: number[]) => {
      setMaxIterations(value[0] || 20)
    },
    [setMaxIterations]
  )

  return (
    <div ref={rootRef} className="space-y-6">
      {/* ── Section 1: Default Model Selection ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-secondary">
            {t('settings.defaultModel.title')}
          </label>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleRefreshReference}
                  disabled={referenceRefreshing}
                  className="text-tertiary hover:text-primary disabled:opacity-50"
                  aria-label={t('settings.defaultModel.refreshReference')}
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${referenceRefreshing ? 'animate-spin' : ''}`}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t('settings.defaultModel.refreshReference')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <Select value={currentSelectValue} onValueChange={handleSelectChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t('topbar.modelSwitcher.unavailable')}>
              {currentSelectValue && (() => {
                const idx = currentSelectValue.indexOf(':')
                const pType = currentSelectValue.slice(0, idx) as LLMProviderType
                const mId = currentSelectValue.slice(idx + 1)
                const prov = providers.find((p) => p.providerType === pType)
                const mod = prov?.models.find((m) => m.id === mId)
                return mod ? `${prov?.displayName} / ${mod.name}` : mId
              })()}
            </SelectValue>
          </SelectTrigger>
          <SelectContent container={rootRef.current} className="max-h-[280px]">
            {providers.map((provider) => (
              <SelectGroup key={provider.providerKey}>
                <SelectLabel>{provider.displayName}</SelectLabel>
                {provider.models.map((model) => (
                  <SelectItem
                    key={`${provider.providerKey}:${model.id}`}
                    value={`${provider.providerType}:${model.id}`}
                  >
                    {model.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ── Section 2: Provider Management ── */}
      <div className="border-t border-border/40 pt-4">
        <ProviderManager />
      </div>

      {/* ── Section 3: Advanced Parameters (collapsible) ── */}
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex w-full items-center gap-2 text-sm font-medium text-secondary hover:text-secondary dark:text-secondary dark:hover:text-muted"
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
          />
          {t('settings.advancedParameters')}
        </button>

        {showAdvanced && (
          <div className="space-y-4 rounded-lg border border p-3 dark:border-border">
            {/* Temperature */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-secondary">
                  {t('settings.temperature')}
                </label>
                <span className="text-sm text-secondary">{temperature}</span>
              </div>
              <BrandSlider
                value={[temperatureValue]}
                onValueChange={handleTemperatureChange}
                max={100}
                step={1}
              />
              <div className="flex justify-between text-[10px] text-tertiary">
                <span>{t('settings.temperatureOptions.precise')}</span>
                <span>{t('settings.temperatureOptions.creative')}</span>
              </div>
            </div>

            {/* Output Token Cap (read-only display)
                Not configurable: pi-agent-core carves the thinking budget out of
                this cap, so a small user value (e.g. 4096) would silently truncate
                long replies on thinking models. The cap always follows the model's
                catalog value (fallback 64K). */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-secondary">{t('settings.maxTokens')}</label>
                <span className="text-sm text-tertiary tabular-nums">
                  {maxTokensDisplay.toLocaleString()}
                </span>
              </div>
            </div>

            {/* Max Iterations */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-secondary">{t('settings.maxIterations')}</label>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-sm font-medium tabular-nums ${
                      maxIterations === 0 ? 'text-brand-500' : 'text-secondary'
                    }`}
                  >
                    {maxIterations === 0 ? '∞' : maxIterations}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-tertiary">{t('settings.maxIterationsUnlimited')}</span>
                    <BrandSwitch
                      checked={maxIterations === 0}
                      onCheckedChange={(checked) => setMaxIterations(checked ? 0 : 20)}
                    />
                  </div>
                </div>
              </div>
              {maxIterations !== 0 && (
                <BrandSlider
                  value={[maxIterations]}
                  onValueChange={handleMaxIterationsChange}
                  min={1}
                  max={100}
                  step={1}
                />
              )}
              <p className="text-[10px] text-tertiary">
                {maxIterations === 0
                  ? t('settings.maxIterationsUnlimitedHint')
                  : t('settings.maxIterationsHint')}
              </p>
            </div>

            {/* Context compression: absolute cap on top of the ratio trigger */}
            <div className="space-y-2.5 border-t border-border/40 pt-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-secondary">
                  {t('settings.contextCompression')}
                </label>
              </div>
              <p className="text-[10px] text-tertiary">
                {t('settings.contextCompressionHint')}
              </p>

              <div className="flex items-center justify-between">
                <span className="text-xs text-tertiary">{t('settings.compressionRatioTrigger')}</span>
                <span className="text-xs text-tertiary tabular-nums">
                  {t('settings.compressionRatioFixed')}
                </span>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-secondary">
                    {t('settings.compressionAbsoluteCap')}
                  </p>
                  <p className="text-[10px] text-tertiary">
                    {t('settings.compressionAbsoluteCapHint')}
                  </p>
                </div>
                <BrandSwitch
                  checked={compressionAbsoluteCapEnabled}
                  onCheckedChange={setCompressionAbsoluteCapEnabled}
                />
              </div>

              {compressionAbsoluteCapEnabled && (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={32000}
                    max={1000000}
                    step={10000}
                    value={capDraft ?? compressionAbsoluteCap}
                    onChange={(e) => setCapDraft(e.target.value)}
                    onBlur={() => {
                      if (capDraft !== null) setCompressionAbsoluteCap(Number(capDraft))
                      setCapDraft(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                    }}
                    className="h-8 w-32 rounded-md border border-input bg-background px-2 text-sm tabular-nums text-secondary"
                  />
                  <span className="text-xs text-tertiary">
                    tokens ≈ {Math.round(compressionAbsoluteCap / 1000)}K
                  </span>
                </div>
              )}

              <p className="text-[10px] text-tertiary">
                {t('settings.compressionTriggerExplain')}
              </p>

              {!compressionAbsoluteCapEnabled && (
                <p className="rounded-md border border-warning/30 bg-warning-bg px-2 py-1.5 text-[10px] text-warning">
                  {t('settings.compressionAbsoluteCapOffWarning')}
                </p>
              )}
            </div>

            {/* Thinking Mode */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Brain className="h-4 w-4 text-secondary" />
                  <label className="text-sm font-medium text-secondary">{t('settings.thinkingMode')}</label>
                </div>
                <BrandSwitch
                  checked={enableThinking}
                  onCheckedChange={setEnableThinking}
                />
              </div>

              {enableThinking && (
                <div className="space-y-2.5 pl-6">
                  <div className="relative">
                    {/* Intensity gradient track */}
                    <div className="h-1.5 rounded-full bg-gradient-to-r from-primary-100 via-primary-500 to-primary-600 dark:from-primary-800 dark:via-primary-600 dark:to-primary-500" />
                    {/* Level pills */}
                    <div className="mt-2 flex gap-1 overflow-x-auto">
                      {([
                        { value: 'minimal' as ExtendedThinkingLevel, label: t('settings.thinkingLevels.minimal') },
                        { value: 'low' as ExtendedThinkingLevel, label: t('settings.thinkingLevels.low') },
                        { value: 'medium' as ExtendedThinkingLevel, label: t('settings.thinkingLevels.medium') },
                        { value: 'high' as ExtendedThinkingLevel, label: t('settings.thinkingLevels.high') },
                        { value: 'xhigh' as ExtendedThinkingLevel, label: t('settings.thinkingLevels.xhigh') },
                        { value: 'max' as ExtendedThinkingLevel, label: t('settings.thinkingLevels.max') },
                      ]).map(({ value, label }) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setThinkingLevel(value)}
                          className={`flex-1 whitespace-nowrap rounded-md py-1.5 text-[11px] font-medium transition-all ${
                            thinkingLevel === value
                              ? 'bg-primary-600 text-white shadow-sm dark:bg-primary-500'
                              : 'bg-neutral-50 text-tertiary hover:bg-neutral-100 hover:text-secondary dark:bg-neutral-800/60 dark:text-muted dark:hover:bg-neutral-700 dark:hover:text-secondary'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="mt-1.5 flex justify-between px-0.5">
                      <span className="text-[10px] text-tertiary">{t('settings.thinkingModeFast')}</span>
                      <span className="text-[10px] text-tertiary">{t('settings.thinkingModeDeep')}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Token Usage Stats ── */}
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-secondary">{t('settings.tokenStats.title')}</h4>
        <TokenStatsDisplay />
      </div>
    </div>
  )
}
