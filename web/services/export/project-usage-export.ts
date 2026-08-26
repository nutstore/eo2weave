import type { MessageUsage } from '@/agent/message-types'
import { calculateUsageCost, resolveUsagePricing } from '@/agent/usage-cost'
import type { Project } from '@/sqlite/repositories/project.repository'
import { getSQLiteDB, parseJSON } from '@/sqlite/sqlite-database'
import { exportToCSV, type ExportResult } from './data-exporter'

export interface ProjectUsageConversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface ProjectUsageRecord {
  conversationId: string
  scope: 'conversation' | 'subagent'
  subagentId?: string
  subagentName?: string
  usage: MessageUsage
  timestamp: number
}

export interface ProjectUsageFallbackModel {
  provider: string
  model: string
}

export type ProjectUsageExportRow = Record<string, string | number | boolean>

interface ConversationQueryRow {
  id: string
  workspace_name: string
  title: string | null
  created_at: number | null
  updated_at: number | null
  workspace_created_at: number
  workspace_updated_at: number
}

interface MessageQueryRow {
  conversation_id: string
  meta_json: string | null
  timestamp: number
}

interface SubagentQueryRow {
  agent_id: string
  workspace_id: string
  name: string | null
  messages_json: string
  usage_json: string | null
  created_at: number
  updated_at: number
}

interface StoredSubagentUsage {
  total_tokens: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  provider?: string
  model?: string
  input_cost_usd?: number
  output_cost_usd?: number
  cache_read_cost_usd?: number
  estimated_cost_usd?: number
  cost_complete?: boolean
}

interface StoredSubagentMessage {
  role?: string
  timestamp?: number
  usage?: MessageUsage
}

interface MutableAggregate {
  conversation: ProjectUsageConversation
  scope: ProjectUsageRecord['scope']
  subagentId: string
  subagentName: string
  provider: string
  model: string
  modelSource: 'recorded' | 'current_selection_fallback' | 'unknown'
  pricingSource: string
  inputPrice: number | ''
  outputPrice: number | ''
  cacheReadPrice: number | ''
  requestCount: number
  unpricedRequestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  knownInputCost: number
  knownOutputCost: number
  knownCacheReadCost: number
  firstTimestamp: number
  lastTimestamp: number
}

function iso(timestamp: number): string {
  return timestamp > 0 ? new Date(timestamp).toISOString() : ''
}

function money(value: number): number {
  return Number(value.toFixed(10))
}

function safeFilename(value: string): string {
  const normalized = value.trim().replace(/[\\/:*?"<>|\s]+/g, '-')
  return normalized || 'project'
}

function aggregateKey(
  record: ProjectUsageRecord,
  usage: MessageUsage,
  modelSource: MutableAggregate['modelSource']
): string {
  const pricing = usage.pricing
  return [
    record.conversationId,
    record.scope,
    record.subagentId ?? '',
    usage.provider ?? 'unknown',
    usage.model ?? 'unknown',
    modelSource,
    pricing?.source ?? 'unknown',
    pricing?.inputPerMillionUsd ?? '',
    pricing?.outputPerMillionUsd ?? '',
    pricing?.cacheReadPerMillionUsd ?? '',
  ].join('\u0000')
}

/** Pure aggregation used by both the downloader and unit tests. */
export function buildProjectUsageExportRows(
  project: Pick<Project, 'id' | 'name'>,
  conversations: ProjectUsageConversation[],
  records: ProjectUsageRecord[],
  fallbackModel?: ProjectUsageFallbackModel
): ProjectUsageExportRow[] {
  const conversationsById = new Map(
    conversations.map((conversation) => [conversation.id, conversation])
  )
  const aggregates = new Map<string, MutableAggregate>()

  for (const record of records) {
    const conversation = conversationsById.get(record.conversationId)
    if (!conversation) continue

    const original = record.usage
    const provider = original.provider ?? fallbackModel?.provider
    const model = original.model ?? fallbackModel?.model
    const modelSource: MutableAggregate['modelSource'] = original.model
      ? 'recorded'
      : fallbackModel?.model
        ? 'current_selection_fallback'
        : 'unknown'
    const pricing = original.pricing ?? resolveUsagePricing(provider, model)
    const usage: MessageUsage = {
      ...original,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(pricing && !original.pricing ? { pricing } : {}),
    }
    const cost = usage.cost ?? (pricing ? calculateUsageCost(usage, pricing) : null)
    const key = aggregateKey(record, usage, modelSource)
    let aggregate = aggregates.get(key)
    if (!aggregate) {
      aggregate = {
        conversation,
        scope: record.scope,
        subagentId: record.subagentId ?? '',
        subagentName: record.subagentName ?? '',
        provider: usage.provider ?? 'unknown',
        model: usage.model ?? 'unknown',
        modelSource,
        pricingSource: pricing?.source ?? 'unknown',
        inputPrice: pricing?.inputPerMillionUsd ?? '',
        outputPrice: pricing?.outputPerMillionUsd ?? '',
        cacheReadPrice: pricing?.cacheReadPerMillionUsd ?? '',
        requestCount: 0,
        unpricedRequestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        knownInputCost: 0,
        knownOutputCost: 0,
        knownCacheReadCost: 0,
        firstTimestamp: record.timestamp,
        lastTimestamp: record.timestamp,
      }
      aggregates.set(key, aggregate)
    }

    aggregate.requestCount += 1
    aggregate.inputTokens += usage.promptTokens || 0
    aggregate.outputTokens += usage.completionTokens || 0
    aggregate.cacheReadTokens += usage.cacheReadTokens || 0
    aggregate.firstTimestamp = Math.min(aggregate.firstTimestamp, record.timestamp)
    aggregate.lastTimestamp = Math.max(aggregate.lastTimestamp, record.timestamp)
    if (cost) {
      aggregate.knownInputCost += cost.inputUsd
      aggregate.knownOutputCost += cost.outputUsd
      aggregate.knownCacheReadCost += cost.cacheReadUsd
    } else {
      aggregate.unpricedRequestCount += 1
    }
  }

  const detailRows = [...aggregates.values()]
    .sort(
      (a, b) =>
        a.conversation.createdAt - b.conversation.createdAt || a.model.localeCompare(b.model)
    )
    .map((aggregate): ProjectUsageExportRow => {
      const knownTotalCost =
        aggregate.knownInputCost + aggregate.knownOutputCost + aggregate.knownCacheReadCost
      const costComplete = aggregate.unpricedRequestCount === 0
      return {
        record_type: 'conversation_model',
        project_id: project.id,
        project_name: project.name,
        conversation_id: aggregate.conversation.id,
        conversation_title: aggregate.conversation.title,
        scope: aggregate.scope,
        subagent_id: aggregate.subagentId,
        subagent_name: aggregate.subagentName,
        provider: aggregate.provider,
        model: aggregate.model,
        model_source: aggregate.modelSource,
        request_count: aggregate.requestCount,
        input_tokens: aggregate.inputTokens,
        output_tokens: aggregate.outputTokens,
        cache_read_tokens: aggregate.cacheReadTokens,
        total_tokens: aggregate.inputTokens + aggregate.outputTokens + aggregate.cacheReadTokens,
        input_cost_usd: costComplete ? money(aggregate.knownInputCost) : '',
        output_cost_usd: costComplete ? money(aggregate.knownOutputCost) : '',
        cache_read_cost_usd: costComplete ? money(aggregate.knownCacheReadCost) : '',
        estimated_total_cost_usd: costComplete ? money(knownTotalCost) : '',
        known_estimated_cost_usd: money(knownTotalCost),
        cost_complete: costComplete,
        unpriced_request_count: aggregate.unpricedRequestCount,
        input_price_per_1m_usd: aggregate.inputPrice,
        output_price_per_1m_usd: aggregate.outputPrice,
        cache_read_price_per_1m_usd: aggregate.cacheReadPrice,
        pricing_source: aggregate.pricingSource,
        first_request_at: iso(aggregate.firstTimestamp),
        last_request_at: iso(aggregate.lastTimestamp),
        conversation_created_at: iso(aggregate.conversation.createdAt),
        conversation_updated_at: iso(aggregate.conversation.updatedAt),
      }
    })

  const conversationsWithUsage = new Set(records.map((record) => record.conversationId))
  for (const conversation of conversations) {
    if (conversationsWithUsage.has(conversation.id)) continue
    detailRows.push({
      record_type: 'conversation_model',
      project_id: project.id,
      project_name: project.name,
      conversation_id: conversation.id,
      conversation_title: conversation.title,
      scope: 'conversation',
      subagent_id: '',
      subagent_name: '',
      provider: 'unknown',
      model: 'unknown',
      model_source: 'unknown',
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
      input_cost_usd: 0,
      output_cost_usd: 0,
      cache_read_cost_usd: 0,
      estimated_total_cost_usd: 0,
      known_estimated_cost_usd: 0,
      cost_complete: true,
      unpriced_request_count: 0,
      input_price_per_1m_usd: '',
      output_price_per_1m_usd: '',
      cache_read_price_per_1m_usd: '',
      pricing_source: 'not_applicable',
      first_request_at: '',
      last_request_at: '',
      conversation_created_at: iso(conversation.createdAt),
      conversation_updated_at: iso(conversation.updatedAt),
    })
  }

  const numeric = (key: string) =>
    detailRows.reduce(
      (sum, row) => sum + (typeof row[key] === 'number' ? (row[key] as number) : 0),
      0
    )
  const totalUnpriced = numeric('unpriced_request_count')
  const knownCost = numeric('known_estimated_cost_usd')
  const summary: ProjectUsageExportRow = {
    record_type: 'project_total',
    project_id: project.id,
    project_name: project.name,
    conversation_id: '',
    conversation_title: '',
    scope: 'all',
    subagent_id: '',
    subagent_name: '',
    provider: 'all',
    model: 'all',
    model_source: 'mixed',
    request_count: numeric('request_count'),
    input_tokens: numeric('input_tokens'),
    output_tokens: numeric('output_tokens'),
    cache_read_tokens: numeric('cache_read_tokens'),
    total_tokens: numeric('total_tokens'),
    input_cost_usd: totalUnpriced === 0 ? money(numeric('input_cost_usd')) : '',
    output_cost_usd: totalUnpriced === 0 ? money(numeric('output_cost_usd')) : '',
    cache_read_cost_usd: totalUnpriced === 0 ? money(numeric('cache_read_cost_usd')) : '',
    estimated_total_cost_usd: totalUnpriced === 0 ? money(knownCost) : '',
    known_estimated_cost_usd: money(knownCost),
    cost_complete: totalUnpriced === 0,
    unpriced_request_count: totalUnpriced,
    input_price_per_1m_usd: '',
    output_price_per_1m_usd: '',
    cache_read_price_per_1m_usd: '',
    pricing_source: 'mixed',
    first_request_at: '',
    last_request_at: '',
    conversation_created_at: '',
    conversation_updated_at: '',
  }

  return [summary, ...detailRows]
}

async function loadProjectUsageData(projectId: string): Promise<{
  conversations: ProjectUsageConversation[]
  records: ProjectUsageRecord[]
}> {
  const db = getSQLiteDB()
  const conversationRows = await db.queryAll<ConversationQueryRow>(
    `SELECT w.id, w.name AS workspace_name, c.title, c.created_at, c.updated_at,
            w.created_at AS workspace_created_at, w.last_accessed_at AS workspace_updated_at
       FROM workspaces w
       LEFT JOIN conversations c ON c.id = w.id
      WHERE w.project_id = ?
      ORDER BY w.created_at ASC`,
    [projectId]
  )
  const conversations = conversationRows.map((row) => ({
    id: row.id,
    title: row.title || row.workspace_name,
    createdAt: row.created_at ?? row.workspace_created_at,
    updatedAt: row.updated_at ?? row.workspace_updated_at,
  }))

  const messageRows = await db.queryAll<MessageQueryRow>(
    `SELECT m.conversation_id, m.meta_json, m.timestamp
       FROM messages m
       INNER JOIN workspaces w ON w.id = m.conversation_id
      WHERE w.project_id = ? AND m.role = 'assistant'
      ORDER BY m.timestamp ASC`,
    [projectId]
  )
  const records: ProjectUsageRecord[] = []
  for (const row of messageRows) {
    const meta = parseJSON<{ usage?: MessageUsage }>(row.meta_json, {})
    if (!meta.usage) continue
    records.push({
      conversationId: row.conversation_id,
      scope: 'conversation',
      usage: meta.usage,
      timestamp: row.timestamp,
    })
  }

  let subagentRows: SubagentQueryRow[] = []
  try {
    subagentRows = await db.queryAll<SubagentQueryRow>(
      `SELECT s.agent_id, s.workspace_id, s.name, s.messages_json, s.usage_json,
              s.created_at, s.updated_at
         FROM subagent_tasks s
         INNER JOIN workspaces w ON w.id = s.workspace_id
        WHERE w.project_id = ?
        ORDER BY s.created_at ASC`,
      [projectId]
    )
  } catch {
    // Older databases may predate subagent_tasks. Primary conversation usage is still exportable.
  }

  for (const task of subagentRows) {
    const messages = parseJSON<StoredSubagentMessage[]>(task.messages_json, [])
    const assistantUsages = messages.filter(
      (message) => message.role === 'assistant' && message.usage
    )
    if (assistantUsages.length > 0) {
      for (const message of assistantUsages) {
        records.push({
          conversationId: task.workspace_id,
          scope: 'subagent',
          subagentId: task.agent_id,
          subagentName: task.name || undefined,
          usage: message.usage!,
          timestamp: message.timestamp || task.updated_at,
        })
      }
      continue
    }

    const fallback = parseJSON<StoredSubagentUsage | null>(task.usage_json, null)
    if (fallback && fallback.total_tokens > 0) {
      records.push({
        conversationId: task.workspace_id,
        scope: 'subagent',
        subagentId: task.agent_id,
        subagentName: task.name || undefined,
        usage: {
          promptTokens: fallback.input_tokens || 0,
          completionTokens: fallback.output_tokens || 0,
          totalTokens: fallback.total_tokens || 0,
          cacheReadTokens: fallback.cache_read_tokens || 0,
          provider: fallback.provider,
          model: fallback.model,
          ...(fallback.cost_complete
            ? {
                cost: {
                  inputUsd: fallback.input_cost_usd || 0,
                  outputUsd: fallback.output_cost_usd || 0,
                  cacheReadUsd: fallback.cache_read_cost_usd || 0,
                  totalUsd: fallback.estimated_cost_usd || 0,
                },
              }
            : {}),
        },
        timestamp: task.updated_at,
      })
    }
  }

  return { conversations, records }
}

export async function exportProjectUsageCSV(project: Project): Promise<ExportResult> {
  const { conversations, records } = await loadProjectUsageData(project.id)
  const { useSettingsStore } = await import('@/store/settings.store')
  const settings = useSettingsStore.getState()
  const rows = buildProjectUsageExportRows(project, conversations, records, {
    provider: settings.providerType,
    model: settings.modelName,
  })
  return exportToCSV(rows, {
    filename: `${safeFilename(project.name)}-model-token-cost`,
    addTimestamp: true,
  })
}
