/**
 * App-tool argument boundary tests.
 *
 * Two layers:
 * - parseToolArguments() — the pure validator (rules come from APP_TOOLS, so
 *   there is no second copy of the contract to drift).
 * - buildToolExecutors() — the exact executors register.ts registers on
 *   document.modelContext. These prove the boundary is wired into the public
 *   registration path and that malformed arguments never reach a handler or a
 *   business dependency.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { APP_TOOLS } from '../schemas'
import type { AppToolDefinition } from '../schemas'
import { parseToolArguments } from '../validate-args'
import { buildToolExecutors, initAppToolDeps } from '../handlers'
import { makeDeps } from './fixtures'

function tool(name: string): AppToolDefinition {
  const def = APP_TOOLS.find((t) => t.name === name)
  if (!def) throw new Error(`unknown tool in test: ${name}`)
  return def
}

function parseError(name: string, raw: unknown): string {
  const result = parseToolArguments(tool(name), raw)
  if (result.ok) throw new Error(`expected ${name} to reject ${JSON.stringify(raw)}`)
  return result.error
}

describe('parseToolArguments', () => {
  it('normalizes omitted and null arguments to {} for tools without required fields', () => {
    for (const raw of [undefined, null]) {
      const result = parseToolArguments(tool('list_projects'), raw)
      expect(result).toEqual({ ok: true, args: {} })
    }
  })

  it('reports the missing required field (tool + field) for omitted and null arguments', () => {
    expect(parseError('create_project', undefined)).toMatch(/create_project.*name/)
    expect(parseError('create_project', null)).toMatch(/create_project.*name/)
    expect(parseError('send_message', { conversationId: 'c_1' })).toMatch(/send_message.*content/)
  })

  it('rejects arrays and non-object primitives explicitly', () => {
    expect(parseError('list_conversations', [])).toMatch(/list_conversations.*array/)
    expect(parseError('list_conversations', [{ limit: 1 }])).toMatch(/list_conversations.*array/)
    expect(parseError('list_projects', 'nope')).toMatch(/list_projects.*string/)
    expect(parseError('list_projects', 42)).toMatch(/list_projects.*number/)
    expect(parseError('list_projects', true)).toMatch(/list_projects.*boolean/)
  })

  it('rejects declared field-type mismatches instead of coercing them', () => {
    // The two documented cases: `wait: "false"` and `limit: "20"`.
    const wait = parseError('send_message', { conversationId: 'c_1', content: 'x', wait: 'false' })
    expect(wait).toMatch(/send_message/)
    expect(wait).toMatch(/"wait"/)
    expect(wait).toMatch(/boolean/)

    const limit = parseError('list_conversations', { limit: '20' })
    expect(limit).toMatch(/list_conversations/)
    expect(limit).toMatch(/"limit"/)
    expect(limit).toMatch(/number/)

    expect(parseError('create_project', { name: 42 })).toMatch(/"name".*string/)
    expect(parseError('list_conversations', { offset: true })).toMatch(/"offset".*number/)
  })

  it('rejects non-finite numbers on numeric fields', () => {
    expect(parseError('list_conversations', { limit: Number.NaN })).toMatch(/"limit".*number/)
  })

  it('accepts omitted optional fields and treats null as omitted', () => {
    expect(parseToolArguments(tool('list_conversations'), {})).toEqual({ ok: true, args: {} })
    expect(parseToolArguments(tool('list_conversations'), { limit: null })).toEqual({
      ok: true,
      args: { limit: null },
    })
  })

  it('allows additional fields (the schemas do not forbid them)', () => {
    const raw = { providerId: 'openai', modelId: 'gpt-4o', futureFlag: 'ok' }
    const result = parseToolArguments(tool('add_pinned_model'), raw)
    expect(result).toEqual({ ok: true, args: raw })
  })

  it('passes valid arguments through unchanged', () => {
    const raw = { conversationId: 'c_1', content: 'do it', wait: true, timeoutMs: 5000 }
    expect(parseToolArguments(tool('send_message'), raw)).toEqual({ ok: true, args: raw })
  })
})

describe('tool argument boundary wiring', () => {
  beforeEach(() => {
    initAppToolDeps(makeDeps())
  })

  it('registers a validating executor for every declared tool', async () => {
    const executors = buildToolExecutors()
    expect(executors.size).toBe(APP_TOOLS.length)
    for (const def of APP_TOOLS) {
      const executor = executors.get(def.name)
      expect(executor).toBeTypeOf('function')
      // An array can never be a valid argument object, so this exercises the
      // boundary for every tool without touching a single dependency.
      const out = await executor?.([1, 2, 3])
      const payload = JSON.parse(out?.content ?? '{}')
      expect(payload.error).toContain(def.name)
      expect(payload.error).toMatch(/array/)
    }
  })

  it('returns the JSON { error } shape and never calls a dependency on invalid arguments', async () => {
    initAppToolDeps(makeDeps({
      getConversationStore: () => {
        throw new Error('business dependency must not be touched for invalid arguments')
      },
      getSettingsStore: () => {
        throw new Error('business dependency must not be touched for invalid arguments')
      },
      getWorkspaceRepository: () => {
        throw new Error('business dependency must not be touched for invalid arguments')
      },
    }))
    const executors = buildToolExecutors()

    const badWait = JSON.parse((await executors.get('send_message')?.({ conversationId: 'c_1', content: 'x', wait: 'false' }))?.content ?? '{}')
    expect(badWait.error).toMatch(/send_message/)
    expect(badWait.error).toMatch(/"wait"/)

    const badLimit = JSON.parse((await executors.get('list_conversations')?.({ limit: '20' }))?.content ?? '{}')
    expect(badLimit.error).toMatch(/list_conversations/)
    expect(badLimit.error).toMatch(/"limit"/)

    const missing = JSON.parse((await executors.get('send_message')?.({}))?.content ?? '{}')
    expect(missing.error).toMatch(/missing required field "conversationId"/)
  })

  it('lets valid calls through to the handler (omitted arguments included)', async () => {
    const executors = buildToolExecutors()
    const listed = JSON.parse((await executors.get('list_conversations')?.(undefined))?.content ?? '{}')
    expect(listed.conversations).toHaveLength(1)

    const messages = JSON.parse((await executors.get('get_messages')?.({ conversationId: 'c_1' }))?.content ?? '{}')
    expect(messages.messages).toHaveLength(2)

    const errored = JSON.parse((await executors.get('get_run_status')?.({ runId: 'ghost' }))?.content ?? '{}')
    expect(errored.error).toMatch(/Unknown runId/)
  })

  it('keeps handler business validation intact after the boundary accepts the shape', async () => {
    const executors = buildToolExecutors()
    // Shape is valid (string), business rules still reject it.
    const blank = JSON.parse((await executors.get('create_project')?.({ name: '   ' }))?.content ?? '{}')
    expect(blank.error).toMatch(/name is required/)

    // An over-cap limit is a valid *shape*; the handler still applies its cap.
    const capped = JSON.parse((await executors.get('list_conversations')?.({ limit: 5000 }))?.content ?? '{}')
    expect(capped.error).toBeUndefined()
    expect(capped.conversations).toHaveLength(1)
  })
})
