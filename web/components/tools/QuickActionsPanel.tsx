/**
 * QuickActionsPanel - Quick Actions Panel
 *
 * Provides quick access to common operations, categorized by scenario.
 * Features:
 * - Quick command templates
 * - Recently used files
 * - Quick code execution
 * - Collapsible/expandable
 */

import { useState, useCallback, useEffect } from 'react'
import {
  X,
  Search,
  ChevronRight,
  Code,
  FileSearch,
  BarChart3,
  Zap,
  Terminal,
  FolderOpen,
  Clock,
  Sparkles,
  TrendingUp,
} from 'lucide-react'
import { useAgentStore } from '@/store/agent.store'
import { useConversationStore } from '@/store/conversation.store'
import { useSettingsStore } from '@/store/settings.store'
import { createUserMessage } from '@/agent/message-types'
import { getIntelligenceCoordinator } from '@/agent/intelligence-coordinator'
import { selectFolderReadWrite } from '@/services/fsAccess.service'
import { useT } from '@/i18n'

//=============================================================================
// Types
//==============================================================================

interface QuickAction {
  id: string
  labelKey: string
  descriptionKey: string
  icon: React.ElementType
  prompt: string
  category: ActionCategory
}

type ActionCategory = 'discovery' | 'code' | 'analysis' | 'automation' | 'all'

//=============================================================================
// Quick Actions Configuration
//=============================================================================

const QUICK_ACTIONS: QuickAction[] = [
  // File Discovery
  {
    id: 'find-files',
    labelKey: 'tools.quickActionsItems.findFiles',
    descriptionKey: 'tools.quickActionsItems.findFilesDesc',
    icon: FileSearch,
    category: 'discovery',
    prompt: 'Find all TypeScript files in the src directory',
  },
  {
    id: 'search-code',
    labelKey: 'tools.quickActionsItems.searchCode',
    descriptionKey: 'tools.quickActionsItems.searchCodeDesc',
    icon: FileSearch,
    category: 'discovery',
    prompt: 'Search for "function" in all .ts files',
  },

  // Code Operations
  {
    id: 'explain-code',
    labelKey: 'tools.quickActionsItems.explainCode',
    descriptionKey: 'tools.quickActionsItems.explainCodeDesc',
    icon: Code,
    category: 'code',
    prompt: 'Explain what this file does',
  },
  {
    id: 'run-python',
    labelKey: 'tools.quickActionsItems.runPython',
    descriptionKey: 'tools.quickActionsItems.runPythonDesc',
    icon: Terminal,
    category: 'code',
    prompt: 'I want to run some Python code',
  },

  // Data Analysis
  {
    id: 'analyze-csv',
    labelKey: 'tools.quickActionsItems.analyzeCSV',
    descriptionKey: 'tools.quickActionsItems.analyzeCSVDesc',
    icon: BarChart3,
    category: 'analysis',
    prompt: 'Find CSV files and analyze them',
  },
  {
    id: 'create-chart',
    labelKey: 'tools.quickActionsItems.createChart',
    descriptionKey: 'tools.quickActionsItems.createChartDesc',
    icon: BarChart3,
    category: 'analysis',
    prompt: 'Create a chart from the data',
  },

  // Automation
  {
    id: 'batch-rename',
    labelKey: 'tools.quickActionsItems.batchRename',
    descriptionKey: 'tools.quickActionsItems.batchRenameDesc',
    icon: Zap,
    category: 'automation',
    prompt: 'Help me rename multiple files at once',
  },
  {
    id: 'convert-files',
    labelKey: 'tools.quickActionsItems.convertFiles',
    descriptionKey: 'tools.quickActionsItems.convertFilesDesc',
    icon: Zap,
    category: 'automation',
    prompt: 'Convert files from one format to another',
  },
]

//=============================================================================
// Component Props
//=============================================================================

interface QuickActionsPanelProps {
  isOpen: boolean
  onClose: () => void
  onStartConversation?: (text: string) => void
  activeTab?: 'actions' | 'smart' | 'upload'
}

//=============================================================================
// Main Component
//=============================================================================

export function QuickActionsPanel({
  isOpen,
  onClose,
  onStartConversation,
  activeTab: controlledTab,
}: QuickActionsPanelProps) {
  const t = useT()
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<ActionCategory>('all')
  const [recentFiles, setRecentFiles] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<'actions' | 'smart' | 'upload'>(
    controlledTab || 'actions'
  )
  const [smartSuggestions, setSmartSuggestions] = useState<
    Array<{
      id: string
      title: string
      description: string
      prompt: string
    }>
  >([])

  const directoryHandle = useAgentStore((s) => s.directoryHandle)
  const setDirectoryHandle = useAgentStore((s) => s.setDirectoryHandle)
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const createNew = useConversationStore((s) => s.createNew)
  const setActive = useConversationStore((s) => s.setActive)
  const runAgent = useConversationStore((s) => s.runAgent)
  const updateMessages = useConversationStore((s) => s.updateMessages)
  const providerType = useSettingsStore((s) => s.providerType)
  const modelName = useSettingsStore((s) => s.modelName)
  const maxTokens = useSettingsStore((s) => s.maxTokens)

  // Load recent files from localStorage
  useState(() => {
    try {
      const stored = localStorage.getItem('recent-files')
      if (stored) {
        setRecentFiles(JSON.parse(stored).slice(0, 5))
      }
    } catch {
      // Ignore
    }
  })

  // Load smart suggestions
  useEffect(() => {
    const loadSmartData = async () => {
      if (!directoryHandle) return

      try {
        const coordinator = getIntelligenceCoordinator()

        // Get tool recommendations
        const allTools = coordinator.getAllTools()
        const suggestions = []

        // Get top 3 tools across all categories
        for (const tools of Object.values(allTools)) {
          for (const tool of tools.slice(0, 1)) {
            suggestions.push({
              id: tool.toolName,
              title: tool.displayName,
              description: tool.reason,
              prompt: `Help me use the ${tool.displayName} tool`,
            })
            if (suggestions.length >= 5) break
          }
          if (suggestions.length >= 5) break
        }

        setSmartSuggestions(suggestions)
      } catch (error) {
        console.warn('[QuickActionsPanel] Failed to load smart data:', error)
      }
    }

    loadSmartData()
  }, [directoryHandle])

  // Filter actions by category and search
  const filteredActions = QUICK_ACTIONS.filter((action) => {
    const matchesCategory = selectedCategory === 'all' || action.category === selectedCategory
    const label = t(action.labelKey)
    const description = t(action.descriptionKey)
    const matchesSearch =
      !searchQuery.trim() ||
      label.toLowerCase().includes(searchQuery.toLowerCase()) ||
      description.toLowerCase().includes(searchQuery.toLowerCase())
    return matchesCategory && matchesSearch
  })

  const handleActionClick = useCallback(
    (action: QuickAction) => {
      if (activeConversationId) {
        // Add to existing conversation
        const userMsg = createUserMessage(action.prompt)
        const currentConv = useConversationStore
          .getState()
          .conversations.find((c) => c.id === activeConversationId)
        const currentMessages = currentConv ? [...currentConv.messages, userMsg] : [userMsg]
        updateMessages(activeConversationId, currentMessages)
        runAgent(activeConversationId, providerType, modelName, maxTokens, directoryHandle)
      } else if (onStartConversation) {
        // Create new conversation
        onStartConversation(action.prompt)
      } else {
        // Fallback: create new conversation
        const conv = createNew(t(action.labelKey))
        setActive(conv.id)
        setTimeout(() => {
          const userMsg = createUserMessage(action.prompt)
          const currentConv = useConversationStore
            .getState()
            .conversations.find((c) => c.id === conv.id)
          const currentMessages = currentConv ? [...currentConv.messages, userMsg] : [userMsg]
          updateMessages(conv.id, currentMessages)
          runAgent(conv.id, providerType, modelName, maxTokens, directoryHandle)
        }, 100)
      }
      onClose()
    },
    [
      activeConversationId,
      directoryHandle,
      createNew,
      setActive,
      onClose,
      onStartConversation,
      updateMessages,
      runAgent,
      providerType,
      modelName,
      maxTokens,
      t,
    ]
  )

  const handleSelectFolder = async () => {
    try {
      const handle = await selectFolderReadWrite()
      if (!handle) return
      setDirectoryHandle(handle)
    } catch (error) {
      if (error instanceof Error && error.message === 'User cancelled') return
      console.error('Failed to select folder:', error)
    }
  }

  // Category definitions with i18n keys
  const categories = [
    { id: 'all', nameKey: 'tools.categories.all', icon: Zap },
    { id: 'discovery', nameKey: 'tools.categories.discovery', icon: FileSearch },
    { id: 'code', nameKey: 'tools.categories.code', icon: Code },
    { id: 'analysis', nameKey: 'tools.categories.analysis', icon: BarChart3 },
    { id: 'automation', nameKey: 'tools.categories.automation', icon: Zap },
  ]

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm transition-opacity" onClick={onClose} />

      {/* Panel */}
      <div className="fixed left-0 top-0 z-50 flex h-full w-full max-w-sm flex-col bg-card shadow-2xl dark:bg-card">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary-50 p-2 dark:bg-primary-100/30">
              <Zap className="h-4 w-4 text-primary-600 dark:text-primary-500" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-secondary dark:text-foreground">{t('tools.quickActions')}</h2>
              <p className="text-xs text-tertiary dark:text-muted">{t('tools.commonTasks')}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-tertiary transition-colors hover:bg-muted hover:text-secondary dark:text-muted dark:hover:bg-muted dark:hover:text-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-border px-2">
          <button
            onClick={() => setActiveTab('actions')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'actions'
                ? 'border-b-2 border-primary-500 text-primary-600 dark:text-primary-500'
                : 'text-secondary hover:text-primary dark:text-muted dark:hover:text-primary-foreground'
            }`}
          >
            <Zap className="h-4 w-4" />
            {t('tools.actions')}
          </button>
          <button
            onClick={() => setActiveTab('smart')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'smart'
                ? 'border-b-2 border-primary-500 text-primary-600 dark:text-primary-500'
                : 'text-secondary hover:text-primary dark:text-muted dark:hover:text-primary-foreground'
            }`}
          >
            <Sparkles className="h-4 w-4" />
            {t('tools.smart')}
          </button>
          <button
            onClick={() => setActiveTab('upload')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'upload'
                ? 'border-b-2 border-primary-500 text-primary-600 dark:text-primary-500'
                : 'text-secondary hover:text-primary dark:text-muted dark:hover:text-primary-foreground'
            }`}
          >
            <FolderOpen className="h-4 w-4" />
            {t('tools.upload')}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {/* Actions Tab */}
          {activeTab === 'actions' && (
            <div className="p-4">
              {/* Search */}
              <div className="mb-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-tertiary" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t('tools.searchActions')}
                    className="w-full rounded-lg border border-border bg-muted py-2 pl-10 pr-4 text-sm text-primary placeholder:text-tertiary focus:border-primary-100 focus:bg-card focus:outline-none focus:ring-2 focus:ring-primary-100 dark:border-border dark:bg-muted dark:text-primary-foreground dark:placeholder:text-muted dark:focus:bg-card"
                  />
                </div>
              </div>

              {/* Category Tabs */}
              <div className="mb-4 flex gap-1 overflow-x-auto">
                {categories.map((cat) => {
                  const Icon = cat.icon
                  const isActive = selectedCategory === cat.id
                  return (
                    <button
                      key={cat.id}
                      onClick={() => setSelectedCategory(cat.id as ActionCategory)}
                      className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                        isActive
                          ? 'bg-primary-100 text-primary-700 dark:bg-primary-100/30 dark:text-primary-700'
                          : 'text-secondary hover:bg-muted dark:text-muted dark:hover:bg-muted'
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      <span>{t(cat.nameKey)}</span>
                    </button>
                  )
                })}
              </div>

              {/* Quick Actions List */}
              <div className="space-y-2">
                {filteredActions.map((action) => {
                  const Icon = action.icon
                  return (
                    <button
                      key={action.id}
                      onClick={() => handleActionClick(action)}
                      className="flex w-full items-start gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:border-primary-100 hover:bg-primary-50/50 dark:border-border dark:hover:bg-primary-100/20"
                    >
                      <div className="mt-0.5 rounded-lg bg-primary-50 p-2 dark:bg-primary-100/20">
                        <Icon className="h-4 w-4 text-primary-600 dark:text-primary-500" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-secondary dark:text-foreground">{t(action.labelKey)}</p>
                        <p className="mt-0.5 text-xs text-tertiary dark:text-muted">{t(action.descriptionKey)}</p>
                      </div>
                      <ChevronRight className="mt-1 h-4 w-4 text-tertiary" />
                    </button>
                  )
                })}
              </div>

              {/* Recent Files */}
              {recentFiles.length > 0 && (
                <div className="mt-6">
                  <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-tertiary dark:text-muted">
                    {t('tools.recentFiles')}
                  </h3>
                  <div className="space-y-1">
                    {recentFiles.map((file, idx) => (
                      <button
                        key={idx}
                        className="group flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-muted dark:hover:bg-muted"
                      >
                        <Clock className="h-4 w-4 text-tertiary group-hover:text-secondary" />
                        <span className="truncate text-sm text-secondary dark:text-muted">{file}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Smart Tab */}
          {activeTab === 'smart' && (
            <div className="p-4">
              {/* Smart Suggestions */}
              <div className="mb-2">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-medium text-secondary dark:text-muted">{t('tools.suggestedForYou')}</h3>
                  <button
                    onClick={() => {
                      // Refresh suggestions
                      const coordinator = getIntelligenceCoordinator()
                      const allTools = coordinator.getAllTools()
                      const suggestions = []
                      for (const tools of Object.values(allTools)) {
                        for (const tool of tools.slice(0, 1)) {
                          suggestions.push({
                            id: tool.toolName,
                            title: tool.displayName,
                            description: tool.reason,
                            prompt: `Help me use the ${tool.displayName} tool`,
                          })
                          if (suggestions.length >= 5) break
                        }
                        if (suggestions.length >= 5) break
                      }
                      setSmartSuggestions(suggestions)
                    }}
                    className="rounded p-1 text-tertiary transition-colors hover:bg-muted hover:text-secondary dark:text-muted dark:hover:bg-muted dark:hover:text-muted"
                    title={t('tools.refreshSuggestions')}
                  >
                    <TrendingUp className="h-4 w-4" />
                  </button>
                </div>
                <div className="space-y-2">
                  {smartSuggestions.map((suggestion) => (
                    <button
                      key={suggestion.id}
                      onClick={() => {
                        if (activeConversationId) {
                          const userMsg = createUserMessage(suggestion.prompt)
                          const currentConv = useConversationStore
                            .getState()
                            .conversations.find((c) => c.id === activeConversationId)
                          const currentMessages = currentConv
                            ? [...currentConv.messages, userMsg]
                            : [userMsg]
                          updateMessages(activeConversationId, currentMessages)
                          runAgent(
                            activeConversationId,
                            providerType,
                            modelName,
                            maxTokens,
                            directoryHandle
                          )
                        } else if (onStartConversation) {
                          onStartConversation(suggestion.prompt)
                        }
                        onClose()
                      }}
                      className="flex w-full items-start gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:border-primary-100 hover:bg-primary-50/50 dark:border-border dark:hover:bg-primary-100/20"
                    >
                      <div className="mt-0.5 rounded-lg bg-primary-50/60 p-2 dark:bg-primary-100/20">
                        <Sparkles className="h-4 w-4 text-primary-600 dark:text-primary-500" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-secondary dark:text-foreground">{suggestion.title}</p>
                        <p className="mt-0.5 text-xs text-tertiary dark:text-muted">{suggestion.description}</p>
                      </div>
                      <ChevronRight className="mt-1 h-4 w-4 text-tertiary" />
                    </button>
                  ))}
                </div>
              </div>

              {/* TypeScript Actions */}
              <div className="mt-6">
                <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-tertiary dark:text-muted">
                  {t('tools.typeScriptActions')}
                </h3>
                <div className="space-y-2">
                  <button
                    onClick={() => {
                      const prompt =
                        'Analyze the TypeScript code structure, find all types, interfaces, and their relationships'
                      if (onStartConversation) onStartConversation(prompt)
                      onClose()
                    }}
                    className="flex w-full items-center gap-3 rounded-lg p-3 text-left transition-colors hover:bg-muted dark:hover:bg-muted"
                  >
                    <Code className="h-4 w-4 text-blue-600" />
                    <span className="text-sm text-secondary dark:text-muted">{t('tools.analyzeTypes')}</span>
                  </button>
                  <button
                      onClick={() => {
                        const prompt = 'Find all React components and their props'
                        if (onStartConversation) onStartConversation(prompt)
                        onClose()
                      }}
                      className="flex w-full items-center gap-3 rounded-lg p-3 text-left transition-colors hover:bg-muted dark:hover:bg-muted"
                    >
                      <Code className="h-4 w-4 text-blue-600" />
                      <span className="text-sm text-secondary dark:text-muted">{t('tools.findReactComponents')}</span>
                    </button>
                  </div>
                </div>
            </div>
          )}

          {/* Upload Tab */}
          {activeTab === 'upload' && (
            <div className="p-4">
              {/* Folder Selection */}
              <div className="mb-4 rounded-xl border-2 border-dashed border-border bg-muted/50 p-6 text-center dark:bg-muted/50">
                <FolderOpen className="mx-auto mb-3 h-10 w-10 text-tertiary dark:text-muted" />
                <p className="mb-2 text-sm font-medium text-secondary dark:text-foreground">{t('tools.selectProjectFolder')}</p>
                <p className="mb-4 text-xs text-tertiary dark:text-muted">
                  {t('tools.chooseFolderToAnalyze')}
                </p>
                <button
                  onClick={handleSelectFolder}
                  className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700"
                >
                  {t('tools.browseFolders')}
                </button>
              </div>

              {/* Current Folder Info */}
              {directoryHandle && (
                <div className="rounded-xl border border-green-200 bg-green-50 p-4 dark:border-green-900/30 dark:bg-green-900/20">
                  <p className="mb-1 text-sm font-medium text-green-900 dark:text-green-300">{t('tools.folderSelected')}</p>
                  <p className="text-xs text-green-700 dark:text-green-400">{directoryHandle.name}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border bg-muted/50 px-5 py-3 dark:bg-muted/50">
          <p className="text-center text-xs text-tertiary dark:text-muted">
            {t('tools.openQuickActions', { shortcut: 'Cmd+K' })}
          </p>
        </div>
      </div>
    </>
  )
}
