/**
 * Boundary tests for the app-tools execution path: argument parsing against the
 * registered APP_TOOLS schemas, plus the runAppTool wiring the registration
 * path uses (register.ts calls exactly this function).
 */

import { describe, expect, it, vi } from 'vitest'
import { APP_TOOLS } from '../schemas'
import { parseToolArgs, runAppTool } from '../parse-args'

function tool(name: string) {
  const def = APP_TOOLS.find((t) => t.name === name)
  if (!def) throw new Error(`missing tool ${name}`)
  return def
}

describe('parseToolArgs', () => {
  it('rejects non-object arguments', () => {
    const def = tool('list_projects')
    for (const raw of ['{}', 42, true, []]) {
      const parsed = parseToolArgs(def, raw)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error).toContain('arguments must be an object')
    }
  })

  it('normalizes omitted and null arguments to an empty object', () => {
    const parsed = parseToolArgs(tool('list_projects'), null)
    expect(parsed).toEqual({ ok: true, value: {} })
    expect(parseToolArgs(tool('list_projects'), undefined)).toEqual({ ok: true, value: {} })
  })

  it('reports missing required fields', () => {
    const parsed = parseToolArgs(tool('send_message'), { conversationId: 'c_1' })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error).toContain('send_message')
      expect(parsed.error).toContain('content')
    }
  })

  it('rejects a null required field even though null top-level arguments are allowed', () => {
    const parsed = parseToolArgs(tool('create_project'), { name: null })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('missing required field "name"')
  })

  it('rejects values that would previously have been coerced', () => {
    const wait = parseToolArgs(tool('send_message'), {
      conversationId: 'c_1',
      content: 'x',
      wait: 'false',
    })
    expect(wait.ok).toBe(false)
    if (!wait.ok) expect(wait.error).toContain('"wait" must be a boolean')

    const limit = parseToolArgs(tool('list_conversations'), { limit: '20' })
    expect(limit.ok).toBe(false)
    if (!limit.ok) expect(limit.error).toContain('"limit" must be a number')
  })

  it('accepts optional fields omitted and keeps additional fields', () => {
    const parsed = parseToolArgs(tool('list_conversations'), { limit: 5, extra: 'ignored' })
    expect(parsed).toEqual({ ok: true, value: { limit: 5, extra: 'ignored' } })
  })
})

describe('runAppTool', () => {
  it('passes parsed arguments to the handler and returns its content', async () => {
    const handler = vi.fn(async () => ({ content: '{"ok":true}' }))
    const out = await runAppTool(tool('list_projects'), handler, null)
    expect(handler).toHaveBeenCalledWith({})
    expect(out).toBe('{"ok":true}')
  })

  it('never invokes the handler when the boundary rejects the arguments', async () => {
    const handler = vi.fn(async () => ({ content: '{}' }))
    const out = await runAppTool(tool('send_message'), handler, { conversationId: 'c_1' })
    expect(handler).not.toHaveBeenCalled()
    expect(JSON.parse(out).error).toContain('content')
  })

  it('keeps the JSON error shape for handler failures', async () => {
    const handler = vi.fn(async () => {
      throw new Error('workspace setup exploded')
    })
    const out = await runAppTool(tool('list_projects'), handler, {})
    expect(JSON.parse(out)).toEqual({ error: 'workspace setup exploded' })
  })

  it('drives every registered tool definition', () => {
    for (const def of APP_TOOLS) {
      // Registration wires `runAppTool` with this exact def — a schema that the
      // parser cannot normalize would fail here rather than at call time.
      expect(parseToolArgs(def, {}).ok).toBe(def.inputSchema.required == null || def.inputSchema.required.length === 0)
    }
  })
})
