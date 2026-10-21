/**
 * search_skills — search the Skill Store for installable skills.
 *
 * Adaptive routing (mirrors search_tools):
 *   Path A   — pure BM25 (no intent, or provider unavailable)
 *   Path A2  — BM25 short-circuit (top-1 high confidence)
 *   Path B   — BM25 + LLM rerank (good recall, non-CJK)
 *   Path C   — full LLM semantic (CJK or poor BM25 recall)
 *   Fallback — BM25 best-effort + no_match status
 *
 * Results render as interactive cards in the chat with install buttons.
 */

import type { ToolDefinition } from './tool-types'
import type { ToolPromptDoc } from './tool-types'
import type { ToolContext } from './tool-types'
import { toolOkJson, toolErrorJson } from './tool-envelope'
import { bm25Search, hasCJK } from './bm25'
import {
  fetchSkillStoreManifest,
  scanInstalledDirNames,
  type SkillStoreEntry,
} from '@/skills/skill-store'

// ---------------------------------------------------------------------------
// Constants (mirrors search_tools)
// ---------------------------------------------------------------------------

const MIN_RECALL = 5 // Min BM25 candidates to attempt rerank path
const RERANK_TOP_N = 20 // Candidates fed into LLM reranker
const FALLBACK_TOP_K = 5 // Best-effort candidates when nothing matches
const MAX_SEARCH_RESULTS = 10
const TOP1_CONFIDENCE_SCORE = 8.0
const TOP1_TOP2_GAP = 4.0

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillSearchResult {
  name: string
  description: string
  category: string
  tags: string[]
  version: string
  dirName: string
  zipUrl: string
  installed: boolean
  score: number
  relevanceReason?: string
}

// ---------------------------------------------------------------------------
// Catalog + enrichment
// ---------------------------------------------------------------------------

function formatSkillsForPrompt(skills: SkillStoreEntry[]): string {
  return skills
    .map(
      (s) =>
        `- ${s.name}: ${s.description}` +
        (s.tags.length > 0 ? ` [tags: ${s.tags.join(', ')}]` : ''),
    )
    .join('\n')
}

function enrichWithCatalog(
  picks: Array<{ skill_name: string; description: string; relevance_reason: string }>,
  catalog: SkillStoreEntry[],
  installed: Set<string>,
  limit: number,
): { results: SkillSearchResult[]; notFound: string[] } {
  const catalogMap = new Map(catalog.map((s) => [s.name, s]))
  const notFound: string[] = []
  const results: SkillSearchResult[] = picks
    .slice(0, Math.min(limit, MAX_SEARCH_RESULTS))
    .map((pick): SkillSearchResult | null => {
      const entry = catalogMap.get(pick.skill_name)
      if (!entry) {
        notFound.push(pick.skill_name)
        return null
      }
      return {
        name: entry.name,
        description: entry.description,
        category: entry.category,
        tags: entry.tags,
        version: entry.version,
        dirName: entry.dirName,
        zipUrl: entry.zipUrl,
        installed: installed.has(entry.dirName),
        score: 0,
        relevanceReason: pick.relevance_reason,
      }
    })
    .filter((r): r is SkillSearchResult => r !== null)
  return { results, notFound }
}

function bm25ResultsToSearchResults(
  scored: Array<{ item: SkillStoreEntry; score: number }>,
  installed: Set<string>,
): SkillSearchResult[] {
  return scored.map(({ item, score }) => ({
    name: item.name,
    description: item.description,
    category: item.category,
    tags: item.tags,
    version: item.version,
    dirName: item.dirName,
    zipUrl: item.zipUrl,
    installed: installed.has(item.dirName),
    score: Math.round(score * 100) / 100,
  }))
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const searchSkillsDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'search_skills',
    description: [
      'Search the Skill Store for skills that can be installed.',
      '',
      "Use this when the user needs a capability that might be available as a pre-built skill but isn't currently installed.",
      'Domains include: audio/video transcription, image processing, code review, design audit, writing, reading analysis, data/spreadsheet analysis, OCR, novel/OKF, OKR management, brainstorming, and more.',
      'Results render as interactive cards in the chat — the user can install with one click.',
      '',
      'The search covers the Skill Store catalog (skills NOT yet installed).',
      'For skills that ARE already installed, check the current skills catalog in runtime context instead.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Keywords to search for. Matches against skill name, description, category, and tags. Prefer English keywords.',
        },
        intent: {
          type: 'string',
          description:
            'Natural language description of the task you want to accomplish. Enables semantic matching (synonyms, paraphrases). Use this when keywords are insufficient.',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return. Default 5, max 10.',
        },
      },
    },
  },
}

// ---------------------------------------------------------------------------
// Executor with adaptive routing
// ---------------------------------------------------------------------------

export async function searchSkillsExecutor(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<string> {
  const query = typeof args.query === 'string' ? args.query : ''
  const intent = typeof args.intent === 'string' ? args.intent : ''
  const limit = Math.min(Math.max(1, Number(args.limit) || 5), MAX_SEARCH_RESULTS)
  const startTime = performance.now()

  let catalog: SkillStoreEntry[]
  let installed: Set<string>
  try {
    const manifest = await fetchSkillStoreManifest()
    installed = await scanInstalledDirNames()
    catalog = manifest.skills
  } catch (err) {
    return toolErrorJson(
      'search_skills',
      'fetch_failed',
      err instanceof Error ? err.message : 'Failed to fetch Skill Store manifest',
    )
  }

  if (catalog.length === 0) {
    return toolOkJson('search_skills', {
      results: [],
      total: 0,
      query,
      intent,
      searchMode: 'empty',
      searchDurationMs: Math.round(performance.now() - startTime),
      message: 'The Skill Store is currently empty.',
    })
  }

  // Always run BM25 first
  const searchIntent = intent || query
  const bm25Candidates = bm25Search(
    catalog,
    searchIntent,
    RERANK_TOP_N,
    (s) => `${s.name} ${s.description} ${s.category} ${s.tags.join(' ')}`,
    (s) => s.name,
  )
  const bm25Top1Score = bm25Candidates[0]?.score ?? 0
  const bm25Top2Score = bm25Candidates[1]?.score ?? 0
  const top1Top2Gap = bm25Top1Score - bm25Top2Score

  // Path A: no intent → pure BM25
  if (!intent.trim()) {
    const results = bm25ResultsToSearchResults(bm25Candidates.slice(0, limit), installed)
    return toolOkJson('search_skills', {
      results,
      total: bm25Candidates.length,
      query,
      intent,
      searchMode: 'keyword',
      searchDurationMs: Math.round(performance.now() - startTime),
      bm25Top1: bm25Candidates[0]?.item.name ?? null,
    })
  }

  // Path A2: BM25 short-circuit (high confidence top-1)
  if (
    bm25Candidates.length >= 2 &&
    bm25Top1Score >= TOP1_CONFIDENCE_SCORE &&
    top1Top2Gap >= TOP1_TOP2_GAP
  ) {
    const results = bm25ResultsToSearchResults(bm25Candidates.slice(0, limit), installed)
    return toolOkJson('search_skills', {
      results,
      total: bm25Candidates.length,
      query,
      intent,
      searchMode: 'keyword',
      searchDurationMs: Math.round(performance.now() - startTime),
      bm25Top1: bm25Candidates[0]?.item.name ?? null,
      shortCircuited: 'top1_confidence',
      bm25Top1Score,
      top1Top2Gap,
    })
  }

  // Path B / C: need LLM — check provider
  const provider = context.provider
  if (!provider) {
    // Fallback: BM25 only
    const results = bm25ResultsToSearchResults(
      bm25Candidates.slice(0, FALLBACK_TOP_K),
      installed,
    )
    return toolOkJson('search_skills', {
      results,
      total: bm25Candidates.length,
      query,
      intent,
      searchMode: 'fallback',
      searchDurationMs: Math.round(performance.now() - startTime),
      bm25Top1: bm25Candidates[0]?.item.name ?? null,
      status: 'no_provider',
      message: 'No LLM provider available for semantic search. Showing BM25 results only.',
    })
  }

  // Path B: BM25 + LLM rerank (non-CJK, good recall)
  if (!hasCJK(searchIntent) && bm25Candidates.length >= MIN_RECALL) {
    const { runSkillReranker } = await import('../subagents/skill-searcher')
    const rerankResult = await runSkillReranker(
      {
        intent,
        candidates: bm25Candidates.slice(0, RERANK_TOP_N).map((c) => ({
          name: c.item.name,
          description: c.item.description,
          category: c.item.category,
          bm25Score: c.score,
        })),
        topK: limit,
      },
      { provider, signal: context.abortSignal },
    )

    if (rerankResult && rerankResult.skills.length > 0) {
      const { results, notFound } = enrichWithCatalog(
        rerankResult.skills,
        catalog,
        installed,
        limit,
      )
      return toolOkJson('search_skills', {
        results,
        total: results.length,
        query,
        intent,
        searchMode: 'bm25_rerank',
        searchDurationMs: Math.round(performance.now() - startTime),
        bm25Top1: bm25Candidates[0]?.item.name ?? null,
        notFound: notFound.length > 0 ? notFound : undefined,
      })
    }
    // rerank returned empty → fall through to Path C
  }

  // Path C: full semantic search
  const { runSkillSearcher } = await import('../subagents/skill-searcher')
  const semanticResult = await runSkillSearcher(
    {
      query: intent,
      allSkillDescriptionsText: formatSkillsForPrompt(catalog),
    },
    { provider, signal: context.abortSignal },
  )

  if (semanticResult && semanticResult.skills.length > 0) {
    const { results, notFound } = enrichWithCatalog(
      semanticResult.skills,
      catalog,
      installed,
      limit,
    )
    return toolOkJson('search_skills', {
      results,
      total: results.length,
      query,
      intent,
      searchMode: 'semantic',
      searchDurationMs: Math.round(performance.now() - startTime),
      bm25Top1: bm25Candidates[0]?.item.name ?? null,
      notFound: notFound.length > 0 ? notFound : undefined,
    })
  }

  // Fallback: BM25 best-effort
  const results = bm25ResultsToSearchResults(
    bm25Candidates.slice(0, FALLBACK_TOP_K),
    installed,
  )
  return toolOkJson('search_skills', {
    results,
    total: bm25Candidates.length,
    query,
    intent,
    searchMode: 'fallback',
    searchDurationMs: Math.round(performance.now() - startTime),
    bm25Top1: bm25Candidates[0]?.item.name ?? null,
    status: 'no_match',
    message: 'No skills matched via semantic search. Showing best BM25 results.',
    suggestion: results.length === 0 ? 'Try different keywords.' : undefined,
  })
}

// ---------------------------------------------------------------------------
// Prompt doc
// ---------------------------------------------------------------------------

export const searchSkillsPromptDoc: ToolPromptDoc = {
  category: 'skills',
  section: '### Skill Tools',
  lines: [
    '- `search_skills(query?, intent?, limit?)` — Search the Skill Store for installable skills. Results show interactive install buttons in the chat. Use when the user needs a capability that might exist as a skill but isn\'t installed yet.',
  ],
}
