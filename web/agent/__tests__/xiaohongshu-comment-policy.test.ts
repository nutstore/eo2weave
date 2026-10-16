// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMMENT_POLICY, normalizeCommentTarget, skipReplyControl, commentScrollDelta } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-comment-policy'

afterEach(() => vi.restoreAllMocks())

describe('upstream comment policy decisions', () => {
  it('retains upstream defaults', () => {
    expect(COMMENT_POLICY).toMatchObject({ parentTarget: 20, replyLimit: 10, clickAttempts: 3, buttonClickInterval: 3, largeScrollTrigger: 5, stagnantLimit: 20 })
  })
  it.each([undefined, 0, -1])('normalizes nonpositive or omitted targets %s to defaults', (value) => {
    expect(normalizeCommentTarget(value, 20)).toBe(20)
    expect(normalizeCommentTarget(value, 10)).toBe(10)
  })
  it.each(['20', null, true, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects noninteger targets %s', (value) => {
    expect(normalizeCommentTarget(value, 20)).toBeNull()
  })
  it('preserves explicit targets and threshold boundaries', () => {
    expect(normalizeCommentTarget(25, 20)).toBe(25)
    expect(skipReplyControl('展开 10 条回复', 10)).toBe(false)
    expect(skipReplyControl('展开 11 条回复', 10)).toBe(true)
    expect(skipReplyControl('展开更多回复', 10)).toBe(false)
  })
  it('uses upstream speed ratios and large-scroll multiplier', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(commentScrollDelta(1000, 'slow', false)).toBe(600)
    expect(commentScrollDelta(1000, 'normal', false)).toBeCloseTo(800)
    expect(commentScrollDelta(1000, 'fast', false)).toBe(1000)
    expect(commentScrollDelta(1000, 'normal', true)).toBeCloseTo(1500)
    expect(commentScrollDelta(100, 'slow', false)).toBe(400)
  })
})
