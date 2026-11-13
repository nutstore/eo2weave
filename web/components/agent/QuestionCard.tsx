/**
 * QuestionCard - renders an ask_user_question tool call as an interactive question card.
 *
 * Supports four question types:
 * - yes_no: Two-button confirmation (Yes / No) + optional free text input
 * - single_choice: Radio button list + optional free text input
 * - multi_choice: Checkbox list with submit + optional free text input
 * - free_text: Textarea with submit
 *
 * All choice-based types also offer a "自定义输入" (custom input) option so the user
 * can type their own answer instead of (or in addition to) selecting from presets.
 *
 * Options MUST use the object form:
 *   { label: "PostgreSQL", description?: "...", recommended?: boolean }
 *
 * The string form was REMOVED. The ask_user_question executor rejects
 * string entries with INVALID_INPUT + a hint pointing to the object form.
 *
 * Historical chat data may still contain string entries (from before this
 * change); normalizeOption() silently coerces them to plain labels for
 * backward compatibility, so old tool calls still render (without description
 * or recommended status).
 *
 * The card is shown when the tool call is executing (waiting for user input).
 * Once answered, it shows the original question, the type, and the full answer
 * for better context when reviewing conversation history.
 */

import { useState, useCallback, useId, type KeyboardEvent, type TextareaHTMLAttributes } from 'react'
import { MessageCircleQuestion, CheckCircle2, Clock, FileText, PencilLine, Star, AlertTriangle } from 'lucide-react'
import { MarkdownContent } from './MarkdownContent'
import { useT } from '@/i18n'
import { normalizeOption, type RawOption, type NormalizedOption } from './QuestionCard.utils'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface QuestionCardProps {
  /** The question text */
  question: string
  /** Question type */
  type: 'yes_no' | 'single_choice' | 'multi_choice' | 'free_text'
  /** Options for single_choice / multi_choice (object form only — string form was removed) */
  options?: RawOption[]
  /** Default answer for pre-selection */
  defaultAnswer?: string
  /** Additional context */
  context?: {
    affected_files?: string[]
    preview?: string
  }
  /** Whether the question has already been answered (show compact result) */
  answered?: boolean
  /** The answer that was given (for answered state) */
  resultAnswer?: string
  /** Optional warning (e.g. "[Interrupted] 页面刷新" — explains why the answer was synthetic) */
  resultWarning?: string
  /**
   * Whether the recorded result is a real user answer. `false` means the question
   * was declined (Skip / timeout / abort) and the card must not present the
   * fallback answer as something the user chose.
   */
  resultConfirmed?: boolean
  /** Whether the question ended by timeout (only meaningful when declined) */
  resultTimedOut?: boolean
  /** Callback when user submits an answer */
  onAnswer?: (answer: string) => void
  /** Declining the question: ends it with confirmed=false, the run continues */
  onSkip?: () => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QuestionCard({
  question,
  type,
  options,
  defaultAnswer,
  context,
  answered,
  resultAnswer,
  resultWarning,
  resultConfirmed,
  resultTimedOut,
  onAnswer,
  onSkip,
}: QuestionCardProps) {
  const t = useT()
  const normalizedOptions = (options ?? []).map(normalizeOption)
  // Declined = the run got a result without the user choosing anything (skip,
  // timeout, abort). Older transcript rows have no `confirmed` field at all —
  // those keep rendering as an ordinary answer.
  const declined = answered && resultConfirmed === false

  // Already answered — show question + answer for context
  if (answered) {
    return (
      <div className="my-1 max-w-full overflow-hidden rounded-xl border border-neutral-200 bg-white text-sm dark:border-neutral-700 dark:bg-neutral-800">
        {/* Header — subtle tint marks it as completed */}
        <div
          className={
            'flex items-center gap-2 border-b px-3 py-2 ' +
            (declined
              ? 'border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-700/40'
              : 'border-primary-100 bg-primary-50 dark:border-primary-100/20 dark:bg-primary-100/10')
          }
        >
          {declined ? (
            <Clock className="h-3.5 w-3.5 shrink-0 text-tertiary" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary-600 dark:text-primary-400" />
          )}
          <span
            className={
              'break-words text-xs font-medium ' +
              (declined
                ? 'text-tertiary'
                : 'text-primary-700 dark:text-primary-300')
            }
          >
            {declined
              ? resultTimedOut
                ? t('questionCard.timedOut')
                : t('questionCard.skipped')
              : t('questionCard.answered')}
          </span>
        </div>

        {/* Original question */}
        <div className="border-b border-neutral-200 px-3 py-2 dark:border-neutral-700">
          <div className="break-words text-xs text-tertiary">
            <MarkdownContent content={question} />
          </div>
        </div>

        {/* Context: affected files */}
        {context?.affected_files && context.affected_files.length > 0 && (
          <div className="border-b border-neutral-200 px-3 py-2 dark:border-neutral-700">
            <div className="mb-1 flex items-center gap-1 text-xs text-tertiary">
              <FileText className="h-3 w-3 shrink-0" />
              <span>{t('questionCard.affectedFiles')}</span>
            </div>
            <div className="space-y-0.5">
              {context.affected_files.map((file) => (
                <div
                  key={file}
                  title={file}
                  className="break-all font-mono text-xs text-secondary"
                >
                  {file}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Context: preview */}
        {context?.preview && (
          <div className="border-b border-neutral-200 px-3 py-2 dark:border-neutral-700">
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all text-xs text-secondary">
              {context.preview}
            </pre>
          </div>
        )}

        {/* Resolution: the user's answer, or a note when they declined */}
        {resultAnswer && (
          <div className="px-3 py-2">
            {declined ? (
              <div className="text-xs text-tertiary">{t('questionCard.noAnswer')}</div>
            ) : (
              <>
                <div className="text-xs font-medium text-tertiary">
                  {t('questionCard.userAnswer')}
                </div>
                <div className="mt-1 break-words rounded-lg bg-primary-50 px-2 py-1.5 text-sm text-secondary ring-1 ring-primary-100 dark:bg-primary-100/15 dark:ring-primary-100/20">
                  {resultAnswer}
                </div>
              </>
            )}
            {resultWarning && (
              <div className="mt-1.5 flex items-start gap-1 break-words rounded bg-warning-bg px-2 py-1.5 text-xs text-warning ring-1 ring-warning/20">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{resultWarning}</span>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="my-1 max-w-full overflow-hidden rounded-xl border border-neutral-200 bg-white text-sm dark:border-neutral-700 dark:bg-neutral-800">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-primary-100 bg-primary-50 px-3 py-2 dark:border-primary-100/20 dark:bg-primary-100/10">
        <MessageCircleQuestion className="h-4 w-4 shrink-0 text-primary-600 dark:text-primary-400" />
        <span className="break-words text-xs font-medium text-primary-700 dark:text-primary-300">
          {t('questionCard.title')}
        </span>
        <Clock className="ml-auto h-3 w-3 shrink-0 text-primary-400 dark:text-primary-500" />
      </div>

      {/* Context: affected files */}
      {context?.affected_files && context.affected_files.length > 0 && (
        <div className="border-b border-neutral-200 px-3 py-2 dark:border-neutral-700">
          <div className="mb-1 flex items-center gap-1 text-xs text-tertiary">
            <FileText className="h-3 w-3 shrink-0" />
            <span>{t('questionCard.affectedFiles')}</span>
          </div>
          <div className="space-y-0.5">
            {context.affected_files.map((file) => (
              <div
                key={file}
                title={file}
                className="break-all font-mono text-xs text-secondary"
              >
                {file}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Context: preview */}
      {context?.preview && (
        <div className="border-b border-neutral-200 px-3 py-2 dark:border-neutral-700">
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all text-xs text-secondary">
            {context.preview}
          </pre>
        </div>
      )}

      {/* Question body */}
      <div className="px-3 py-3">
        <div className="mb-3 break-words text-sm text-secondary">
          <MarkdownContent content={question} />
        </div>

        {/* Question type-specific input */}
        {type === 'yes_no' && (
          <YesNoInput defaultAnswer={defaultAnswer} onAnswer={onAnswer} onSkip={onSkip} />
        )}
        {type === 'single_choice' && (
          <SingleChoiceInput options={normalizedOptions} defaultAnswer={defaultAnswer} onAnswer={onAnswer} onSkip={onSkip} />
        )}
        {type === 'multi_choice' && (
          <MultiChoiceInput options={normalizedOptions} defaultAnswer={defaultAnswer} onAnswer={onAnswer} onSkip={onSkip} />
        )}
        {type === 'free_text' && (
          <FreeTextInput defaultAnswer={defaultAnswer} onAnswer={onAnswer} onSkip={onSkip} />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared option renderer (label + optional description + ⭐ badge)
// ---------------------------------------------------------------------------

function OptionContent({ option }: { option: NormalizedOption }) {
  const t = useT()
  return (
    <div className="min-w-0 flex-1 break-words">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        {option.recommended && (
          <span
            className="inline-flex shrink-0 items-center gap-0.5 rounded bg-neutral-100 px-1 py-0.5 text-[10px] font-medium text-tertiary ring-1 ring-neutral-200"
            title={t('questionCard.recommended')}
          >
            <Star className="h-2.5 w-2.5 fill-current" />
            <span>{t('questionCard.recommended')}</span>
          </span>
        )}
        <span className="break-words text-sm text-secondary">{option.label}</span>
      </div>
      {option.description && (
        <div className="mt-0.5 break-words text-xs text-tertiary">
          {option.description}
        </div>
      )}
    </div>
  )
}

/**
 * Shared skip action: a text button appended to each question type's main
 * button row. Ends this question only — the run continues with confirmed=false
 * so the model does not guess.
 */
function SkipButton({ onSkip }: { onSkip?: () => void }) {
  const t = useT()
  if (!onSkip) return null
  return (
    <button
      type="button"
      onClick={onSkip}
      className="rounded-md bg-neutral-100 px-3 py-1.5 text-sm text-secondary focus:outline-none focus:ring-2 focus:ring-offset-1 hover:bg-neutral-200 focus:ring-neutral-400 dark:bg-neutral-800 dark:hover:bg-neutral-700"
    >
      {t('questionCard.skip')}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Sub-components for each question type
// ---------------------------------------------------------------------------

function YesNoInput({
  defaultAnswer,
  onAnswer,
  onSkip,
}: {
  defaultAnswer?: string
  onAnswer?: (answer: string) => void
  onSkip?: () => void
}) {
  const t = useT()
  const [showCustom, setShowCustom] = useState(false)
  const [customText, setCustomText] = useState('')
  // Highlight the default button. Match on yes/no/true/false/1/0 (case-insensitive, trimmed).
  const normalizedDefault = (defaultAnswer ?? '').trim().toLowerCase()
  const yesIsDefault = normalizedDefault === 'yes' || normalizedDefault === 'true' || normalizedDefault === '1'
  const noIsDefault = normalizedDefault === 'no' || normalizedDefault === 'false' || normalizedDefault === '0'

  const handleYes = useCallback(() => onAnswer?.('yes'), [onAnswer])
  const handleNo = useCallback(() => onAnswer?.('no'), [onAnswer])
  const handleCustomSubmit = useCallback(() => {
    if (customText.trim()) {
      onAnswer?.(customText.trim())
    }
  }, [customText, onAnswer])
  const handleCustomKeyDown: TextareaHTMLAttributes<HTMLTextAreaElement>['onKeyDown'] = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleCustomSubmit()
      }
    },
    [handleCustomSubmit]
  )

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleYes}
          disabled={showCustom}
          className={
            'rounded-md px-4 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed ' +
            (yesIsDefault
              ? 'bg-primary-600 text-white ring-2 ring-primary-400 hover:bg-primary-700 focus:ring-primary-600'
              : 'bg-primary-600 text-white hover:bg-primary-700 focus:ring-primary-600')
          }
        >
          {t('questionCard.yes')}
        </button>
        <button
          type="button"
          onClick={handleNo}
          disabled={showCustom}
          className={
            'rounded-md px-4 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed ' +
            (noIsDefault
              ? 'bg-neutral-300 ring-2 ring-neutral-500 hover:bg-neutral-400 focus:ring-neutral-400 dark:bg-neutral-600 dark:ring-neutral-400 dark:hover:bg-neutral-500'
              : 'bg-neutral-200 hover:bg-neutral-300 focus:ring-neutral-400 dark:bg-neutral-700 dark:text-foreground dark:hover:bg-neutral-600')
          }
        >
          {t('questionCard.no')}
        </button>
        <button
          type="button"
          onClick={() => setShowCustom(!showCustom)}
          className={
            'rounded-md px-4 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-offset-1 ' +
            (showCustom
              ? 'bg-neutral-100 text-secondary ring-1 ring-neutral-300'
              : 'bg-neutral-100 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-tertiary dark:hover:bg-neutral-700')
          }
          title={t('questionCard.customInputHint')}
          aria-label={t('questionCard.customInputHint')}
        >
          <PencilLine className="h-4 w-4" />
        </button>
        <SkipButton onSkip={onSkip} />
      </div>
      {showCustom && (
        <div className="mt-2">
          <textarea
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={handleCustomKeyDown}
            placeholder={t('questionCard.placeholder')}
            rows={2}
            className="w-full break-words rounded-md border border-border bg-card px-3 py-2 text-sm placeholder:text-tertiary focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400"
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[10px] text-tertiary">
              {t('questionCard.submitHint')}
            </span>
            <button
              type="button"
              disabled={!customText.trim()}
              onClick={handleCustomSubmit}
              className="rounded-md bg-primary-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-primary-500 dark:hover:bg-primary-600"
            >
              {t('questionCard.submit')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function SingleChoiceInput({
  options,
  defaultAnswer,
  onAnswer,
  onSkip,
}: {
  options: NormalizedOption[]
  defaultAnswer?: string
  onAnswer?: (answer: string) => void
  onSkip?: () => void
}) {
  const t = useT()
  const radioName = useId()
  const [selected, setSelected] = useState(defaultAnswer ?? '')
  const [showCustom, setShowCustom] = useState(false)
  const [customText, setCustomText] = useState('')
  const CUSTOM_VALUE = '__custom__'

  const handleSelect = useCallback((value: string) => {
    setSelected(value)
    if (value !== CUSTOM_VALUE) {
      setShowCustom(false)
      setCustomText('')
    } else {
      setShowCustom(true)
    }
  }, [])

  const handleSubmit = useCallback(() => {
    if (selected === CUSTOM_VALUE && customText.trim()) {
      onAnswer?.(customText.trim())
    } else if (selected && selected !== CUSTOM_VALUE) {
      onAnswer?.(selected)
    }
  }, [selected, customText, onAnswer])

  const handleCustomKeyDown: TextareaHTMLAttributes<HTMLTextAreaElement>['onKeyDown'] = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  return (
    <div>
      <div className="space-y-1.5">
        {options.map((option, idx) => {
          // Use a stable key — prefer label, fall back to index for duplicates
          const value = option.label
          const key = `${idx}-${option.label}`
          return (
            <label
              key={key}
              className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-700/50"
            >
              <input
                type="radio"
                name={radioName}
                value={value}
                checked={selected === value}
                onChange={() => handleSelect(value)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-500 focus:ring-neutral-400"
              />
              <OptionContent option={option} />
            </label>
          )
        })}
        {/* Custom input option */}
        <label
          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-neutral-50 dark:hover:bg-neutral-700/50"
        >
          <input
            type="radio"
            name={radioName}
            value={CUSTOM_VALUE}
            checked={selected === CUSTOM_VALUE}
            onChange={() => handleSelect(CUSTOM_VALUE)}
            className="h-3.5 w-3.5 shrink-0 text-neutral-500 focus:ring-neutral-400"
          />
          <PencilLine className="h-3.5 w-3.5 shrink-0 text-tertiary" />
          <span className="text-sm text-secondary">
            {t('questionCard.customInput')}
          </span>
        </label>
      </div>
      {showCustom && (
        <div className="mt-2 ml-5">
          <textarea
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={handleCustomKeyDown}
            placeholder={t('questionCard.placeholder')}
            rows={2}
            className="w-full break-words rounded-md border border-border bg-card px-3 py-2 text-sm placeholder:text-tertiary focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400"
          />
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={selected === CUSTOM_VALUE ? !customText.trim() : !selected}
          onClick={handleSubmit}
          className="rounded-md bg-primary-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-primary-500 dark:hover:bg-primary-600"
        >
          {t('questionCard.submit')}
        </button>
        <SkipButton onSkip={onSkip} />
      </div>
    </div>
  )
}

function MultiChoiceInput({
  options,
  defaultAnswer,
  onAnswer,
  onSkip,
}: {
  options: NormalizedOption[]
  defaultAnswer?: string
  onAnswer?: (answer: string) => void
  onSkip?: () => void
}) {
  const t = useT()
  // Parse default answer: comma-separated labels (trimmed).
  // Only labels that match actual options are included (silently ignore stale/typo defaults).
  const validLabels = new Set(options.map((o) => o.label))
  const defaultSet = new Set<string>()
  if (defaultAnswer) {
    for (const part of defaultAnswer.split(',')) {
      const trimmed = part.trim()
      if (trimmed && validLabels.has(trimmed)) {
        defaultSet.add(trimmed)
      }
    }
  }
  const [selected, setSelected] = useState<Set<string>>(defaultSet)
  const [showCustom, setShowCustom] = useState(false)
  const [customText, setCustomText] = useState('')

  const toggle = useCallback((option: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(option)) {
        next.delete(option)
      } else {
        next.add(option)
      }
      return next
    })
  }, [])

  const handleSubmit = useCallback(() => {
    const parts: string[] = Array.from(selected)
    if (showCustom && customText.trim()) {
      parts.push(customText.trim())
    }
    if (parts.length > 0) {
      onAnswer?.(parts.join(','))
    }
  }, [selected, showCustom, customText, onAnswer])

  const handleCustomKeyDown: TextareaHTMLAttributes<HTMLTextAreaElement>['onKeyDown'] = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  const canSubmit = selected.size > 0 || (showCustom && customText.trim().length > 0)

  return (
    <div>
      <div className="space-y-1.5">
        {options.map((option, idx) => {
          const value = option.label
          const key = `${idx}-${option.label}`
          return (
            <label
              key={key}
              className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-700/50"
            >
              <input
                type="checkbox"
                value={value}
                checked={selected.has(value)}
                onChange={() => toggle(value)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded text-neutral-500 focus:ring-neutral-400"
              />
              <OptionContent option={option} />
            </label>
          )
        })}
      </div>
      {/* Toggle custom input */}
      <button
        type="button"
        onClick={() => setShowCustom(!showCustom)}
        className={
          'mt-2 flex items-center gap-1.5 rounded px-2 py-1 text-sm transition-colors ' +
          (showCustom
            ? 'bg-neutral-100 text-secondary ring-1 ring-neutral-300'
            : 'text-tertiary hover:bg-neutral-100 dark:hover:bg-neutral-700/50')
        }
      >
        <PencilLine className="h-3.5 w-3.5" />
        <span>{t('questionCard.customInput')}</span>
      </button>
      {showCustom && (
        <div className="mt-2">
          <textarea
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={handleCustomKeyDown}
            placeholder={t('questionCard.placeholder')}
            rows={2}
            className="w-full break-words rounded-md border border-border bg-card px-3 py-2 text-sm placeholder:text-tertiary focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400"
          />
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={handleSubmit}
          className="rounded-md bg-primary-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-primary-500 dark:hover:bg-primary-600"
        >
          {t('questionCard.submit')}
        </button>
        <SkipButton onSkip={onSkip} />
      </div>
    </div>
  )
}

function FreeTextInput({
  defaultAnswer,
  onAnswer,
  onSkip,
}: {
  defaultAnswer?: string
  onAnswer?: (answer: string) => void
  onSkip?: () => void
}) {
  const t = useT()
  const [text, setText] = useState(defaultAnswer ?? '')
  const handleSubmit = useCallback(() => {
    if (text.trim()) {
      onAnswer?.(text.trim())
    }
  }, [text, onAnswer])

  const handleKeyDown: TextareaHTMLAttributes<HTMLTextAreaElement>['onKeyDown'] = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('questionCard.placeholder')}
        rows={3}
        className="w-full break-words rounded-md border border-border bg-card px-3 py-2 text-sm placeholder:text-tertiary focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400"
      />
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[10px] text-tertiary">
          {t('questionCard.submitHint')}
        </span>
        <div className="flex items-center gap-2">
          <SkipButton onSkip={onSkip} />
          <button
            type="button"
            disabled={!text.trim()}
            onClick={handleSubmit}
            className="rounded-md bg-primary-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-primary-500 dark:hover:bg-primary-600"
          >
            {t('questionCard.submit')}
          </button>
        </div>
      </div>
    </div>
  )
}