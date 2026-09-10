/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tool Recommendation System - Intelligently suggests relevant tools based on user intent.
 *
 * Goals:
 * - Increase tool discovery rate by 80%
 * - Proactively suggest tools based on user message analysis
 * - Provide usage examples for each recommended tool
 *
 * Architecture:
 * 1. IntentAnalyzer - Parses user messages to detect user goals
 * 2. ToolIntentMapping - Maps intents to relevant tools
 * 3. RecommendationEngine - Scores and ranks tools by relevance
 * 4. ExampleGenerator - Provides contextual usage examples
 */

//=============================================================================
// Types
//=============================================================================

/** User intent categories */
export type UserIntent =
  | 'file-discovery'
  | 'file-read'
  | 'file-write'
  | 'file-edit'
  | 'code-search'
  | 'data-analysis'
  | 'data-visualization'
  | 'code-generation'
  | 'debugging'
  | 'testing'
  | 'documentation'
  | 'batch-operations'
  | 'refactoring'
  | 'unknown'

/** Tool recommendation with context */
export interface ToolRecommendation {
  /** Tool name */
  toolName: string
  /** Display name */
  displayName: string
  /** Why this tool is recommended */
  reason: string
  /** Usage example tailored to the current context */
  example: string
  /** Relevance score (0-1) */
  score: number
  /** Tool category */
  category: ToolCategory
}

/** Tool categories for organization */
export type ToolCategory =
  | 'discovery'
  | 'reading'
  | 'writing'
  | 'search'
  | 'analysis'
  | 'batch'
  | 'refactoring'

/** Intent analysis result */
export interface IntentAnalysis {
  /** Primary intent */
  primaryIntent: UserIntent
  /** Confidence score (0-1) */
  confidence: number
  /** Detected keywords */
  keywords: string[]
  /** File type hints (e.g., '.csv', '.tsx') */
  fileTypeHints: string[]
  /** Secondary intents */
  secondaryIntents: UserIntent[]
}

//=============================================================================
// Intent Patterns
//=============================================================================

/** Keyword patterns mapped to intents */
const INTENT_PATTERNS: Record<UserIntent, string[]> = {
  'file-discovery': [
    'find',
    'search file',
    'where is',
    'list files',
    'show files',
    'what files',
    'all files',
    'glob',
    'locate',
    'file pattern',
  ],
  'file-read': ['read', 'show me', 'display', 'open', 'view', 'what is in', 'contents of', 'cat'],
  'file-write': ['create', 'write', 'make a file', 'new file', 'generate file', 'save', 'output'],
  'file-edit': ['change', 'replace', 'modify', 'update', 'edit', 'fix in', 'rename', 'refactor'],
  'code-search': [
    'find function',
    'where is function',
    'search for',
    'search text',
    'find usage',
    'find reference',
    'search code',
    'find where',
  ],
  'data-analysis': [
    'analyze',
    'statistics',
    'process data',
    'calculate',
    'aggregate',
    'summarize',
    'pivot',
    'data',
    'csv',
    'excel',
  ],
  'data-visualization': [
    'chart',
    'graph',
    'plot',
    'visualize',
    'visualization',
    'figure',
    'display chart',
    'make graph',
  ],
  'code-generation': [
    'generate',
    'write code',
    'implement',
    'create function',
    'add feature',
    'build',
  ],
  debugging: ['debug', 'bug', 'error', 'fix', 'not working', 'broken', 'issue', 'fail'],
  testing: ['test', 'spec', 'unit test', 'coverage', 'verify', 'check', 'validate'],
  documentation: ['document', 'readme', 'comment', 'explain', 'describe'],
  'batch-operations': ['batch', 'multiple files', 'all at once', 'bulk', 'mass', 'together'],
  refactoring: ['refactor', 'restructure', 'reorganize', 'clean up', 'improve code'],
  unknown: [],
}

/** File extension hints */
const FILE_TYPE_HINTS: Record<string, UserIntent[]> = {
  '.csv': ['data-analysis', 'data-visualization'],
  '.xlsx': ['data-analysis', 'data-visualization'],
  '.xls': ['data-analysis', 'data-visualization'],
  '.json': ['data-analysis', 'file-read'],
  '.ts': ['code-search', 'code-generation', 'file-edit'],
  '.tsx': ['code-search', 'code-generation', 'file-edit'],
  '.js': ['code-search', 'code-generation', 'file-edit'],
  '.jsx': ['code-search', 'code-generation', 'file-edit'],
  '.py': ['code-search', 'code-generation', 'file-edit'],
  '.go': ['code-search', 'code-generation', 'file-edit'],
  '.rs': ['code-search', 'code-generation', 'file-edit'],
  '.md': ['documentation', 'file-read'],
  '.txt': ['file-read', 'data-analysis'],
  '.svg': ['file-read'],
  '.png': ['file-read'],
  '.jpg': ['file-read'],
  '.jpeg': ['file-read'],
}

//=============================================================================
// Tool Metadata
//=============================================================================

/** Tool definitions for recommendation */
const TOOL_METADATA: Record<
  string,
  {
    name: string
    displayName: string
    category: ToolCategory
    intents: UserIntent[]
    description: string
    baseExample: string
  }
> = {
  ls: {
    name: 'ls',
    displayName: 'Directory & Search',
    category: 'discovery',
    intents: ['file-discovery', 'batch-operations'],
    description: 'List directory or search files by pattern',
    baseExample: 'ls(pattern="**/*.csv") or ls(path="src")',
  },
  read: {
    name: 'read',
    displayName: 'Read File',
    category: 'reading',
    intents: ['file-read', 'code-search', 'documentation'],
    description: 'Read file contents',
    baseExample: 'read(path="src/index.ts") or read(paths=["a.ts", "b.ts"])',
  },
  write: {
    name: 'write',
    displayName: 'Write File',
    category: 'writing',
    intents: ['file-write', 'code-generation'],
    description: 'Create or update files',
    baseExample: 'write(path="new.md", content="# Title") or write(files=[{path:"a.ts", content:"..."}])',
  },
  edit: {
    name: 'edit',
    displayName: 'Edit File',
    category: 'writing',
    intents: ['file-edit', 'refactoring'],
    description: 'Replace text in files',
    baseExample: 'edit(path="config.ts", old_text="old", new_text="new")',
  },
  run_python: {
    name: 'run_python',
    displayName: 'Code Execution',
    category: 'analysis',
    intents: ['data-analysis', 'data-visualization', 'testing'],
    description: 'Execute Python code',
    baseExample: 'run_python(code="print(1+1)")',
  },
  spawn_subagent: {
    name: 'spawn_subagent',
    displayName: 'Subagent Delegation',
    category: 'batch',
    intents: ['batch-operations', 'debugging', 'refactoring', 'documentation'],
    description: 'Delegate independent subtasks for parallel execution',
    baseExample: 'spawn_subagent(description="Audit API handlers", prompt="Find all TODOs in api/** and summarize risk by file")',
  },
  batch_spawn: {
    name: 'batch_spawn',
    displayName: 'Batch Subagent Delegation',
    category: 'batch',
    intents: ['batch-operations', 'refactoring', 'documentation'],
    description: 'Launch multiple independent subagent tasks in one call',
    baseExample:
      'batch_spawn(tasks=[{description:"Scan api",prompt:"..."},{description:"Scan ui",prompt:"..."}], max_concurrency=2)',
  },
}

/** Get TOOL_METADATA filtered by enabled features (e.g. batch_spawn) */
function getToolMetadata() {
  const entries = Object.entries(TOOL_METADATA)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- synchronous helper behind sync methods (recommend/getAllTools); dynamic import would change the public API; failure already falls back to full metadata
    const { useSettingsStore } = require('@/store/settings.store')
    if (!useSettingsStore.getState().enableBatchSpawn) {
      return Object.fromEntries(entries.filter(([k]) => k !== 'batch_spawn'))
    }
  } catch { /* fallback: return all */ }
  return TOOL_METADATA
}

//=============================================================================
// Intent Analyzer
//=============================================================================

export class IntentAnalyzer {
  /**
   * Analyze user message to detect intent
   */
  analyze(userMessage: string): IntentAnalysis {
    const lowerMessage = userMessage.toLowerCase()
    const keywords: string[] = []
    const fileTypeHints: string[] = []
    const intentScores: Record<UserIntent, number> = {} as any

    // Initialize scores
    for (const intent of Object.keys(INTENT_PATTERNS)) {
      intentScores[intent as UserIntent] = 0
    }

    // Score each intent based on keyword matches
    for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
      for (const pattern of patterns) {
        if (lowerMessage.includes(pattern)) {
          intentScores[intent as UserIntent] += 1
          keywords.push(pattern)
        }
      }
    }

    // Extract file type hints
    for (const [ext, relatedIntents] of Object.entries(FILE_TYPE_HINTS)) {
      if (lowerMessage.includes(ext)) {
        fileTypeHints.push(ext)
        for (const intent of relatedIntents) {
          intentScores[intent] += 0.5
        }
      }
    }

    // Find primary intent
    let maxScore = 0
    let primaryIntent: UserIntent = 'unknown'
    for (const [intent, score] of Object.entries(intentScores)) {
      if (score > maxScore) {
        maxScore = score
        primaryIntent = intent as UserIntent
      }
    }

    // Calculate confidence (normalized)
    const totalScore = Object.values(intentScores).reduce((a, b) => a + b, 0)
    const confidence = totalScore > 0 ? maxScore / totalScore : 0

    // Find secondary intents (within 80% of primary score)
    const threshold = maxScore * 0.8
    const secondaryIntents: UserIntent[] = []
    for (const [intent, score] of Object.entries(intentScores)) {
      if (intent !== primaryIntent && score >= threshold && score > 0) {
        secondaryIntents.push(intent as UserIntent)
      }
    }

    return {
      primaryIntent,
      confidence,
      keywords: [...new Set(keywords)],
      fileTypeHints,
      secondaryIntents,
    }
  }
}

//=============================================================================
// Recommendation Engine
//=============================================================================

export class RecommendationEngine {
  private analyzer: IntentAnalyzer

  constructor() {
    this.analyzer = new IntentAnalyzer()
  }

  /**
   * Get tool recommendations for a user message
   */
  recommend(userMessage: string, maxResults = 5): ToolRecommendation[] {
    const analysis = this.analyzer.analyze(userMessage)

    // Score tools based on intent match
    const toolScores: Map<string, number> = new Map()

    for (const [toolName, metadata] of Object.entries(getToolMetadata())) {
      let score = 0

      // Direct intent match
      if (metadata.intents.includes(analysis.primaryIntent)) {
        score += 1.0
      }

      // Secondary intent matches
      for (const secondaryIntent of analysis.secondaryIntents) {
        if (metadata.intents.includes(secondaryIntent)) {
          score += 0.5
        }
      }

      // File type hints
      for (const hint of analysis.fileTypeHints) {
        const relatedIntents = FILE_TYPE_HINTS[hint] || []
        if (relatedIntents.some((intent) => metadata.intents.includes(intent))) {
          score += 0.3
        }
      }

      // Category affinity (certain categories go together)
      if (this.hasCategoryAffinity(analysis.primaryIntent, metadata.category)) {
        score += 0.2
      }

      if (score > 0) {
        toolScores.set(toolName, score)
      }
    }

    // Convert to recommendations and sort
    const recommendations: ToolRecommendation[] = []

    for (const [toolName, score] of Array.from(toolScores.entries()).sort((a, b) => b[1] - a[1])) {
      if (recommendations.length >= maxResults) break

      const metadata = TOOL_METADATA[toolName]
      recommendations.push({
        toolName,
        displayName: metadata.displayName,
        reason: this.generateReason(metadata, analysis),
        example: this.generateExample(metadata, analysis),
        score,
        category: metadata.category,
      })
    }

    return recommendations
  }

  /**
   * Get all available tools organized by category
   */
  getAllTools(): Record<ToolCategory, ToolRecommendation[]> {
    const result: Record<string, ToolRecommendation[]> = {
      discovery: [],
      reading: [],
      writing: [],
      search: [],
      analysis: [],
      batch: [],
    }

    for (const [toolName, metadata] of Object.entries(getToolMetadata())) {
      const category = metadata.category
      result[category].push({
        toolName,
        displayName: metadata.displayName,
        reason: metadata.description,
        example: metadata.baseExample,
        score: 0,
        category,
      })
    }

    return result as Record<ToolCategory, ToolRecommendation[]>
  }

  /**
   * Check if intent and category have affinity
   */
  private hasCategoryAffinity(intent: UserIntent, category: ToolCategory): boolean {
    const affinities: Record<UserIntent, ToolCategory[]> = {
      'file-discovery': ['discovery'],
      'file-read': ['reading', 'discovery'],
      'file-write': ['writing'],
      'file-edit': ['writing', 'search'],
      'code-search': ['search', 'reading'],
      'data-analysis': ['analysis', 'reading'],
      'data-visualization': ['analysis'],
      'code-generation': ['writing'],
      debugging: ['search', 'reading'],
      testing: ['analysis', 'reading'],
      documentation: ['reading', 'writing'],
      'batch-operations': ['batch', 'writing'],
      refactoring: ['refactoring', 'writing'],
      unknown: [],
    }

    return affinities[intent]?.includes(category) || false
  }

  /**
   * Generate reason for recommendation
   */
  private generateReason(
    metadata: (typeof TOOL_METADATA)[keyof typeof TOOL_METADATA],
    analysis: IntentAnalysis
  ): string {
    const reasons: string[] = []

    if (analysis.primaryIntent !== 'unknown') {
      reasons.push(`matches your "${analysis.primaryIntent}" intent`)
    }

    if (analysis.fileTypeHints.length > 0) {
      reasons.push(`works with ${analysis.fileTypeHints.join(', ')} files`)
    }

    if (reasons.length === 0) {
      return metadata.description
    }

    return reasons.join(', and ')
  }

  /**
   * Generate contextual example
   */
  private generateExample(
    metadata: (typeof TOOL_METADATA)[keyof typeof TOOL_METADATA],
    analysis: IntentAnalysis
  ): string {
    // Customize example based on detected file types
    if (analysis.fileTypeHints.includes('.csv') && metadata.name === 'run_python') {
      return `First find the file: ls(pattern="**/*.csv")\nThen analyze: run_python(code="import pandas as pd; df=pd.read_csv('/mnt/data.csv'); print(df.describe())")`
    }

    if (analysis.primaryIntent === 'file-discovery' && metadata.name === 'ls') {
      if (analysis.fileTypeHints.length > 0) {
        return `ls(pattern="**/*${analysis.fileTypeHints[0]}")`
      }
      return 'ls(pattern="**/*keyword*")'
    }

    return metadata.baseExample
  }
}

//=============================================================================
// Singleton
//=============================================================================

let instance: RecommendationEngine | null = null

export function getRecommendationEngine(): RecommendationEngine {
  if (!instance) {
    instance = new RecommendationEngine()
  }
  return instance
}

//=============================================================================
// Helper Functions
//=============================================================================

/**
 * Get tool discovery message for first-time users
 */
export function getToolDiscoveryMessage(): string {
  const engine = getRecommendationEngine()
  const allTools = engine.getAllTools()

  let output = `## Available Tools\n\n`

  for (const [category, tools] of Object.entries(allTools)) {
    if (tools.length === 0) continue

    const categoryNames: Record<string, string> = {
      discovery: '🔍 File Discovery',
      reading: '📖 File Reading',
      writing: '✏️ File Writing',
      search: '🔎 Content Search',
      analysis: '📊 Data Analysis',
      batch: '📦 Batch Operations',
    }

    output += `### ${categoryNames[category]}\n`
    for (const tool of tools) {
      output += `- **${tool.displayName}**: ${tool.reason}\n`
      output += `  Example: \`${tool.example}\`\n`
    }
    output += '\n'
  }

  return output
}
