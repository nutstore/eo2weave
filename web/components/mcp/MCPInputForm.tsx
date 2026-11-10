'use client'
import { useId, useState } from 'react'
import {
  BrandButton,
  BrandCheckbox,
  BrandInput,
  BrandSelect,
  BrandSelectContent,
  BrandSelectItem,
  BrandSelectTrigger,
  BrandSelectValue,
} from '@creatorweave/ui'
import { useT } from '@/i18n'
import type { PendingMCPInput } from '@/mcp/input-manager'
import { getMCPInputManager } from '@/mcp/input-manager'
import type { ApplicationElicitContentValue } from '@modelcontextprotocol/ext-tasks/client'

const fieldClass = 'h-8 rounded-md px-2 py-1.5 text-sm'
const buttonClass = 'h-8 rounded-md px-2.5 py-1.5 text-xs'
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function enumOptions(schema: Record<string, unknown>): Array<{ value: string; label: string }> {
  if (Array.isArray(schema.enum))
    return schema.enum.map((value) => ({ value: String(value), label: String(value) }))
  const variants = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : []
  return variants.flatMap((value) =>
    record(value) && typeof value.const === 'string'
      ? [{ value: value.const, label: typeof value.title === 'string' ? value.title : value.const }]
      : []
  )
}
function sensitiveField(name: string, schema: Record<string, unknown>): boolean {
  return (
    /password|secret|credential|api.?key|token/i.test(`${name} ${JSON.stringify(schema)}`) ||
    schema.writeOnly === true
  )
}
function selectionBounds(schema: Record<string, unknown>) {
  const bound = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
  return { min: bound(schema.minItems) ?? 0, max: bound(schema.maxItems) }
}

export function MCPInputForm({ input }: { input: PendingMCPInput }) {
  const t = useT()
  const formId = useId()
  const [values, setValues] = useState<Record<string, ApplicationElicitContentValue>>(() => {
    const params = input.request.params ?? {}
    const schema = record(params.requestedSchema) ? params.requestedSchema : {}
    const fields = record(schema.properties) ? schema.properties : {}
    const values: Record<string, ApplicationElicitContentValue> = {}
    for (const [name, raw] of Object.entries(fields)) {
      if (!record(raw) || sensitiveField(name, raw)) continue
      if (raw.type === 'boolean')
        values[name] = typeof raw.default === 'boolean' ? raw.default : false
      else if (typeof raw.default === 'string' || typeof raw.default === 'number')
        values[name] = raw.default
      else if (Array.isArray(raw.default) && raw.default.every((item) => typeof item === 'string'))
        values[name] = raw.default
      else if (
        raw.type === 'array' &&
        Array.isArray(schema.required) &&
        schema.required.includes(name)
      )
        values[name] = []
    }
    return values
  })
  const [error, setError] = useState('')
  const [showSelectionErrors, setShowSelectionErrors] = useState(false)
  const [busy, setBusy] = useState(false)
  const [opened, setOpened] = useState(false)
  const params = input.request.params ?? {}
  const schema = record(params.requestedSchema) ? params.requestedSchema : {}
  const fields = record(schema.properties) ? schema.properties : {}
  const selectionErrors: Record<string, string> = {}
  for (const [name, field] of Object.entries(fields)) {
    if (
      !record(field) ||
      field.type !== 'array' ||
      !record(field.items) ||
      !enumOptions(field.items).length
    )
      continue
    const required = Array.isArray(schema.required) && schema.required.includes(name)
    const value = values[name]
    if (value === undefined && !required) continue
    const count = Array.isArray(value) ? value.length : 0
    const { min, max } = selectionBounds(field)
    if (count < min) selectionErrors[name] = t('mcp.tasks.selectionMinimum', { min })
    else if (max !== undefined && count > max)
      selectionErrors[name] = t('mcp.tasks.selectionMaximum', { max })
  }
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const respond = async (action: 'accept' | 'decline' | 'cancel') => {
    if (action === 'accept' && params.mode !== 'url') {
      setShowSelectionErrors(true)
      setError('')
      if (Object.keys(selectionErrors).length) return
    }
    await run(() =>
      getMCPInputManager().respond(input.id, {
        action,
        ...(action === 'accept' && params.mode !== 'url' ? { content: values } : {}),
      })
    )
  }
  const url =
    typeof params.url === 'string' && /^https?:\/\//i.test(params.url) ? params.url : undefined
  if (input.error)
    return (
      <div
        role="alert"
        className="rounded-lg border border-amber-300 p-3 text-xs text-amber-700 dark:text-amber-400"
      >
        {input.serverId}: {input.error}
      </div>
    )
  return (
    <div className="space-y-3 rounded-lg border border-amber-300/60 bg-amber-50/40 p-3 dark:bg-amber-950/10">
      <p className="text-xs font-semibold">
        {input.serverId} ·{' '}
        {t(input.request.kind === 'sampling' ? 'mcp.tasks.sampling' : 'mcp.tasks.input')}
      </p>
      {typeof params.message === 'string' ? (
        <p className="whitespace-pre-wrap text-sm">{params.message}</p>
      ) : null}
      {input.request.kind === 'sampling' ? (
        <>
          <p className="text-xs">
            {input.sampling?.model} · {t('mcp.tasks.budget')}: {input.sampling?.maxTokens}
          </p>
          <p className="text-xs text-neutral-500">{t('mcp.tasks.samplingNotice')}</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-100 p-2 text-xs dark:bg-neutral-800">
            {JSON.stringify(params, null, 2)}
          </pre>
          <div className="flex gap-2">
            <BrandButton
              type="button"
              variant="primary"
              className={buttonClass}
              disabled={busy}
              onClick={() => run(() => getMCPInputManager().confirmSampling(input.id, true))}
            >
              {t('mcp.tasks.approveSampling')}
            </BrandButton>
            <BrandButton
              type="button"
              variant="outline"
              className={buttonClass}
              disabled={busy}
              onClick={() => run(() => getMCPInputManager().confirmSampling(input.id, false))}
            >
              {t('mcp.tasks.decline')}
            </BrandButton>
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void respond('accept')
          }}
          className="space-y-3"
        >
          {params.mode === 'url' ? (
            <>
              <p className="text-xs text-neutral-500">{t('mcp.tasks.urlNotice')}</p>
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-sm text-primary-600 underline"
                  onClick={() => setOpened(true)}
                >
                  {url}
                </a>
              ) : (
                <p role="alert">{t('mcp.tasks.invalidUrl')}</p>
              )}
            </>
          ) : (
            Object.entries(fields).map(([name, raw], index) => {
              if (!record(raw)) return null
              const title = typeof raw.title === 'string' ? raw.title : name
              const required = Array.isArray(schema.required) && schema.required.includes(name)
              const array = raw.type === 'array'
              const choices = enumOptions(array && record(raw.items) ? raw.items : raw)
              const sensitive = sensitiveField(name, raw)
              const fieldId = `${formId}-${index}`
              const labelId = `${fieldId}-label`
              const descriptionId =
                typeof raw.description === 'string' ? `${fieldId}-description` : undefined
              const selectedChoice = choices.findIndex(
                (choice) => choice.value === String(values[name])
              )
              const selectedValues = Array.isArray(values[name]) ? (values[name] as string[]) : []
              const { min, max } = selectionBounds(raw)
              const selectionHintId = `${fieldId}-selection-hint`
              const selectionError = showSelectionErrors ? selectionErrors[name] : undefined
              const selectionErrorId = selectionError ? `${fieldId}-error` : undefined
              const selectionHint =
                max !== undefined && min === max
                  ? t('mcp.tasks.selectionExact', { count: min })
                  : min > 0 && max !== undefined
                    ? t('mcp.tasks.selectionRange', { min, max })
                    : min > 0
                      ? t('mcp.tasks.selectionMinimum', { min })
                      : max !== undefined
                        ? t('mcp.tasks.selectionMaximum', { max })
                        : undefined
              return (
                <div key={name} className="space-y-1 text-xs font-medium">
                  <label id={labelId} htmlFor={array && choices.length ? undefined : fieldId}>
                    {title}
                    {required ? <span aria-hidden="true"> *</span> : null}
                  </label>
                  {typeof raw.description === 'string' ? (
                    <span id={descriptionId} className="block font-normal text-neutral-500">
                      {raw.description}
                    </span>
                  ) : null}
                  {raw.type === 'boolean' ? (
                    <BrandCheckbox
                      id={fieldId}
                      size="sm"
                      aria-describedby={descriptionId}
                      disabled={busy}
                      checked={values[name] === true}
                      onCheckedChange={(checked) =>
                        setValues((current) => ({ ...current, [name]: checked === true }))
                      }
                    />
                  ) : choices.length && array ? (
                    <>
                      <p
                        id={selectionHintId}
                        className="flex flex-wrap justify-between gap-x-2 text-xs font-normal text-neutral-500 dark:text-neutral-400"
                      >
                        {selectionHint ? <span>{selectionHint}</span> : null}
                        <span role="status">
                          {t('mcp.tasks.selectionCount', { count: selectedValues.length })}
                        </span>
                      </p>
                      <div
                        role="group"
                        aria-labelledby={labelId}
                        aria-describedby={[descriptionId, selectionHintId, selectionErrorId]
                          .filter(Boolean)
                          .join(' ')}
                        aria-invalid={selectionError ? true : undefined}
                        className={`max-h-40 space-y-1 overflow-y-auto rounded-md border p-2 ${selectionError ? 'border-red-500 dark:border-red-400' : 'border-neutral-200 dark:border-neutral-700'}`}
                      >
                        {choices.map((choice, choiceIndex) => (
                          <label
                            key={choiceIndex}
                            className="flex cursor-pointer items-center gap-2 py-1 font-normal has-[:disabled]:cursor-not-allowed has-[:disabled]:text-neutral-400"
                          >
                            <BrandCheckbox
                              size="sm"
                              disabled={
                                busy ||
                                (max !== undefined &&
                                  selectedValues.length >= max &&
                                  !selectedValues.includes(choice.value))
                              }
                              checked={selectedValues.includes(choice.value)}
                              onCheckedChange={(checked) =>
                                setValues((current) => {
                                  const selected = Array.isArray(current[name])
                                    ? (current[name] as string[])
                                    : []
                                  if (
                                    checked === true &&
                                    max !== undefined &&
                                    selected.length >= max &&
                                    !selected.includes(choice.value)
                                  )
                                    return current
                                  const next =
                                    checked === true
                                      ? [...selected, choice.value]
                                      : selected.filter((value) => value !== choice.value)
                                  const updated = { ...current }
                                  const selection = choices
                                    .filter((option) => next.includes(option.value))
                                    .map((option) => option.value)
                                  // Clearing an optional field omits it; minItems applies to supplied arrays.
                                  if (!required && !selection.length) delete updated[name]
                                  else updated[name] = selection
                                  return updated
                                })
                              }
                            />
                            <span>{choice.label}</span>
                          </label>
                        ))}
                      </div>
                      {selectionError ? (
                        <p
                          id={selectionErrorId}
                          role="alert"
                          className="text-xs font-normal text-red-600 dark:text-red-400"
                        >
                          {selectionError}
                        </p>
                      ) : null}
                    </>
                  ) : choices.length ? (
                    <BrandSelect
                      name={fieldId}
                      required={required}
                      disabled={busy}
                      value={
                        values[name] === undefined || selectedChoice < 0
                          ? ''
                          : String(selectedChoice)
                      }
                      onValueChange={(value) =>
                        setValues((current) => {
                          const next = { ...current }
                          if (value === 'unset') delete next[name]
                          else {
                            // Radix item values cannot be empty; indices preserve all wire values.
                            const choice = choices[Number(value)]
                            if (choice)
                              next[name] =
                                raw.type === 'number' || raw.type === 'integer'
                                  ? Number(choice.value)
                                  : choice.value
                          }
                          return next
                        })
                      }
                    >
                      <BrandSelectTrigger
                        id={fieldId}
                        aria-describedby={descriptionId}
                        className={fieldClass}
                      >
                        <BrandSelectValue placeholder={t('mcp.tasks.select')} />
                      </BrandSelectTrigger>
                      <BrandSelectContent>
                        {!required ? (
                          <BrandSelectItem value="unset">{t('mcp.tasks.select')}</BrandSelectItem>
                        ) : null}
                        {choices.map((choice, choiceIndex) => (
                          <BrandSelectItem key={choiceIndex} value={String(choiceIndex)}>
                            {choice.label}
                          </BrandSelectItem>
                        ))}
                      </BrandSelectContent>
                    </BrandSelect>
                  ) : (
                    <BrandInput
                      id={fieldId}
                      aria-describedby={descriptionId}
                      disabled={busy}
                      type={
                        sensitive
                          ? 'password'
                          : raw.type === 'number' || raw.type === 'integer'
                            ? 'number'
                            : raw.format === 'email'
                              ? 'email'
                              : 'text'
                      }
                      autoComplete={sensitive ? 'new-password' : 'off'}
                      className={fieldClass}
                      required={required}
                      min={typeof raw.minimum === 'number' ? raw.minimum : undefined}
                      max={typeof raw.maximum === 'number' ? raw.maximum : undefined}
                      minLength={typeof raw.minLength === 'number' ? raw.minLength : undefined}
                      maxLength={typeof raw.maxLength === 'number' ? raw.maxLength : undefined}
                      step={raw.type === 'integer' ? 1 : 'any'}
                      value={String(values[name] ?? '')}
                      onChange={(event) => {
                        const value = event.target.value
                        setValues((current) => {
                          const next = { ...current }
                          if (!value) delete next[name]
                          else
                            next[name] =
                              raw.type === 'number' || raw.type === 'integer'
                                ? Number(value)
                                : value
                          return next
                        })
                      }}
                    />
                  )}
                </div>
              )
            })
          )}
          {input.sensitive ? (
            <p className="text-xs text-neutral-500">{t('mcp.tasks.sensitiveNotice')}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <BrandButton
              type="submit"
              variant="primary"
              className={buttonClass}
              disabled={busy || (params.mode === 'url' && (!url || !opened))}
            >
              {t('mcp.tasks.accept')}
            </BrandButton>
            <BrandButton
              type="button"
              variant="outline"
              className={buttonClass}
              disabled={busy}
              onClick={() => respond('decline')}
            >
              {t('mcp.tasks.decline')}
            </BrandButton>
            <BrandButton
              type="button"
              variant="ghost"
              className={buttonClass}
              disabled={busy}
              onClick={() => respond('cancel')}
            >
              {t('mcp.tasks.dismiss')}
            </BrandButton>
          </div>
        </form>
      )}
      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  )
}
