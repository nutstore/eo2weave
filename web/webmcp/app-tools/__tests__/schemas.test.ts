/**
 * Schema integrity tests — the canary for the WebMCP tool surface.
 * Polyfill validation rules mirrored here (tool name charset, non-empty
 * description, execute presence is enforced by handlers.ts buildToolExecutors).
 */

import { describe, expect, it } from 'vitest'
import { APP_TOOLS } from '../schemas'
import { buildToolExecutors } from '../handlers'

const VALID_NAME = /^[A-Za-z0-9_\-.]{1,128}$/

describe('app-tools schemas', () => {
  it('has 21 tools', () => {
    expect(APP_TOOLS).toHaveLength(21)
  })

  it('every tool has a valid WebMCP name', () => {
    for (const t of APP_TOOLS) expect(t.name).toMatch(VALID_NAME)
  })

  it('every tool has a non-empty description and object inputSchema', () => {
    for (const t of APP_TOOLS) {
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.description.length).toBeLessThanOrEqual(2000)
      expect(t.inputSchema.type).toBe('object')
    }
  })

  it('every tool has a matching handler (buildToolExecutors covers all)', () => {
    const map = buildToolExecutors()
    expect(map.size).toBe(APP_TOOLS.length)
    for (const t of APP_TOOLS) expect(map.has(t.name)).toBe(true)
  })

  it('names are unique', () => {
    const names = APP_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('destructive tools are not present (no delete ops in v1)', () => {
    const names = APP_TOOLS.map((t) => t.name)
    for (const banned of ['delete_conversation', 'delete_project', 'delete_folder', 'delete_messages']) {
      expect(names).not.toContain(banned)
    }
  })
})
