/**
 * SkillSearchRenderer — chat card for search_skills tool results.
 *
 * Renders matching skills as a list with inline install/uninstall buttons.
 * Design follows ExternalToolRenderers: no color-coding, no badges/borders;
 * structure via whitespace, 13px name > 12px desc > 11px tags.
 */

import { Download, Check, Loader2, Search, AlertCircle } from 'lucide-react'
import { useState, useCallback } from 'react'
import { registerRenderer } from './registry'
import type { ToolRenderCtx } from './types'
import { installSkillFromUrl, type InstallProgress } from '@/skills/skill-store'
import { useSkillsStore } from '@/store/skills.store'
import { useT } from '@/i18n'

// ── Types ──

interface SkillSearchResultRow {
  name: string
  description: string
  category: string
  tags: string[]
  version: string
  dirName: string
  zipUrl: string
  installed: boolean
  score: number
  relevanceReason?: string
}

// ── Helpers ──

function extractResults(ctx: ToolRenderCtx): SkillSearchResultRow[] {
  const data = ctx.result?.data as Record<string, unknown> | undefined
  if (!data || !Array.isArray(data.results)) return []
  return data.results as SkillSearchResultRow[]
}

function extractMeta(ctx: ToolRenderCtx): { total?: number; query?: string; message?: string } {
  const data = ctx.result?.data as Record<string, unknown> | undefined
  if (!data) return {}
  return {
    total: typeof data.total === 'number' ? data.total : undefined,
    query: typeof data.query === 'string' ? data.query : undefined,
    message: typeof data.message === 'string' ? data.message : undefined,
  }
}

// ── Renderer registration ──

registerRenderer({
  name: 'search_skills',
  icon: <Search className="h-3.5 w-3.5 text-neutral-400" />,
  Summary(ctx) {
    const query = typeof ctx.args.query === 'string' ? ctx.args.query : ''
    const results = extractResults(ctx)
    const { total } = extractMeta(ctx)

    return (
      <>
        <code className="shrink-0 font-medium text-neutral-600 dark:text-neutral-300">
          search_skills
        </code>
        {query && (
          <span className="min-w-0 truncate text-neutral-500 dark:text-neutral-500">
            &ldquo;{query}&rdquo;
          </span>
        )}
        {!ctx.isExecuting && !ctx.isStreaming && !ctx.isError && (
          <span className="ml-auto shrink-0 text-xs text-neutral-400">
            {results.length === 0
              ? '0 matches'
              : `${total ?? results.length} skill${(total ?? results.length) !== 1 ? 's' : ''}`}
          </span>
        )}
        {ctx.isError && (
          <span className="ml-auto shrink-0 text-xs text-red-500">&#x2717; failed</span>
        )}
      </>
    )
  },
  Detail(ctx) {
    const results = extractResults(ctx)
    const { query, message } = extractMeta(ctx)

    if (ctx.isExecuting) {
      return (
        <div className="px-3 py-3">
          <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Searching Skill Store…
          </div>
        </div>
      )
    }

    if (ctx.isError) {
      // Error envelope shape: { ok: false, error: { code, message } }
      const errObj = ctx.result?.error as Record<string, unknown> | undefined
      const errorMsg =
        (typeof errObj?.message === 'string' ? errObj.message : undefined) ??
        ctx.rawResult ??
        'Search failed'
      return (
        <div className="px-3 py-2 text-xs text-red-500">
          {typeof errorMsg === 'string' ? errorMsg : 'Search failed'}
        </div>
      )
    }

    if (results.length === 0) {
      return (
        <div className="px-3 py-3 text-xs text-neutral-500 dark:text-neutral-400">
          {message ?? `No skills matched "${query}".`}
        </div>
      )
    }

    return (
      <div className="px-2 py-2 sm:px-3">
        <div className="mb-2 text-[11px] text-neutral-500 dark:text-neutral-500">
          {results.length} result{results.length !== 1 ? 's' : ''}
          {query ? ` for "${query}"` : ''}
        </div>
        <div className="space-y-3">
          {results.map((skill) => (
            <SkillResultCard key={skill.dirName} skill={skill} />
          ))}
        </div>
      </div>
    )
  },
})

// ── Individual skill card with install button ──

interface SkillResultCardProps {
  skill: SkillSearchResultRow
}

function SkillResultCard({ skill }: SkillResultCardProps) {
  const t = useT()
  const bumpScanVersion = useSkillsStore((s) => s.bumpSkillsScanVersion)
  const loadSkills = useSkillsStore((s) => s.loadSkills)
  const [installState, setInstallState] = useState<
    'idle' | 'installing' | 'installed' | 'error'
  >(skill.installed ? 'installed' : 'idle')
  const [progress, setProgress] = useState<InstallProgress | null>(null)

  const handleInstall = useCallback(async () => {
    if (installState === 'installing') return
    setInstallState('installing')
    setProgress({ phase: 'fetching', message: t('skills.discover.progressPreparing') })
    try {
      // The version-aware install flow decides install vs. update vs. keep
      // (#154) — an already-installed skill may still be outdated.
      const result = await installSkillFromUrl(skill.zipUrl, setProgress)
      // Refresh skill store so the new skill appears everywhere
      await loadSkills()
      bumpScanVersion()
      setInstallState('installed')
      // Partial member drops ride ANY successful outcome (#185 review round
      // N): the chat card must not report a clean install when a bundle
      // member was omitted. The install progress line carries the notice.
      if ((result.droppedMembers?.length ?? 0) > 0) {
        setProgress({
          phase: 'done',
          message: t('skills.discover.memberRemovedDuringInstall'),
        })
      }
    } catch (err) {
      console.error('[SkillSearchRenderer] Install failed:', err)
      setInstallState('error')
    } finally {
      setProgress(null)
    }
  }, [installState, skill.zipUrl, loadSkills, bumpScanVersion, t])

  const buttonLabel =
    installState === 'installing'
      ? progress?.message ?? t('skills.discover.installing')
      // An installed-and-updateable result must say "Update", not "Installed" —
      // the click runs the version-aware install flow (#154), so the action is
      // a potential update even though a copy is already on disk. Checking
      // skill.installed FIRST keeps that label visible; a result that was
      // installed during this session (no longer updateable-marked) still
      // reports "Installed".
      : skill.installed && installState !== 'error'
      ? t('skills.discover.update') || 'Update'
      : installState === 'installed'
      ? t('skills.discover.installedBadge') || 'Installed'
      : installState === 'error'
      ? t('skills.discover.progressInstallFailed')
      : t('skills.discover.install') || 'Install'

  return (
    <div>
      {/* Name + version */}
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[13px] font-medium text-neutral-700 dark:text-neutral-200">
          {skill.name}
        </span>
        {skill.version && (
          <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
            v{skill.version}
          </span>
        )}
        {installState === 'installed' && (
          <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-green-50 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
            <Check className="h-3 w-3" aria-hidden="true" />
            {t('skills.discover.installedBadge') || 'Installed'}
          </span>
        )}
      </div>

      {/* Description */}
      {skill.description && (
        <p className="mb-1.5 text-[12px] leading-relaxed text-neutral-600 dark:text-neutral-300">
          {skill.description}
        </p>
      )}

      {/* Relevance reason (from LLM rerank/semantic paths) */}
      {skill.relevanceReason && (
        <p className="mb-1.5 text-[11px] italic leading-relaxed text-neutral-400 dark:text-neutral-500">
          {skill.relevanceReason}
        </p>
      )}

      {/* Tags */}
      {skill.tags.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1 text-[10px] text-neutral-400 dark:text-neutral-500">
          {skill.category && <span>{skill.category}</span>}
          {skill.tags.slice(0, 5).map((tag) => (
            <span key={tag}>· {tag}</span>
          ))}
        </div>
      )}

      {/* Install / status button */}
      <button
        type="button"
        onClick={handleInstall}
        disabled={installState === 'installing'}
        className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 py-1 text-[11px] font-medium text-neutral-600 transition-colors hover:bg-neutral-50 disabled:cursor-default disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800/40"
      >
        {installState === 'installing' && (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        )}
        {installState === 'installed' && (
          <Check className="h-3 w-3" aria-hidden="true" />
        )}
        {installState === 'idle' && (
          <Download className="h-3 w-3" aria-hidden="true" />
        )}
        {installState === 'error' && (
          <AlertCircle className="h-3 w-3" aria-hidden="true" />
        )}
        {buttonLabel}
      </button>
    </div>
  )
}
