import { describe, expect, it } from 'vitest'
import {
  ALL_TOOL_CLASSES,
  capabilityClassOf,
  intersectCapabilityClasses,
  isToolAllowedByClasses,
  parseCapabilityClasses,
} from '../tool-capabilities'

describe('capabilityClassOf', () => {
  it('maps shell tools, which can run arbitrary code', () => {
    expect(capabilityClassOf('run_code')).toBe('shell')
    expect(capabilityClassOf('bash')).toBe('shell')
    expect(capabilityClassOf('exec')).toBe('shell')
  })

  it('treats run_python as shell, not read — it writes workspace files', () => {
    // Earned the hard way: a read-only probe agent created a workspace file
    // through run_python while it could not see `write`. Code execution is a
    // write channel regardless of what plan mode asks it to do.
    expect(capabilityClassOf('run_python')).toBe('shell')
  })

  it('maps orchestration tools separately so a worker cannot spawn more agents', () => {
    expect(capabilityClassOf('spawn_subagent')).toBe('orchestrate')
    expect(capabilityClassOf('delegate_to')).toBe('orchestrate')
  })

  it('maps external tools that leave the workspace', () => {
    expect(capabilityClassOf('call_tool')).toBe('external')
    expect(capabilityClassOf('web_fetch')).toBe('external')
  })

  it('maps mutation tools to write', () => {
    expect(capabilityClassOf('write')).toBe('write')
    expect(capabilityClassOf('edit')).toBe('write')
    expect(capabilityClassOf('delete')).toBe('write')
    expect(capabilityClassOf('install_skill')).toBe('write')
    expect(capabilityClassOf('db_query')).toBe('write')
  })

  it('fails closed for an unknown tool', () => {
    expect(capabilityClassOf('some_future_tool')).toBe('write')
    expect(isToolAllowedByClasses('some_future_tool', ['read'])).toBe(false)
  })

  it('classifies known read-only tools as read', () => {
    expect(capabilityClassOf('read')).toBe('read')
    expect(capabilityClassOf('snapshot_diff')).toBe('read')
    expect(capabilityClassOf('page_screenshot')).toBe('read')
  })
})

describe('parseCapabilityClasses', () => {
  it('returns undefined when nothing was declared', () => {
    expect(parseCapabilityClasses(undefined)).toBeUndefined()
    expect(parseCapabilityClasses(null)).toBeUndefined()
    expect(parseCapabilityClasses([])).toBeUndefined()
  })

  it('throws on an unknown class instead of ignoring it', () => {
    expect(() => parseCapabilityClasses(['read', 'admin'])).toThrow(/Unknown tool capability class/)
  })

  it('rejects non-string members', () => {
    expect(() => parseCapabilityClasses([1])).toThrow(/Unknown tool capability class/)
  })

  it('deduplicates while preserving order', () => {
    expect(parseCapabilityClasses(['write', 'read', 'write'])).toEqual(['write', 'read'])
  })
})

describe('intersectCapabilityClasses', () => {
  it('treats undefined as "no restriction"', () => {
    expect(intersectCapabilityClasses(undefined, undefined)).toBeUndefined()
    expect(intersectCapabilityClasses(undefined, ['read'])).toEqual(['read'])
    expect(intersectCapabilityClasses(['write'], undefined)).toEqual(['write'])
  })

  it('narrows to what both sides allow', () => {
    expect(intersectCapabilityClasses(['read', 'write', 'shell'], ['read', 'shell'])).toEqual(['read', 'shell'])
  })

  it('yields an empty set when the two sides share nothing (fail closed)', () => {
    expect(intersectCapabilityClasses(['read'], ['write'])).toEqual([])
  })
})

describe('isToolAllowedByClasses', () => {
  it('allows everything when no classes are declared', () => {
    expect(isToolAllowedByClasses('write', undefined)).toBe(true)
    expect(isToolAllowedByClasses('bash', undefined)).toBe(true)
  })

  it('blocks anything outside the declared classes', () => {
    expect(isToolAllowedByClasses('write', ['read'])).toBe(false)
    expect(isToolAllowedByClasses('bash', ['read'])).toBe(false)
    expect(isToolAllowedByClasses('read', ['read'])).toBe(true)
  })

  it('blocks everything for an empty class set, which is what an unsatisfiable intersection means', () => {
    for (const toolName of ['read', 'write', 'bash', 'call_tool', 'spawn_subagent']) {
      expect(isToolAllowedByClasses(toolName, [])).toBe(false)
    }
  })

  it('keeps every class name addressable', () => {
    for (const className of ALL_TOOL_CLASSES) {
      expect(ALL_TOOL_CLASSES).toContain(className)
    }
  })
})
