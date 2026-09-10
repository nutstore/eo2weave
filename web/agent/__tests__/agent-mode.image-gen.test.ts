/**
 * Pins the R2.3 decision (image-generation PRD, decided 2026-09-10):
 * generate_image is EXEMPT from the Plan-mode write gate.
 *
 * Rationale: the tool writes only into the OPFS assets directory — never
 * workspace files — so Plan mode can generate images directly ("随手画" must
 * not require a mode switch). This test locks the classification so a future
 * refactor cannot silently re-gate it.
 */
import { describe, expect, it } from 'vitest'
import {
  getToolCategory,
  isToolAllowedInMode,
  TOOL_MODE_CLASSIFICATION,
  type AgentMode,
} from '../agent-mode'

describe('generate_image Plan-mode exemption (R2.3)', () => {
  it('is classified as read (not write)', () => {
    expect(getToolCategory('generate_image')).toBe('read')
  })

  it('is allowed in Plan mode', () => {
    const modes: AgentMode[] = ['plan', 'act']
    for (const mode of modes) {
      expect(isToolAllowedInMode('generate_image', mode)).toBe(true)
    }
  })

  it('documents its limited write scope via planModeDescription', () => {
    const meta = TOOL_MODE_CLASSIFICATION.get('generate_image')
    expect(meta?.planModeDescription).toBeTruthy()
    expect(meta?.planModeDescription).toContain('assets')
  })

  it('did not accidentally loosen the real write tools', () => {
    // Guardrail: the exemption is for generate_image only — workspace-mutating
    // tools must stay write-gated in Plan mode.
    for (const name of ['write', 'edit', 'delete', 'snapshot_restore', 'sync-to-opfs']) {
      expect(getToolCategory(name)).toBe('write')
      expect(isToolAllowedInMode(name, 'plan')).toBe(false)
    }
  })
})
