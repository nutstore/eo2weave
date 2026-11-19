/**
 * SkillCard — single skill row in the management list.
 *
 * Layout (one row, two visual blocks):
 *   ┌──────────────────────────────────────────────────────┐
 *   │ [name]                          [category] [version]    │
 *   │ [description, multi-line]                            │
 *   │ [author · updated 3d]    [View] [Edit] [Export] [Delete]│
 *   └──────────────────────────────────────────────────────┘
 *
 * The whole card opens the detail view (read-only preview);
 * the action buttons in the footer handle specific operations.
 */

import { Eye, KeyRound, Pencil, Trash2, Download } from 'lucide-react'
import { useMemo } from 'react'
import { BrandButton } from '@creatorweave/ui'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { SkillMetadata } from '@/skills/skill-types'
import { useT } from '@/i18n'

interface SkillCardProps {
  skill: SkillMetadata
  /** Read-only mode for project/builtin skills (cannot edit/delete) */
  isReadOnly?: boolean
  /** Names of secrets currently configured for the active project (project + global). */
  configuredSecrets?: Set<string>
  onToggle: (id: string, enabled: boolean) => void
  onView: (skill: SkillMetadata) => void
  onEdit: (skill: SkillMetadata) => void
  onDelete?: (id: string) => void
  onExport?: (skill: SkillMetadata) => void
}

// Category → key into skills.ts. Unknown categories fall back to 'general'.
const CATEGORY_KEY: Record<string, string> = {
  'code-review': 'skillCard.category.codeReview',
  testing: 'skillCard.category.testing',
  debugging: 'skillCard.category.debugging',
  refactoring: 'skillCard.category.refactoring',
  documentation: 'skillCard.category.documentation',
  security: 'skillCard.category.security',
  performance: 'skillCard.category.performance',
  architecture: 'skillCard.category.architecture',
  general: 'skillCard.category.general',
}

// Category → badge colour (light + dark variants).
const CATEGORY_BADGE: Record<string, string> = {
  'code-review': 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  testing: 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  debugging: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  refactoring: 'bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  documentation: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  security: 'bg-yellow-50 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
  performance: 'bg-pink-50 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300',
  architecture: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
  general: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return ''
  const diffSec = Math.round((Date.now() - timestamp) / 1000)
  if (diffSec < 60) return `${diffSec}s`
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d`
  return new Date(timestamp).toLocaleDateString()
}

export function SkillCard({ skill, isReadOnly, configuredSecrets, onToggle, onView, onEdit, onDelete, onExport }: SkillCardProps) {
  const t = useT()
  const catKey = CATEGORY_KEY[skill.category] ?? CATEGORY_KEY.general
  const catClass = CATEGORY_BADGE[skill.category] ?? CATEGORY_BADGE.general

  // Compute secret dependency status
  const requiredSecrets = skill.secrets?.filter((s) => s.required !== false) ?? []
  const totalSecrets = skill.secrets?.length ?? 0
  const missingCount = useMemo(() => {
    if (totalSecrets === 0 || !configuredSecrets) return 0
    return requiredSecrets.filter((s) => !configuredSecrets.has(s.name)).length
  }, [requiredSecrets, totalSecrets, configuredSecrets])

  const hasSecrets = totalSecrets > 0

  // Stop click-throughs on the action buttons / switch from opening the detail view.
  const stop = (e: React.MouseEvent) => e.stopPropagation()

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onView(skill)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onView(skill)
        }
      }}
      className={cn(
        'group/skill-card flex flex-col gap-1.5 rounded-md border p-3 transition-colors cursor-pointer',
        skill.enabled
          ? 'border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50/60 dark:border-neutral-700 dark:bg-neutral-900/40 dark:hover:border-neutral-600'
          : 'border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900/20 opacity-70',
      )}
    >
      {/* Title row: name (truncate) · category badge · version · toggle */}
      <div className="flex items-center gap-2">
        <h3
          className={cn(
            'min-w-0 flex-1 truncate text-[13px] font-medium',
            skill.enabled
              ? 'text-neutral-900 dark:text-neutral-100'
              : 'text-neutral-500 dark:text-neutral-500',
          )}
        >
          {skill.name}
        </h3>
        <span
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
            catClass,
          )}
        >
          {t(catKey)}
        </span>
        {skill.version && (
          <span className="shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500">
            v{skill.version}
          </span>
        )}
        <div onClick={stop} className="shrink-0">
          <Switch
            checked={skill.enabled}
            onCheckedChange={(checked) => onToggle(skill.id, checked)}
            aria-label={skill.enabled ? t('skillCard.enabled') : t('skillCard.disabled')}
          />
        </div>
      </div>

      {/* Description (full, no clamp) */}
      {skill.description && (
        <p className="text-[11px] leading-relaxed text-neutral-600 dark:text-neutral-400">
          {skill.description}
        </p>
      )}

      {/* Footer: metadata + actions */}
      <div
        onClick={stop}
        className="mt-0.5 flex items-center justify-between gap-2"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[10px] text-neutral-500 dark:text-neutral-500">
          {skill.author && skill.author !== 'Unknown' && (
            <span className="truncate">{skill.author}</span>
          )}
          {skill.updatedAt > 0 && (
            <span title={new Date(skill.updatedAt).toLocaleString()}>
              · {formatRelativeTime(skill.updatedAt)}
            </span>
          )}
          {skill.source === 'project' && (
            <span className="text-neutral-400 dark:text-neutral-600">· {t('skillCard.project')}</span>
          )}
          {hasSecrets && (
            <span
              className="flex items-center gap-0.5"
              title={
                missingCount > 0
                  ? t('skillCard.secretsMissing', { missing: missingCount, total: totalSecrets })
                  : t('skillCard.secretsOk', { count: totalSecrets - missingCount, total: totalSecrets })
              }
            >
              · <KeyRound className={missingCount > 0 ? 'h-3 w-3 text-amber-500' : 'h-3 w-3 text-emerald-500'} />
              {missingCount > 0 ? (
                <span className="text-amber-500">{missingCount}/{totalSecrets}</span>
              ) : (
                <span className="text-neutral-400">{totalSecrets}</span>
              )}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <BrandButton
            iconButton
            className="h-6 w-6 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
            onClick={() => onView(skill)}
            title={t('skillCard.viewDetails')}
            aria-label={t('skillCard.viewDetails')}
          >
            <Eye className="h-3.5 w-3.5" />
          </BrandButton>
          {!isReadOnly && (
            <BrandButton
              iconButton
              className="h-6 w-6 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              onClick={() => onEdit(skill)}
              title={t('skillCard.edit')}
              aria-label={t('skillCard.edit')}
            >
              <Pencil className="h-3.5 w-3.5" />
            </BrandButton>
          )}
          {onExport && (
            <BrandButton
              iconButton
              className="h-6 w-6 text-neutral-400 hover:text-blue-600 dark:hover:text-blue-400"
              onClick={() => onExport(skill)}
              title={t('skillCard.export')}
              aria-label={t('skillCard.export')}
            >
              <Download className="h-3.5 w-3.5" />
            </BrandButton>
          )}
          {onDelete && (
            <BrandButton
              iconButton
              className="h-6 w-6 text-neutral-400 hover:text-red-500 dark:hover:text-red-400"
              onClick={() => onDelete(skill.id)}
              title={t('skillCard.delete')}
              aria-label={t('skillCard.delete')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </BrandButton>
          )}
        </div>
      </div>
    </div>
  )
}
