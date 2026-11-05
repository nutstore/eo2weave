/**
 * SkillEditor - Create, view, or edit a skill.
 *
 * Simplified: only name, description, and content (instruction).
 * Other fields auto-filled with defaults.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  X, Eye, Save, FileCode, Lock,
} from 'lucide-react'
import {
  BrandDialog,
  BrandDialogContent,
  BrandDialogHeader,
  BrandDialogTitle,
  BrandDialogClose,
  BrandButton,
} from '@creatorweave/ui'
import { Input } from '@/components/ui/input'
import { TextareaWithLines } from '@/components/ui/TextareaWithLines'
import type { SkillMetadata } from '@/skills/skill-types'
import { useSkillsStore } from '@/store/skills.store'
import { useT } from '@/i18n'

// ============================================================================

interface SkillEditorProps {
  skill?: SkillMetadata
  open: boolean
  onClose: () => void
  readOnly?: boolean
}

// ============================================================================

/** Escape a string for YAML double-quoted scalar. */
const yamlEscape = (s: string): string =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')

export function SkillEditor({ skill, open, onClose, readOnly = false }: SkillEditorProps) {
  const t = useT()
  const skillsStore = useSkillsStore()
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Form state — only 3 fields
  const [name, setName] = useState(skill?.name || '')
  const [description, setDescription] = useState(skill?.description || '')
  const [instruction, setInstruction] = useState('')

  // Load full skill content (with race-condition guard for rapid switching)
  useEffect(() => {
    let cancelled = false
    if (skill) {
      setName(skill.name || '')
      setDescription(skill.description || '')

      skillsStore.getFullSkill(skill.id).then((fullSkill) => {
        // Guard: if the user switched to a different skill before this
        // async resolution landed, discard the result to avoid
        // overwriting the textarea with stale content.
        if (cancelled) return
        if (fullSkill) {
          setInstruction(fullSkill.instruction || '')
        }
      })
    } else {
      setName('')
      setDescription('')
      setInstruction('')
    }
    return () => {
      cancelled = true
    }
  }, [skill, skillsStore])

  // Build SKILL.md content.
  // Preserves existing metadata (version/author/category/tags/triggers) when
  // editing — only name/description/instruction are user-editable fields.
  const buildSkillMd = useCallback(() => {
    const lines: string[] = ['---']
    lines.push(`name: "${yamlEscape(name)}"`)
    lines.push(`version: "${skill?.version || '1.0.0'}"`)
    lines.push(`description: "${yamlEscape(description)}"`)
    // Localized descriptions are not edited in this form, but dropping them on
    // save would silently remove the translations shipped in SKILL.md.
    for (const [locale, text] of Object.entries(skill?.description_i18n ?? {})) {
      if (text) lines.push(`description.${locale}: "${yamlEscape(text)}"`)
    }
    lines.push(`author: "${skill?.author || 'User'}"`)
    lines.push(`category: ${skill?.category || 'general'}`)
    // Preserve existing tags/triggers (UI doesn't edit them)
    if (skill?.tags && skill.tags.length > 0) {
      lines.push(`tags: [${skill.tags.map((tag) => `"${yamlEscape(tag)}"`).join(', ')}]`)
    } else {
      lines.push(`tags: []`)
    }
    lines.push('triggers:')
    if (skill?.triggers?.keywords && skill.triggers.keywords.length > 0) {
      lines.push(
        `  keywords: [${skill.triggers.keywords.map((k) => `"${yamlEscape(k)}"`).join(', ')}]`
      )
    } else {
      lines.push('  keywords: []')
    }
    if (skill?.triggers?.fileExtensions && skill.triggers.fileExtensions.length > 0) {
      lines.push(
        `  fileExtensions: [${skill.triggers.fileExtensions.map((e) => `"${e}"`).join(', ')}]`
      )
    }
    // Preserve existing secrets (UI doesn't edit them — they come from raw YAML)
    if (skill?.secrets && skill.secrets.length > 0) {
      lines.push('secrets:')
      for (const secret of skill.secrets) {
        const desc = secret.description ? yamlEscape(secret.description) : ''
        if (desc) {
          lines.push(`  - name: "${yamlEscape(secret.name)}"`)
          lines.push(`    description: "${desc}"`)
          if (secret.required === false) lines.push(`    required: false`)
        } else {
          lines.push(`  - name: "${yamlEscape(secret.name)}"`)
          if (secret.required === false) lines.push(`    required: false`)
        }
      }
    }
    lines.push('---')
    lines.push('')
    if (instruction) {
      lines.push(instruction)
    }
    return lines.join('\n')
  }, [name, description, instruction, skill])

  const handleSave = async () => {
    if (!name.trim()) { setError(t('skillEditor.nameRequired')); return }
    if (!description.trim()) { setError(t('skillEditor.descriptionRequired')); return }
    setError(null)
    setIsSaving(true)
    try {
      const content = buildSkillMd()
      const result = await skillsStore.importSkillMd(content)
      if (result.success) {
        // Only delete the old skill when its ID differs from the newly imported one
        // (e.g. the user renamed the skill, producing a different slug).
        // If IDs match, importSkillMd already performed an in-place update, so
        // deleting would wipe the just-saved skill.
        if (skill && result.skillId && skill.id !== result.skillId) {
          await skillsStore.deleteSkill(skill.id)
        }
        onClose()
      } else {
        setError(result.error || t('skillEditor.saveFailed'))
      }
    } finally { setIsSaving(false) }
  }

  const dialogTitle = readOnly
    ? skill?.name || t('skillCard.viewDetails')
    : skill
      ? t('skillEditor.editSkill')
      : t('skillEditor.createSkill')

  return (
    <BrandDialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <BrandDialogContent className="flex max-h-[85vh] max-w-xl flex-col overflow-hidden p-0">
        {/* Header — consistent with system BrandDialogHeader */}
        <BrandDialogHeader>
          <BrandDialogTitle className="flex items-center gap-2 text-base font-semibold text-foreground">
            {readOnly ? (
              <Eye className="h-4.5 w-4.5 text-blue-500" />
            ) : (
              <FileCode className="h-4.5 w-4.5 text-blue-500" />
            )}
            {dialogTitle}
            {readOnly && (
              <Lock className="h-3.5 w-3.5 text-neutral-500 text-neutral-500 dark:text-neutral-500" />
            )}
          </BrandDialogTitle>
          <BrandDialogClose className="text-neutral-400 hover:text-neutral-600 text-neutral-500 text-neutral-500 dark:text-neutral-500 dark:hover:text-neutral-300">
            <X className="h-5 w-5" />
          </BrandDialogClose>
        </BrandDialogHeader>

        {/* Error */}
        {error && (
          <div className="mx-6 mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </div>
        )}

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {readOnly ? (
            <div className="space-y-5">
              {skill?.description && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-neutral-400 text-neutral-400 dark:text-neutral-400">
                    {t('skillEditor.description')}
                  </label>
                  <p className="text-sm leading-relaxed text-neutral-300 text-neutral-300 dark:text-neutral-300">
                    {skill.description}
                  </p>
                </div>
              )}
              {instruction && (
                <div>
                  <label className="mb-2 block text-xs font-medium text-neutral-400 text-neutral-400 dark:text-neutral-400">
                    {t('skillEditor.instruction')}
                  </label>
                  <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-700">
                    <div className="bg-white p-4 dark:bg-neutral-800/50">
                      <div className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-neutral-300 text-neutral-300 dark:text-neutral-300">
                        {instruction}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-5">
              <FormField label={t('skillEditor.skillName')} required>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('skillEditor.skillNamePlaceholder')}
                  className="bg-neutral-50 focus:bg-white dark:bg-neutral-800 dark:focus:bg-neutral-700"
                />
              </FormField>

              <FormField label={t('skillEditor.description')} required>
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('skillEditor.descriptionPlaceholder')}
                  className="bg-neutral-50 focus:bg-white dark:bg-neutral-800 dark:focus:bg-neutral-700"
                />
              </FormField>

              <FormField label={t('skillEditor.instruction')}>
                <TextareaWithLines
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder={t('skillEditor.instructionPlaceholder')}
                  rows={16}
                />
              </FormField>
            </div>
          )}
        </div>

        {/* Footer — consistent with system */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-neutral-200 px-6 py-3 dark:border-neutral-700">
          {readOnly ? (
            <BrandButton variant="outline" onClick={onClose}>
              {t('skillEditor.close')}
            </BrandButton>
          ) : (
            <>
              <BrandButton variant="outline" onClick={onClose}>
                {t('skillEditor.cancel')}
              </BrandButton>
              <BrandButton onClick={handleSave} disabled={isSaving}>
                <Save className="mr-1.5 h-4 w-4" />
                {isSaving ? t('skillEditor.saving') : t('skillEditor.save')}
              </BrandButton>
            </>
          )}
        </div>
      </BrandDialogContent>
    </BrandDialog>
  )
}

// ============================================================================
// FormField - Label wrapper
// ============================================================================

function FormField({ label, required, children }: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="mb-1.5 flex items-center text-sm font-medium text-neutral-400 text-neutral-400 dark:text-neutral-400">
        {label}
        {required && <span className="ml-1 text-red-500">*</span>}
      </label>
      {children}
    </div>
  )
}
