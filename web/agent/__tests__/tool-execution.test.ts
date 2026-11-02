import { describe, expect, it } from 'vitest'
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
