import type { CompressionBaselineState } from './context-compression'
import { isHumanUserMessage, type Message } from '../message-types'

/** Reconstruct provider history without changing the canonical transcript. */
export function projectCompressionHistory(messages: Message[], baseline?: CompressionBaselineState | null): Message[] {
  const markerIndex = messages.map(message => message.kind).lastIndexOf('context_summary')
  const marker = markerIndex >= 0 ? messages[markerIndex] : undefined
  const active = baseline ?? (marker ? {
    summary: marker.content ?? '',
    cutoffTimestamp: marker.compressionBoundary?.cutoffTimestamp ?? marker.timestamp,
    throughMessageId: marker.compressionBoundary?.throughMessageId,
    preservedMessageIds: marker.compressionBoundary?.preservedMessageIds,
  } : null)
  if (!active) return messages
  const boundaryIndex = active.throughMessageId ? messages.findIndex(message => message.id === active.throughMessageId) : -1
  // The covered source may be absent from an already projected view. Carry the
  // exact retained IDs so equal timestamps cannot remove them on the next pass.
  const retainedIds = marker?.compressionBoundary?.throughMessageId === active.throughMessageId && marker?.compressionBoundary?.cutoffTimestamp === active.cutoffTimestamp
    ? marker.compressionBoundary.retainedMessageIds ?? [] : []
  const preserved = new Set([...(active.preservedMessageIds ?? []), ...retainedIds])
  const retained = messages.filter((message, index) => message.kind !== 'context_summary' && (
    preserved.has(message.id) || (boundaryIndex >= 0 ? index > boundaryIndex : !active.throughMessageId && markerIndex >= 0 ? index > markerIndex : message.timestamp >= active.cutoffTimestamp)
  ))
  const summary: Message = !baseline && marker && marker.content === active.summary ? marker : {
    id: `compression-${active.throughMessageId ?? active.cutoffTimestamp}`,
    role: 'user',
    content: active.summary,
    kind: 'context_summary',
    timestamp: Math.max(0, active.cutoffTimestamp - 1),
    ...(active.throughMessageId ? { compressionBoundary: {
      throughMessageId: active.throughMessageId,
      cutoffTimestamp: active.cutoffTimestamp,
      preservedMessageIds: active.preservedMessageIds,
    } } : {}),
  }
  const projectedSummary = summary.compressionBoundary ? {
    ...summary,
    compressionBoundary: { ...summary.compressionBoundary, retainedMessageIds: retained.map(message => message.id) },
  } : summary
  return [projectedSummary, ...retained]
}

/** Full provenance and tool payloads; no per-message clipping. */
export function serializeCompressionHistory(messages: Message[]): string {
  return messages.map(message => JSON.stringify({
    id: message.id, role: message.role, kind: message.kind, content: message.content,
    contentParts: message.contentParts?.map(part => part.type === 'image' ? { type: 'image', mimeType: part.mimeType, provenance: 'image supplied in original message' } : part),
    toolCalls: message.toolCalls, toolCallId: message.toolCallId, name: message.name,
    assets: message.assets?.map(asset => ({ name: asset.name, mimeType: asset.mimeType, size: asset.size, ocrText: asset.ocrText })),
    images: message.images?.map(image => ({ mimeType: image.mimeType, provenance: 'assistant generated image' })),
    pageContext: message.pageContext,
  })).join('\n')
}

export function estimateCompressionTokens(messages: Message[]): number {
  const encoder = new TextEncoder()
  return Math.ceil(encoder.encode(serializeCompressionHistory(messages)).length / 3) + messages.reduce((count, message) => {
    const inputImages = message.contentParts?.filter(part => part.type === 'image').length
      || message.assets?.filter(asset => asset.mimeType.startsWith('image/') && asset.ocrBase64).length || 0
    // Thinking blocks consume replay capacity but are not factual summary evidence.
    const reasoningTokens = message.role === 'assistant' && message.reasoning
      && !['context_summary', 'run_changes', 'empty', 'error', 'aborted'].includes(message.kind ?? '')
      ? Math.ceil(encoder.encode(message.reasoning).length / 3) : 0
    return count + 16 + reasoningTokens + 4096 * (inputImages + (message.images?.length ?? 0))
  }, 0)
}

export interface CompressionRange {
  messages: Message[]
  retained: Message[]
  throughMessageId: string
  cutoffTimestamp: number
  preservedMessageIds: string[]
}

/** Keep the newest whole tool exchanges and independently anchor the active user request. */
export function selectCompressionRange(messages: Message[], effectiveCapacityTokens: number): CompressionRange | null {
  const previous = messages.filter(message => message.kind === 'context_summary').at(-1)
  const source = messages.filter(message => message.kind !== 'context_summary' && message.kind !== 'run_changes' && message.kind !== 'context_update')
  const groups: Message[][] = []
  for (const message of source) {
    const last = groups.at(-1)
    if (message.role === 'tool' && last?.some(item => item.toolCalls?.some(call => call.id === message.toolCallId))) last.push(message)
    else groups.push([message])
  }
  const tailBudget = Math.max(1, Math.floor(effectiveCapacityTokens * 0.16))
  let tailStart = groups.length
  let tailTokens = 0
  while (tailStart > 0) {
    const tokens = estimateCompressionTokens(groups[tailStart - 1])
    if (tailStart < groups.length && tailTokens + tokens > tailBudget) break
    tailTokens += tokens
    tailStart--
  }
  if (tailStart === 0) return null
  const prefix = groups.slice(0, tailStart).flat()
  const tail = groups.slice(tailStart).flat()
  const latestUser = source.findLast(message => isHumanUserMessage(message) && !/^\s*\/compact(?:\s|$)/.test(message.content ?? ''))
  const preserved = latestUser && prefix.includes(latestUser) ? [latestUser] : []
  // A user request alone cannot be profitably replaced while also preserving it.
  if (!prefix.some(message => !preserved.includes(message))) return null
  const boundary = prefix.at(-1)!
  return {
    messages: previous ? [previous, ...prefix] : prefix,
    retained: [...preserved, ...tail],
    throughMessageId: boundary.id,
    cutoffTimestamp: Math.max(...prefix.map(message => message.timestamp)) + 1,
    preservedMessageIds: preserved.map(message => message.id),
  }
}

export function resolveSummaryTokenBudget(modelCapacity: number, maxOutputTokens?: number, sourceTokens = modelCapacity): number {
  return Math.max(1, Math.floor(Math.min(maxOutputTokens ?? 16384, 16384, modelCapacity * 0.08, Math.max(128, sourceTokens * 0.2))))
}
