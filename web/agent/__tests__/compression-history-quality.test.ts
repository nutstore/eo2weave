import { describe, expect, it } from 'vitest'
import type { Message } from '../message-types'
import { internalToPiMessages, piToInternalMessage } from '../loop/message-mappers'
import { estimateCompressionTokens, projectCompressionHistory, selectCompressionRange, serializeCompressionHistory } from '../loop/compression-history'
const message = (id: string, role: Message['role'], content: string): Message => ({ id, role, content, timestamp: Number(id.replace(/\D/g, '')) || 1 })
const model = { api: 'openai-completions', provider: 'openai', id: 'test', input: ['text'] } as never

it('accounts for uploaded image assets before provider materialization', () => {
  const text = message('m1', 'user', 'Look at this screenshot')
  const uploaded = { ...text, assets: [{ name: 'screen.png', mimeType: 'image/png', size: 10, ocrBase64: 'PIXELS' }] as never }
  expect(estimateCompressionTokens([uploaded]) - estimateCompressionTokens([text])).toBeGreaterThanOrEqual(4096)
})

describe('compression history quality', () => {
  it('projects an appended checkpoint using its covered ID while retaining anchors and tool pairs', () => {
    const task = message('m1', 'user', 'Keep the final constraint verbatim')
    const old = message('m2', 'assistant', 'old work')
    const call = { ...message('m3', 'assistant', ''), toolCalls: [{ id: 'call-3', type: 'function' as const, function: { name: 'read', arguments: '{"path":"exact-id"}' } }] }
    const result = { ...message('m4', 'tool', 'recent result'), toolCallId: 'call-3', name: 'read' }
    const checkpoint = { ...message('m5', 'user', 'checkpoint'), kind: 'context_summary' as const, compressionBoundary: { throughMessageId: old.id, cutoffTimestamp: 3, preservedMessageIds: [task.id] } }
    const canonical = [task, old, call, result, checkpoint]
    const projected = projectCompressionHistory(canonical)
    expect(projected.map(item => item.id)).toEqual(['m5', 'm1', 'm3', 'm4'])
    expect(projected[1]).toBe(task)
    const roundTrip = internalToPiMessages(canonical, model, 'Memory:').map(piToInternalMessage).filter(Boolean)
    expect(roundTrip.map(item => item!.id)).toEqual(['m5', 'm1', 'm3', 'm4'])
    expect(internalToPiMessages(roundTrip as Message[], model, 'Memory:')).toHaveLength(4)
    expect(projectCompressionHistory(JSON.parse(JSON.stringify(canonical))).map(item => item.id)).toEqual(['m5', 'm1', 'm3', 'm4'])
  })
  it('keeps equal-timestamp retained messages through repeated projection and mapper conversion', () => {
    const task = message('m1', 'user', 'human task')
    const covered = message('m2', 'assistant', 'covered')
    const tail = { ...message('m3', 'assistant', 'retained'), timestamp: 2 }
    const marker = { ...message('m4', 'user', 'checkpoint'), kind: 'context_summary' as const, compressionBoundary: { throughMessageId: covered.id, cutoffTimestamp: 3, preservedMessageIds: [task.id] } }
    const first = projectCompressionHistory([task, covered, tail, marker])
    expect(projectCompressionHistory(JSON.parse(JSON.stringify(first))).map(item => item.id)).toEqual(first.map(item => item.id))
    const mapped = internalToPiMessages(first, model, 'Memory:').map(piToInternalMessage)
    expect(mapped.map(item => item!.id)).toEqual(first.map(item => item.id))
  })
  it.each([
    { subagentCompletion: { eventIds: ['event'] } },
    { delegationNote: { fromAgentId: 'agent', task: 'delegated task' } },
    { readImageHandoff: { path: 'image.png', mimeType: 'image/png', ocrStatus: 'done' as const } },
  ])('anchors the human task when a later synthetic user notification occurs: %j', (notification) => {
    const task = message('m1', 'user', 'long human task '.repeat(100))
    const source = [task, message('m2', 'assistant', 'old work '.repeat(1500)), { ...message('m3', 'user', 'automated notification'), ...notification }, message('m4', 'assistant', 'more old work '.repeat(1500)), message('m5', 'assistant', 'recent tail')]
    const range = selectCompressionRange(source, 3000)!
    expect(range.preservedMessageIds).toEqual([task.id])
    expect(range.retained).toContain(task)
  })
  it('advances boundary metadata even when recompression returns the same summary text', () => {
    const oldMarker = { ...message('m1', 'user', 'same summary'), kind: 'context_summary' as const, compressionBoundary: { throughMessageId: 'gone', cutoffTimestamp: 1 } }
    const messages = [oldMarker, message('m2', 'assistant', 'covered next'), message('m3', 'assistant', 'tail')]
    const projected = projectCompressionHistory(messages, { summary: 'same summary', throughMessageId: 'm2', cutoffTimestamp: 3 })
    expect(projected[0].compressionBoundary?.throughMessageId).toBe('m2')
    expect(projectCompressionHistory(projected).map(item => item.content)).toEqual(['same summary', 'tail'])
  })
  it('uses timestamp metadata when a covered source ID was deleted before reload', () => {
    const tail = message('m4', 'assistant', 'Retained tail')
    const checkpoint = { ...message('m5', 'user', 'checkpoint'), kind: 'context_summary' as const, compressionBoundary: { throughMessageId: 'deleted-source', cutoffTimestamp: 3 } }
    expect(projectCompressionHistory([message('m1', 'user', 'old'), tail, checkpoint]).map(item => item.id)).toEqual(['m5', 'm4'])
  })
  it('selects an older prefix inside one active user turn and preserves the full latest task', () => {
    const task = message('m1', 'user', 'x'.repeat(1800) + ' FINAL_CONSTRAINT')
    const oldCall = { ...message('m2', 'assistant', ''), toolCalls: [{ id: 'specific-id', type: 'function' as const, function: { name: 'read', arguments: JSON.stringify({ path: 'precise/path', id: 'arg-id' }) } }] }
    const oldResult = { ...message('m3', 'tool', 'old result '.repeat(800)), name: 'read', toolCallId: 'specific-id' }
    const recentCall = { ...message('m4', 'assistant', ''), toolCalls: [{ id: 'recent-id', type: 'function' as const, function: { name: 'read', arguments: '{}' } }] }
    const recentResult = { ...message('m5', 'tool', 'recent result '.repeat(60)), name: 'read', toolCallId: 'recent-id' }
    const range = selectCompressionRange([task, oldCall, oldResult, recentCall, recentResult], 3000)!
    expect(range).not.toBeNull()
    expect(range.retained).toEqual([task, recentCall, recentResult])
    expect(range.preservedMessageIds).toEqual([task.id])
    const serialized = serializeCompressionHistory(range.messages)
    expect(serialized).toContain('FINAL_CONSTRAINT')
    expect(serialized).toContain('specific-id')
    expect(serialized).toContain('arg-id')
    expect(serialized).toContain('precise/path')
    expect(serialized).toContain(oldResult.content)
  })
  it('does not force compaction when all history fits the retained tail', () => {
    expect(selectCompressionRange([message('m1', 'user', 'small task'), message('m2', 'assistant', 'small answer')], 400000)).toBeNull()
  })
  it('includes the previous checkpoint in the next selected source', () => {
    const previous = { ...message('m0', 'user', 'PREVIOUS_SUMMARY'), kind: 'context_summary' as const }
    const range = selectCompressionRange([previous, message('m1', 'user', 'task'), message('m2', 'assistant', 'older '.repeat(3000)), message('m3', 'assistant', 'tail')], 3000)!
    expect(range.messages[0]).toBe(previous)
  })
})
