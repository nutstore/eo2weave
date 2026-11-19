/**
 * Tests for QuestionCard.normalizeOption.
 *
 * After the string form was removed, normalizeOption only needs to do two
 * things:
 *   1. Pass through the object form verbatim.
 *   2. Silently coerce legacy string entries (from historical chat data)
 *      to plain labels so old conversations still render.
 *
 * If any of these break, add a regression case here.
 */

import { describe, expect, it } from 'vitest'
import { normalizeOption, type RawOption } from '../QuestionCard.utils'

describe('normalizeOption', () => {
  // ---------------------------------------------------------------------------
  // Object form — primary path
  // ---------------------------------------------------------------------------
  describe('object form (primary path)', () => {
    it('passes through label/description/recommended verbatim', () => {
      expect(
        normalizeOption({
          label: 'PostgreSQL',
          description: 'production-grade',
          recommended: true,
        })
      ).toEqual({
        label: 'PostgreSQL',
        description: 'production-grade',
        recommended: true,
      })
    })

    it('handles missing description (undefined)', () => {
      expect(normalizeOption({ label: 'SQLite' })).toEqual({
        label: 'SQLite',
        description: undefined,
        recommended: false,
      })
    })

    it('handles missing recommended (defaults to false)', () => {
      expect(normalizeOption({ label: 'SQLite', description: 'embedded' })).toEqual({
        label: 'SQLite',
        description: 'embedded',
        recommended: false,
      })
    })

    it('coerces recommended truthy/falsy values to boolean', () => {
      expect(normalizeOption({ label: 'A', recommended: 1 as unknown as boolean }).recommended).toBe(true)
      expect(normalizeOption({ label: 'B', recommended: 0 as unknown as boolean }).recommended).toBe(false)
    })

    it('preserves CJK characters and whitespace inside labels', () => {
      expect(normalizeOption({ label: '  推荐  ', description: '  描述  ' })).toEqual({
        label: '  推荐  ',
        description: '  描述  ',
        recommended: false,
      })
    })
  })

  // ---------------------------------------------------------------------------
  // Legacy string fallback — ONLY for historical chat data
  // ---------------------------------------------------------------------------
  describe('legacy string fallback (historical chat data)', () => {
    // These tests intentionally cast strings via `as unknown as RawOption`
    // because the RawOption type no longer permits strings. The function
    // signature accepts `RawOption | string` for backward compat, and the
    // runtime check `typeof raw === 'string'` handles historical entries
    // found in old tool call records.

    it('treats a plain string as a label-only entry', () => {
      expect(normalizeOption('PostgreSQL' as unknown as RawOption)).toEqual({
        label: 'PostgreSQL',
        description: undefined,
        recommended: false,
      })
    })

    it('does NOT parse ⭐ prefix as a recommended flag', () => {
      // The string form was removed — there is no parsing of leading ⭐,
      // em-dash separators, or a "recommended" marker inside the label. Strings render as-is.
      expect(normalizeOption('⭐ PostgreSQL — 推荐：成熟稳定' as unknown as RawOption)).toEqual({
        label: '⭐ PostgreSQL — 推荐：成熟稳定',
        description: undefined,
        recommended: false,
      })
    })

    it('does NOT split em-dash to extract description', () => {
      expect(normalizeOption('PostgreSQL — production grade' as unknown as RawOption)).toEqual({
        label: 'PostgreSQL — production grade',
        description: undefined,
        recommended: false,
      })
    })

    it('handles empty string gracefully', () => {
      expect(normalizeOption('' as unknown as RawOption)).toEqual({
        label: '',
        description: undefined,
        recommended: false,
      })
    })
  })
})