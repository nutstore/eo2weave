import { describe, expect, it, vi } from 'vitest'
import {
  coerceToolArgs,
  executeToolWithTimeout,
  normalizeToolResult,
  truncateLargeToolResult,
} from '../loop/tool-execution'

describe('tool-execution helpers', () => {
  it('coerceToolArgs returns empty object for null and throws on non-object', () => {
    expect(coerceToolArgs(null)).toEqual({})
    expect(() => coerceToolArgs('abc')).toThrow('invalid_arguments')
  })

  it('normalizeToolResult marks envelope errors as isError=true', () => {
    const result = normalizeToolResult(
      JSON.stringify({
        ok: false,
        version: 2,
        tool: 'read',
        error: { code: 'E_TEST', message: 'boom' },
      })
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('E_TEST')
    expect(result.content).toContain('boom')
  })

  it('truncateLargeToolResult treats undefined existingTokens as 0 (first turn)', async () => {
    const raw = JSON.stringify({
      results: [{ path: 'a.ts', line: 1, match: 'x'.repeat(3000), preview: 'x'.repeat(3000) }],
      totalMatches: 1,
      scannedFiles: 1,
    })

    const result = await truncateLargeToolResult({
      rawResult: raw,
      toolName: 'search',
      // existingTokens intentionally omitted — treated as 0 (first turn)
      maxContextTokens: 3000,
      reserveTokens: 200,
      estimateTextTokens: (text) => text.length,
    })

    // Should still truncate — raw is ~6000+ chars, budget = (3000-200-0)*0.9 = 2520
    const parsed = JSON.parse(result)
    expect(parsed.truncated).toBe(true)
    expect(parsed.results).toEqual([])
  })

  it('executeToolWithTimeout prefers the CALL_CANCELLED envelope when the abort race wins (#139 review: cancellation warning gets lost)', async () => {
    const controller = new AbortController()
    const cancelledEnvelope = JSON.stringify({
      ok: false,
      version: 2,
      tool: 'call_tool',
      error: {
        code: 'CALL_CANCELLED',
        message: 'WebMCP tool call was cancelled. The extension call may still be running…',
        retryable: false,
      },
    })

    const raw = await executeToolWithTimeout({
      toolName: 'call_tool',
      args: {},
      timeoutMs: null,
      runAbortSignal: controller.signal,
      preferEnvelopeOnRaceLoss: (envelope) =>
        envelope.includes('CALL_CANCELLED') ? envelope : null,
      // The tool promise settles with the envelope shortly AFTER the abort —
      // the outer race fires first, exactly the production race.
      execute: async () => {
        controller.abort()
        await new Promise((r) => setTimeout(r, 10))
        return cancelledEnvelope
      },
    })

    const parsed = JSON.parse(raw)
    expect(parsed.error.code).toBe('CALL_CANCELLED')
    expect(parsed.error.retryable).toBe(false)
  })

  it('executeToolWithTimeout keeps the abort rejection when no CALL_CANCELLED envelope arrives', async () => {
    const controller = new AbortController()
    let rejectExecute!: (e: Error) => void
    const pending = executeToolWithTimeout({
      toolName: 'read',
      args: {},
      timeoutMs: null,
      runAbortSignal: controller.signal,
      preferEnvelopeOnRaceLoss: (envelope) =>
        envelope.includes('CALL_CANCELLED') ? envelope : null,
      execute: () =>
        new Promise<string>((_, reject) => {
          rejectExecute = reject
        }),
    })

    controller.abort()
    // The tool promise rejects without any cancellation envelope — the
    // original abort rejection must survive.
    rejectExecute(new Error('bridge blew up'))
    await expect(pending).rejects.toThrow('was aborted')
  })

  it('executeToolWithTimeout fires onTimeout exactly once when the cancellation envelope replaces the timeout rejection (#139 review: timeout callback is skipped)', async () => {
    vi.useFakeTimers()
    try {
      const cancelledEnvelope = JSON.stringify({
        ok: false,
        version: 2,
        tool: 'call_tool',
        error: { code: 'CALL_CANCELLED', message: 'cancelled', retryable: false },
      })
      const onTimeout = vi.fn()
      // No abort signal: the timeout is the only racer that fires, so the
      // envelope replacement must notify onTimeout (timeout won the race).
      const pending = executeToolWithTimeout({
        toolName: 'call_tool',
        args: {},
        timeoutMs: 100,
        preferEnvelopeOnRaceLoss: (envelope) =>
          envelope.includes('CALL_CANCELLED') ? envelope : null,
        onTimeout,
        execute: async () => {
          await new Promise((r) => setTimeout(r, 150))
          return cancelledEnvelope
        },
      })
      await vi.advanceTimersByTimeAsync(200)
      const raw = await pending
      expect(JSON.parse(raw).error.code).toBe('CALL_CANCELLED')
      expect(onTimeout).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('executeToolWithTimeout does NOT fire onTimeout when the timeout rejection survives (#139 review: no double notification)', async () => {
    vi.useFakeTimers()
    try {
      // onTimeout provided but the tool never produces an envelope: the
      // rejection propagates to the caller's catch (buildAgentTools →
      // onToolTimeout), so the callback must stay unfired here.
      const onTimeout = vi.fn()
      const controller = new AbortController()
      const pending = executeToolWithTimeout({
        toolName: 'call_tool',
        args: {},
        timeoutMs: 100,
        runAbortSignal: controller.signal,
        preferEnvelopeOnRaceLoss: () => null,
        onTimeout,
        execute: () => new Promise<string>(() => {}),
      })
      const assertion = expect(pending).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(3000)
      await assertion
      expect(onTimeout).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('executeToolWithTimeout skips the grace period entirely when preferEnvelopeOnRaceLoss is not supplied', async () => {
    // Non-WebMCP tools get no preferEnvelopeOnRaceLoss: a lost race must
    // reject immediately instead of waiting RACE_LOSS_GRACE_MS for an
    // envelope the tool can never emit (#139 review: unrelated calls wait
    // two seconds / Stop waits for unrelated tools).
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const pending = executeToolWithTimeout({
        toolName: 'search',
        args: {},
        timeoutMs: null,
        runAbortSignal: controller.signal,
        execute: () => new Promise<string>(() => {}),
      })
      controller.abort()
      const assertion = expect(pending).rejects.toThrow('was aborted')
      await vi.advanceTimersByTimeAsync(0)
      await assertion
      // The grace period would only have elapsed at +2000ms; reaching the
      // rejection at t=0 proves no grace wait happened.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('executeToolWithTimeout does NOT fire onTimeout when a USER STOP won the race before the timeout (#139 review: Stop triggers timeout notification)', async () => {
    // Interleaving from the review: the run aborts (Stop) shortly BEFORE the
    // timeout fires, the tool settles with the cancellation envelope during
    // the grace period, and the timeout rejection is swapped away. The
    // caller's abort path owns the notification — the timer that expired in
    // the meantime must NOT trigger a second (timeout) notification.
    vi.useFakeTimers()
    try {
      const cancelledEnvelope = JSON.stringify({
        ok: false,
        version: 2,
        tool: 'call_tool',
        error: { code: 'CALL_CANCELLED', message: 'cancelled', retryable: false },
      })
      const onTimeout = vi.fn()
      const controller = new AbortController()
      const pending = executeToolWithTimeout({
        toolName: 'call_tool',
        args: {},
        timeoutMs: 100,
        runAbortSignal: controller.signal,
        preferEnvelopeOnRaceLoss: (envelope) =>
          envelope.includes('CALL_CANCELLED') ? envelope : null,
        onTimeout,
        execute: async () => {
          // Stop wins the race at t≈50, the timeout fires at t=100 while the
          // tool promise is still pending, and the envelope lands at t≈150.
          await new Promise((r) => setTimeout(r, 50))
          controller.abort(new Error('user stop'))
          await new Promise((r) => setTimeout(r, 100))
          return cancelledEnvelope
        },
      })
      await vi.advanceTimersByTimeAsync(300)
      const raw = await pending
      expect(JSON.parse(raw).error.code).toBe('CALL_CANCELLED')
      expect(onTimeout).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('truncateLargeToolResult reduces oversized search payload to summary-only result', async () => {
    const raw = JSON.stringify({
      results: [{ path: 'a.ts', line: 1, match: 'x'.repeat(3000), preview: 'x'.repeat(3000) }],
      totalMatches: 1,
      scannedFiles: 1,
    })

    const truncated = await truncateLargeToolResult({
      rawResult: raw,
      toolName: 'search',
      existingTokens: 2000,
      maxContextTokens: 3000,
      reserveTokens: 200,
      estimateTextTokens: (text) => text.length,
    })

    const parsed = JSON.parse(truncated)
    expect(parsed.truncated).toBe(true)
    expect(parsed.results).toEqual([])
  })
})
