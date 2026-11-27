/* eslint-disable react-refresh/only-export-components */
/**
 * Enhanced Command Palette Commands
 *
 * Comprehensive command set for all user personas:
 * - Developers: code analysis, refactoring, debugging
 * - Data Analysts: data processing, visualization, statistics
 * - Students: learning, problem-solving
 * - Office Workers: document processing, automation
 *
 * @module command-palette-commands
 */

import {
  Plus,
  Settings,
  HelpCircle,
  Folder,
  History,
  Sparkles,
  Layout,
  Moon,
} from 'lucide-react'
import type { Command } from './CommandPalette'

// import.meta.env is not available in the Next.js web bundle.
const DEV = process.env.NODE_ENV !== 'production'

type TranslateFn = (key: string, params?: Record<string, string | number>) => string

// ============================================================================
// Command Categories
// ============================================================================

export const COMMAND_CATEGORIES = {
  CONVERSATIONS: 'Conversations',
  FILES: 'Files',
  VIEW: 'View',
  TOOLS: 'Tools',
  SETTINGS: 'Settings',
  HELP: 'Help',
} as const

type CategoryValue = (typeof COMMAND_CATEGORIES)[keyof typeof COMMAND_CATEGORIES]

const CATEGORY_KEY_MAP: Record<CategoryValue, string> = {
  [COMMAND_CATEGORIES.CONVERSATIONS]: 'conversations',
  [COMMAND_CATEGORIES.FILES]: 'files',
  [COMMAND_CATEGORIES.VIEW]: 'view',
  [COMMAND_CATEGORIES.TOOLS]: 'tools',
  [COMMAND_CATEGORIES.SETTINGS]: 'settings',
  [COMMAND_CATEGORIES.HELP]: 'help',
}

// ============================================================================
// Command Builders
// ============================================================================

/**
 * Build all enhanced commands for the palette
 */
export function buildEnhancedCommands(
  handlers: CommandHandlers,
  options?: { t?: TranslateFn; enableLocalization?: boolean }
): Command[] {
  const commands: Command[] = [
    // ========== Conversations ==========
    {
      id: 'new-conversation',
      label: 'New Conversation',
      description: 'Start a new conversation',
      category: COMMAND_CATEGORIES.CONVERSATIONS,
      icon: <Plus className="h-4 w-4" />,
      keywords: ['create', 'new', 'chat', 'conversation'],
      handler: handlers.onNewConversation,
    },
    {
      id: 'continue-last',
      label: 'Continue Last Conversation',
      description: 'Return to your most recent conversation',
      category: COMMAND_CATEGORIES.CONVERSATIONS,
      icon: <History className="h-4 w-4" />,
      keywords: ['recent', 'last', 'previous', 'resume'],
      handler: handlers.onContinueLast,
    },

    // ========== Files ==========
    {
      id: 'open-file',
      label: 'Open File...',
      description: 'Open a file from your workspace',
      category: COMMAND_CATEGORIES.FILES,
      icon: <Folder className="h-4 w-4" />,
      keywords: ['open', 'file', 'browse', 'select'],
      handler: handlers.onOpenFile,
    },

    // ========== View ==========
    {
      id: 'toggle-sidebar',
      label: 'Toggle Sidebar',
      description: 'Show or hide the sidebar',
      category: COMMAND_CATEGORIES.VIEW,
      icon: <Layout className="h-4 w-4" />,
      keywords: ['sidebar', 'panel', 'navigation', 'toggle'],
      handler: handlers.onToggleSidebar,
    },
    {
      id: 'toggle-theme',
      label: 'Toggle Theme',
      description: 'Switch between light and dark mode',
      category: COMMAND_CATEGORIES.VIEW,
      icon: <Moon className="h-4 w-4" />,
      keywords: ['theme', 'dark', 'light', 'mode'],
      handler: handlers.onToggleTheme,
    },

    // ========== Tools ==========
    {
      id: 'open-skills',
      label: 'Skills Manager',
      description: 'Manage your skills',
      category: COMMAND_CATEGORIES.TOOLS,
      icon: <Sparkles className="h-4 w-4" />,
      keywords: ['skills', 'manage', 'extensions'],
      handler: handlers.onOpenSkills,
    },
    {
      id: 'open-tools',
      label: 'Tools Panel',
      description: 'Open tools panel',
      category: COMMAND_CATEGORIES.TOOLS,
      icon: <Settings className="h-4 w-4" />,
      keywords: ['tools', 'panel', 'actions'],
      handler: handlers.onOpenTools,
    },
    {
      id: 'open-mcp',
      label: 'MCP Services',
      description: 'Manage MCP services',
      category: COMMAND_CATEGORIES.TOOLS,
      icon: <Settings className="h-4 w-4" />,
      keywords: ['mcp', 'services', 'extensions'],
      handler: handlers.onOpenMCP,
    },

    // ========== Settings ==========
    {
      id: 'workspace-settings',
      label: 'Workspace Settings',
      description: 'Configure workspace preferences',
      category: COMMAND_CATEGORIES.SETTINGS,
      icon: <Settings className="h-4 w-4" />,
      keywords: ['settings', 'preferences', 'config'],
      handler: handlers.onOpenSettings,
    },

    // ========== Help ==========
    {
      id: 'keyboard-shortcuts',
      label: 'Keyboard Shortcuts',
      description: 'View all keyboard shortcuts',
      category: COMMAND_CATEGORIES.HELP,
      icon: <HelpCircle className="h-4 w-4" />,
      keywords: ['shortcuts', 'keyboard', 'hotkeys', 'help'],
      handler: handlers.onShowShortcuts,
    },
  ]

  if (!options?.enableLocalization || !options.t) {
    return commands
  }

  const t = options.t
  const translateOrDefault = (key: string, fallback: string): string => {
    const translated = t(key)
    return !translated || translated === key ? fallback : translated
  }

  return commands.map((command) => {
    const categoryKey = command.category
      ? CATEGORY_KEY_MAP[command.category as CategoryValue]
      : undefined

    return {
      ...command,
      label: translateOrDefault(`commandPalette.commands.${command.id}.label`, command.label),
      description: command.description
        ? translateOrDefault(
            `commandPalette.commands.${command.id}.description`,
            command.description
          )
        : command.description,
      category:
        command.category && categoryKey
          ? translateOrDefault(`commandPalette.categories.${categoryKey}`, command.category)
          : command.category,
    }
  })
}

// ============================================================================
// Command Handlers Interface
// ============================================================================

export interface CommandHandlers {
  // Conversations
  onNewConversation: () => void
  onContinueLast: () => void

  // Files
  onOpenFile: () => void

  // View
  onToggleSidebar: () => void
  onToggleTheme: () => void

  // Tools
  onOpenSkills: () => void
  onOpenTools: () => void
  onOpenMCP: () => void

  // Settings & Help
  onOpenSettings: () => void
  onShowShortcuts: () => void
}

// ============================================================================
// Default Handlers (stub implementations)
// ============================================================================

export function createDefaultHandlers(overrides: Partial<CommandHandlers> = {}): CommandHandlers {
  const defaultHandlers: CommandHandlers = {
    onNewConversation: () => { if (DEV) console.log('[CommandPalette] New conversation') },
    onContinueLast: () => { if (DEV) console.log('[CommandPalette] Continue last conversation') },
    onOpenFile: () => { if (DEV) console.log('[CommandPalette] Open file dialog') },
    onToggleSidebar: () => { if (DEV) console.log('[CommandPalette] Toggle sidebar') },
    onToggleTheme: () => { if (DEV) console.log('[CommandPalette] Toggle theme') },
    onOpenSkills: () => { if (DEV) console.log('[CommandPalette] Open skills manager') },
    onOpenTools: () => { if (DEV) console.log('[CommandPalette] Open tools panel') },
    onOpenMCP: () => { if (DEV) console.log('[CommandPalette] Open MCP settings') },
    onOpenSettings: () => { if (DEV) console.log('[CommandPalette] Open settings') },
    onShowShortcuts: () => { if (DEV) console.log('[CommandPalette] Show shortcuts') },
  }

  return { ...defaultHandlers, ...overrides }
}
