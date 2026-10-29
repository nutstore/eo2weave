// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  PAGE_ACTION_REQUEST_ID_KEY,
  stablePageActionRequestId,
} from '../../../browser-extension/lib/bash-commands/browser/page-action-request-identity'

/**
 * Sourcery follow-up on PR #110: a retry of the same logical page action
 * (the realistic case after a bridge timeout) must derive the SAME
 * request identity so the background's in-flight dedupe joins the first
 * execution instead of queueing a duplicate one. The id is therefore
 * content-addressed, and stable across callers, invocations and
 * property insertion order.
 */

describe('stablePageActionRequestId (retry identity)', () => {
  it('gives the SAME id to a retry of the same logical action', () => {
    const action = { type: 'click', locator: { selector: '#submit' } }
    const first = stablePageActionRequestId(action)
    // A fresh object, as a retried caller would build it.
    const retry = { type: 'click', locator: { selector: '#submit' } }
    expect(stablePageActionRequestId(retry)).toBe(first)
    expect(first).not.toBe('')
  })

  it('gives DIFFERENT ids to different actions', () => {
    const a = stablePageActionRequestId({ type: 'click', locator: { selector: '#a' } })
    const b = stablePageActionRequestId({ type: 'click', locator: { selector: '#b' } })
    const c = stablePageActionRequestId({ type: 'fill', locator: { selector: '#a' }, value: 'x' })
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })

  it('is insertion-order independent for structurally identical actions', () => {
    const a = stablePageActionRequestId({ type: 'fill', value: 'hi', locator: { selector: '#f', role: 'textbox' } })
    const b = stablePageActionRequestId({ locator: { role: 'textbox', selector: '#f' }, type: 'fill', value: 'hi' })
    expect(a).toBe(b)
  })

  it('distinguishes value types and array order', () => {
    expect(stablePageActionRequestId({ type: 'fill', value: '1' })).not.toBe(
      stablePageActionRequestId({ type: 'fill', value: 1 }),
    )
    expect(stablePageActionRequestId({ type: 'type', text: ['a', 'b'] })).not.toBe(
      stablePageActionRequestId({ type: 'type', text: ['b', 'a'] }),
    )
  })

  it('returns empty string for non-object actions and unserializable (cyclic) actions', () => {
    expect(stablePageActionRequestId(null)).toBe('')
    expect(stablePageActionRequestId('click')).toBe('')
    expect(stablePageActionRequestId(42)).toBe('')
    const cyclic: Record<string, unknown> = { type: 'click' }
    cyclic.self = cyclic
    expect(stablePageActionRequestId(cyclic)).toBe('')
  })

  it('exposes the stamp key the background dedupe reads', () => {
    expect(PAGE_ACTION_REQUEST_ID_KEY).toBe('__cwRequestId')
    const action = { type: 'snapshot' }
    const stamped = { ...action, [PAGE_ACTION_REQUEST_ID_KEY]: stablePageActionRequestId(action) }
    expect(stamped.__cwRequestId).toBe(stablePageActionRequestId({ type: 'snapshot' }))
  })
})
