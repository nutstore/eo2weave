// ============================================================
// SkillDiscover — Skill Store 发现面板
//
// 拉取 /skills/manifest.json，展示可安装的 skill 卡片网格。
// 一键安装：调用 installSkillFromUrl，复用现有 ZIP 导入管道。
// 设计：minimalist，沿用 SkillsManager 风格。
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Download, Check, AlertCircle, Trash2 } from 'lucide-react'
import { BrandButton } from '@creatorweave/ui'
import { useT, useLocale } from '@/i18n'
import { useSkillsStore } from '@/store/skills.store'
import {
  fetchSkillStoreManifest,
  annotateInstalled,
  scanInstalledDirNames,
  installSkillFromUrl,
  invalidateSkillStoreCache,
  selectLocalizedDescription,
  type SkillStoreEntry,
  type InstallProgress,
} from '@/skills/skill-store'
import { SkillSearchInput, SkillSegmentFilter, SkillRefreshButton } from './SkillToolbar'
import type { SkillFilterOption } from './SkillToolbar'

const CATEGORY_COLORS: Record<string, string> = {
  general: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  coding: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  data: 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  writing: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  design: 'bg-pink-50 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300',
}

interface SkillDiscoverProps {
  /** 导入成功后回调（通常用于刷新 SkillsManager 的列表） */
  onInstalled?: () => void
}

// Respect users who prefer reduced motion: pause spinner/pulse animations
// while preserving the visual state (so the user still knows something is loading).
const REDUCED_MOTION_CSS = `
@media (prefers-reduced-motion: reduce) {
  .animate-spin,
  .animate-pulse {
    animation: none !important;
  }
}
`

export function SkillDiscover({ onInstalled }: SkillDiscoverProps) {
  const t = useT()
  const [locale] = useLocale()
  const bumpScanVersion = useSkillsStore((s) => s.bumpSkillsScanVersion)

  const [manifest, setManifest] = useState<SkillStoreEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [query, setQuery] = useState('')
  const [displayCount, setDisplayCount] = useState(10)
  const [filter, setFilter] = useState<'all' | 'uninstalled' | 'installed'>('all')
  // Holds any pending progress-dismissal timer so we can cancel it on unmount
  // (otherwise setState would fire after the component is gone).
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
  }, [])

  const loadManifest = async (force = false) => {
    // Only show loading spinner on explicit refresh (force=true).
    // First load stays completely silent — no empty→loading→populated flash.
    if (force) setLoading(true)
    setError(null)
    if (force) invalidateSkillStoreCache()
    try {
      const data = await fetchSkillStoreManifest({ force })
      // Scan OPFS directly to avoid store-staleness races after fresh installs.
      const installed = await scanInstalledDirNames()
      setManifest(annotateInstalled(data.skills, installed))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadManifest(false)
  }, [])

  const handleInstall = async (entry: SkillStoreEntry) => {
    await runOperation(entry, 'install')
  }

  const handleUninstall = async (entry: SkillStoreEntry) => {
    await runOperation(entry, 'uninstall')
  }

  /**
   * Shared driver for install / uninstall. Both ops follow the same shape:
   *   1. Show progress (operation-specific message)
   *   2. Run the op (network or store)
   *   3. Re-annotate from OPFS and patch manifest
   *   4. Show success / error toast
   */
  async function runOperation(
    entry: SkillStoreEntry,
    op: 'install' | 'uninstall',
  ): Promise<void> {
    if (installing) return
    setInstalling(entry.dirName)
    const phasePreparing = op === 'install' ? 'progressPreparing' : 'progressUninstalling'
    const phaseDone = op === 'install' ? 'progressInstallDone' : 'progressUninstallDone'
    const phaseFailed = op === 'install' ? 'progressInstallFailed' : 'progressUninstallFailed'
    setProgress({ phase: 'fetching', message: t(`skills.discover.${phasePreparing}`) })
    try {
      if (op === 'install') {
        await installSkillFromUrl(entry.zipUrl, setProgress)
      } else {
        // Store keys user skills by `user:<dirName>`. deleteSkill handles the
        // OPFS removal and bumps the scan version automatically.
        const skillsStore = useSkillsStore.getState()
        await skillsStore.deleteSkill(`user:${entry.dirName}`)
      }
      // Re-annotate from OPFS (the source of truth).
      const installed = await scanInstalledDirNames()
      setManifest((prev) =>
        prev
          ? prev.map((e) =>
              e.dirName === entry.dirName ? { ...e, installed: installed.has(e.dirName) } : e,
            )
          : null,
      )
      bumpScanVersion()
      onInstalled?.()
      setProgress({ phase: 'done', message: t(`skills.discover.${phaseDone}`) })
    } catch (err) {
      setProgress({
        phase: 'error',
        message: (err as Error).message || t(`skills.discover.${phaseFailed}`),
      })
    } finally {
      setInstalling(null)
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = setTimeout(() => setProgress(null), 2000)
    }
  }

  // Filter by query (case-insensitive across name/description/tags), then by install state.
  // Search runs against the LOCALIZED description for the active locale, plus
  // the base description so English keywords keep matching in every locale
  // (#139 review: store ignores translated descriptions).
  const filteredSkills = useMemo(() => {
    if (!manifest) return null
    const q = query.trim().toLowerCase()
    let result = manifest
    if (q) {
      result = result.filter((entry) => {
        const haystack = [
          entry.name,
          selectLocalizedDescription(entry, locale),
          entry.description,
          ...entry.tags,
          entry.category,
        ]
          .join(' ')
          .toLowerCase()
        return haystack.includes(q)
      })
    }
    if (filter === 'installed') result = result.filter((e) => e.installed)
    else if (filter === 'uninstalled') result = result.filter((e) => !e.installed)
    return result
  }, [manifest, query, filter, locale])

  // Reset display count when search/filter changes (avoid stale pagination state).
  useEffect(() => {
    setDisplayCount(10)
  }, [query, filter])

  const visibleSkills = useMemo(
    () => (filteredSkills ? filteredSkills.slice(0, displayCount) : null),
    [filteredSkills, displayCount],
  )

  const groupedSkills = useMemo(() => {
    if (!visibleSkills) return null
    const groups: Record<string, SkillStoreEntry[]> = {}
    for (const entry of visibleSkills) {
      const cat = entry.category || 'general'
      if (!groups[cat]) groups[cat] = []
      groups[cat].push(entry)
    }
    return groups
  }, [visibleSkills])

  const remaining = filteredSkills ? Math.max(0, filteredSkills.length - displayCount) : 0

  // Counts for the install-state filter (live counts from current manifest snapshot).
  const counts = manifest
    ? {
        all: manifest.length,
        uninstalled: manifest.filter((e) => !e.installed).length,
        installed: manifest.filter((e) => e.installed).length,
      }
    : { all: 0, uninstalled: 0, installed: 0 }

  const filterOptions: SkillFilterOption[] = [
    { value: 'all', label: t('skills.discover.filterAll'), count: counts.all },
    { value: 'uninstalled', label: t('skills.discover.filterUninstalled'), count: counts.uninstalled },
    { value: 'installed', label: t('skills.discover.filterInstalled'), count: counts.installed },
  ]

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: REDUCED_MOTION_CSS }} />
      <div className="space-y-4">
      {/* Toolbar — search + filter + refresh in one row */}
      <div className="flex items-center gap-2">
        <SkillSearchInput
          value={query}
          onChange={setQuery}
          placeholder={t('skills.discover.searchPlaceholder')}
          ariaLabel={t('skills.discover.searchAriaLabel')}
        />
        <SkillSegmentFilter
          value={filter}
          onChange={(v) => setFilter(v as typeof filter)}
          options={filterOptions}
        />
        <SkillRefreshButton
          onClick={() => void loadManifest(true)}
          disabled={loading}
          label={t('skills.discover.checkUpdatesTitle')}
          ariaLabel={t('skills.discover.checkUpdatesAria')}
        />
      </div>

      {/* Error */}
      {error && (
        <StatusBanner tone="error" icon={<AlertCircle aria-hidden="true" />}>
          <div className="flex-1">
            <div className="font-medium">{t('skills.discover.loadFailed')}</div>
            <div className="opacity-80">{error}</div>
          </div>
        </StatusBanner>
      )}

      {/* Progress */}
      {progress && (
        <StatusBanner
          tone={progress.phase === 'error' ? 'error' : 'info'}
          icon={
            progress.phase === 'error' ? (
              <AlertCircle aria-hidden="true" />
            ) : progress.phase === 'done' ? (
              <Check aria-hidden="true" />
            ) : (
              <Loader2 aria-hidden="true" />
            )
          }
          busy={progress.phase !== 'error' && progress.phase !== 'done'}
        >
          <span className="flex-1">{progress.message}</span>
          {progress.bytesTotal && progress.bytesTotal > 0 && progress.phase === 'fetching' && (
            <span
              className="text-[10px] opacity-60"
              aria-label={t('skills.discover.progressDownloadPercent', { percent: Math.round((progress.bytesLoaded! / progress.bytesTotal) * 100) })}
            >
              {Math.round((progress.bytesLoaded! / progress.bytesTotal) * 100)}%
            </span>
          )}
        </StatusBanner>
      )}

      {/* Skill list grouped by category */}
      {groupedSkills && Object.keys(groupedSkills).length > 0 && (
        <>
          {Object.entries(groupedSkills)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([category, entries]) => (
              <div key={category} className="space-y-1.5">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
                  {category}
                  <span className="text-xs font-normal text-neutral-500 dark:text-neutral-500">
                    {entries.length}
                  </span>
                </h3>
                <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200 bg-white dark:divide-neutral-800 dark:border-neutral-700 dark:bg-neutral-900/40">
                  {entries.map((entry) => (
                    <li key={entry.dirName}>
                      <DiscoverCard
                        entry={entry}
                        installing={installing === entry.dirName}
                        onInstall={() => void handleInstall(entry)}
                        onUninstall={() => void handleUninstall(entry)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </>
      )}

      {/* Empty search result */}
      {manifest && query && filteredSkills && filteredSkills.length === 0 && (
        <div className="rounded-md border border-dashed border-neutral-200 px-3 py-6 text-center text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          {t('skills.discover.noMatch', { query })}
        </div>
      )}

      {/* Load more */}
      {remaining > 0 && (
        <div className="flex justify-center">
          <BrandButton
            variant="ghost"
            onClick={() => setDisplayCount((n) => n + 10)}
          >
            {t('skills.discover.loadMore', { remaining })}
          </BrandButton>
        </div>
      )}

      {/* Empty manifest (loaded but no skills) */}
      {manifest && manifest.length === 0 && (
        <div className="rounded-md border border-dashed border-neutral-200 px-3 py-6 text-center text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          {t('skills.discover.empty')}
        </div>
      )}
      </div>
    </>
  )
}

interface DiscoverCardProps {
  entry: SkillStoreEntry
  installing: boolean
  onInstall: () => void
  onUninstall?: () => void
}

/**
 * Unified banner for error / info / progress states.
 * Centralises tone styling + ARIA semantics so callers don't drift.
 */
interface StatusBannerProps {
  tone: 'error' | 'info'
  icon: React.ReactNode
  busy?: boolean
  children: React.ReactNode
}

function StatusBanner({ tone, icon, busy, children }: StatusBannerProps) {
  const isError = tone === 'error'
  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-busy={busy ? true : undefined}
      className={`flex items-center gap-2 rounded-md border p-2.5 text-xs ${
        isError
          ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-400'
          : 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/50 dark:bg-blue-900/20 dark:text-blue-400'
      }`}
    >
      <span className="h-4 w-4 shrink-0 [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      <div className="flex flex-1 items-center gap-2">{children}</div>
    </div>
  )
}

function DiscoverCard({ entry, installing, onInstall, onUninstall }: DiscoverCardProps) {
  const t = useT()
  const [locale] = useLocale()
  // Render the translation for the active locale when one is packaged
  // (#139 review: store ignores translated descriptions); the base
  // description remains the fallback.
  const localizedDescription = selectLocalizedDescription(entry, locale)
  const catClass = CATEGORY_COLORS[entry.category] ?? CATEGORY_COLORS.general
  const buttonLabel = entry.installed
    ? t('skills.discover.uninstall')
    : installing
    ? t('skills.discover.installing')
    : t('skills.discover.install')
  const statusText = entry.installed
    ? t('skills.discover.statusInstalled', { name: entry.name })
    : installing
    ? t('skills.discover.statusInstalling', { name: entry.name })
    : t('skills.discover.statusAvailable', { name: entry.name })

  const [expanded, setExpanded] = useState(false)
  // Heuristic: long descriptions get an expand toggle. 90 chars roughly maps
  // to ~3 lines at 11px; we add a buffer for safety.
  const needsExpand = (localizedDescription?.length ?? 0) > 110

  const handleClick = () => {
    if (entry.installed) onUninstall?.()
    else onInstall()
  }

  return (
    <article
      role="group"
      aria-label={statusText}
      className="group/skill flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-neutral-50/60 dark:hover:bg-neutral-800/30"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <h4 className="truncate text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
            {entry.name}
          </h4>
          {entry.installed && (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-green-50 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
              <Check className="h-3 w-3" aria-hidden="true" />
              {t('skills.discover.installedBadge')}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-[10px]">
          <span className={`inline-block rounded px-1.5 py-0.5 font-medium ${catClass}`}>
            {entry.category}
          </span>
          {entry.version && (
            <span className="text-neutral-400 dark:text-neutral-500">v{entry.version}</span>
          )}
        </div>
        {localizedDescription && (
          <div className="space-y-0.5">
            <p
              className={`text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-400 ${
                needsExpand && !expanded ? 'line-clamp-3' : ''
              }`}
            >
              {localizedDescription}
            </p>
            {needsExpand && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setExpanded((v) => !v)
                }}
                className="text-[10px] text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
              >
                {expanded ? t('skills.discover.collapsing') : t('skills.discover.expanding')}
              </button>
            )}
          </div>
        )}
      </div>
      <BrandButton
        variant="outline"
        onClick={handleClick}
        disabled={installing}
        aria-label={buttonLabel}
        aria-busy={installing}
        className="shrink-0"
      >
        {installing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : entry.installed ? (
          <>
            <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {t('skills.discover.uninstall')}
          </>
        ) : (
          <>
            <Download className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {t('skills.discover.install')}
          </>
        )}
      </BrandButton>
    </article>
  )
}
