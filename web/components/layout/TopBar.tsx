/**
 * TopBar - minimal top bar for the conversation area.
 *
 * Left: Logo + project name
 * Right: Folder, status badges, action buttons, Settings gear
 *
 * Refactored: Language, Theme, MCP, Docs moved into SettingsDialog.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Settings,
  WandSparkles,
  KeyRound,
  List,
  Keyboard,
  Workflow,
  Menu,
  ArrowLeft,
  ExternalLink,
  SquarePen,
  MoreHorizontal,
} from 'lucide-react'
import { ProjectSwitcher } from './ProjectSwitcher'
import { useHasApiKey, useSettingsStore } from '@/store/settings.store'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import type { SettingsTab } from '@/components/settings/SettingsDialog'
import { ConversationStorageBadge } from '@/components/conversation'
import { FolderSelector } from './FolderSelector'
import { ModelQuickSwitch } from './ModelQuickSwitch'
import { ImageGenDropdown, useHasImageModels } from '@/components/agent/ImageGenDropdown'
import { useT } from '@/i18n'
import {
  BrandButton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@creatorweave/ui'
import { isSidePanelMode } from '@/agent/workspace-assistant-context'
import { useFlowStore } from '@/store/flow.store'

/** Stable tooltip wrapper — defined at module level to avoid recreating on every render. */
const ActionTooltip = ({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) => (
  <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side="bottom">{label}</TooltipContent>
  </Tooltip>
)

interface TopBarProps {
  onSkillsManagerOpen?: () => void
  onToolsPanelOpen?: () => void
  onCommandPaletteOpen?: () => void
  onBackToProjects?: () => void
  activeProjectName?: string
  activeConversationName?: string
  /** @deprecated use activeConversationName */
  activeWorkspaceName?: string
  /** Called when menu button is pressed on mobile */
  onMenuOpen?: () => void
  /** Whether the device is mobile */
  isMobile?: boolean
  /** Switch to a different project by ID */
  onSwitchProject?: (projectId: string) => Promise<void>
  /** Open the "create project" dialog */
  onCreateProject?: () => void
  /** Navigate to project management (project list) */
  onManageProjects?: () => void
  /** Controlled open state for the project switcher dropdown */
  projectSwitcherOpen?: boolean
  /** Callback when project switcher open state changes */
  onProjectSwitcherOpenChange?: (open: boolean) => void
  /** Navigate to a workspace within the current project (updates URL) */
  onSelectWorkspace?: (workspaceId: string) => void
  /** Open the workflow canvas */
  onWorkflowOpen?: () => void
  /** Create a new conversation */
  onNewConversation?: () => void
}

export function TopBar({
  onSkillsManagerOpen,
  onToolsPanelOpen,
  onCommandPaletteOpen,
  onBackToProjects,
  activeProjectName,
  activeConversationName,
  activeWorkspaceName,
  onMenuOpen,
  isMobile,
  onSwitchProject,
  onCreateProject,
  onManageProjects,
  projectSwitcherOpen,
  onProjectSwitcherOpenChange,
  onSelectWorkspace,
  onWorkflowOpen,
  onNewConversation,
}: TopBarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>(undefined)
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
  const mobileMorePanelRef = useRef<HTMLDivElement | null>(null)
  const hasApiKey = useHasApiKey() // Use the reactive hook that syncs with database
  const hasApiKeyLoaded = useSettingsStore((s) => s.hasApiKeyLoaded)
  const hasImageModels = useHasImageModels()
  const flowPanelOpen = useFlowStore((s) => s.panelOpen)
  const t = useT()
  const conversationName = activeConversationName ?? activeWorkspaceName

  useEffect(() => {
    if (!mobileMoreOpen) return

    const handleOutsideClick = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node
      // Ignore clicks inside Radix portals (e.g. ModelQuickSwitch Popover content).
      // These render to document.body via Portal, so they are NOT children of
      // mobileMorePanelRef, but they are logically part of the panel.
      // Without this check, clicking a model in the popover immediately closes
      // the entire mobile panel before the selection registers.
      if (target instanceof Element && target.closest('[data-radix-popper-content-wrapper]')) {
        return
      }
      if (!mobileMorePanelRef.current?.contains(target)) {
        setMobileMoreOpen(false)
      }
    }

    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('touchstart', handleOutsideClick)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('touchstart', handleOutsideClick)
    }
  }, [mobileMoreOpen])

  const closeMobileMorePanel = () => {
    setMobileMoreOpen(false)
  }

  /** Open settings dialog, optionally jumping to a specific tab */
  const openSettings = (tab?: SettingsTab) => {
    setSettingsInitialTab(tab)
    setSettingsOpen(true)
  }

  return (
    <>
      <TooltipProvider delayDuration={200}>
        <header
          className={`relative flex shrink-0 items-center justify-between border-b border-neutral-200 bg-background dark:border-border ${
            isMobile
              ? 'min-h-12 px-2 py-1 max-[599px]:flex-wrap max-[599px]:gap-y-0.5'
              : 'h-[52px] px-4'
          }`}
        >
          {/* Skip link — first focusable element for keyboard / screen reader users */}
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-primary-foreground focus:shadow-lg focus:outline-none"
          >
            {t('common.skipToContent')}
          </a>
        {/* Left: Menu button (mobile) + Logo + Name */}
        <div className={`flex min-w-0 items-center ${isMobile ? 'gap-1 flex-1' : 'flex-1 gap-2'}`}>
          {onBackToProjects && (
            <ActionTooltip label={t('topbar.tooltips.backToProjects')}>
              <BrandButton iconButton onClick={onBackToProjects} className={isMobile ? 'h-7 w-7 shrink-0' : ''}>
                <ArrowLeft className="h-[14px] w-[14px]" />
              </BrandButton>
            </ActionTooltip>
          )}
          {isMobile && (
            <ActionTooltip label={t('topbar.tooltips.menu')}>
              <BrandButton iconButton onClick={onMenuOpen} data-tour="menu" className="h-7 w-7 shrink-0">
                <Menu className="h-[14px] w-[14px]" />
              </BrandButton>
            </ActionTooltip>
          )}
          {activeProjectName && (
            <div className={`flex min-w-0 items-center gap-1 ${isMobile ? 'max-w-[30vw]' : ''}`}>
              <ProjectSwitcher
                activeProjectName={activeProjectName}
                onSwitchProject={onSwitchProject ?? (async () => {})}
                onCreateProject={onCreateProject ?? (() => {})}
                onManageProjects={onManageProjects ?? (() => {})}
                open={projectSwitcherOpen}
                onOpenChange={onProjectSwitcherOpenChange}
              />
              {conversationName && (
                <>
                  {!isMobile && (
                    <>
                      <span className="text-xs text-tertiary dark:text-muted">/</span>
                      <ActionTooltip label={t('topbar.workspaceLabel', { name: conversationName })}>
                        <span className="max-w-[200px] truncate rounded-md bg-muted px-2 py-1 text-xs text-secondary dark:bg-muted/50 dark:text-muted-foreground">
                          {conversationName}
                        </span>
                      </ActionTooltip>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Right: Actions */}
        {isMobile ? (
          <div className="ml-1 flex shrink-0 items-center gap-0.5">
            {/* Model switcher — directly visible. Previously it only lived
                inside the ⋯ more menu, which new users (especially in the
                narrow side panel) never discovered. The TopBar renders on the
                Welcome screen too, so this is the always-visible entry. */}
            <div className="min-w-0 shrink">
              <ModelQuickSwitch onManageProviders={() => openSettings('llm')} />
            </div>

            {/* New conversation — primary action */}
            <ActionTooltip label={t('sidebar.newWorkspace')}>
              <BrandButton
                iconButton
                className="h-7 w-7"
                onClick={() => onNewConversation?.()}
                aria-label={t('sidebar.newWorkspace')}
              >
                <SquarePen className="h-[14px] w-[14px]" />
              </BrandButton>
            </ActionTooltip>

            {/* API key warning badge — can't hide this in more menu */}
            {hasApiKeyLoaded && !hasApiKey && (
              <ActionTooltip label={t('topbar.tooltips.openApiKeySettings')}>
                <BrandButton iconButton onClick={() => openSettings()} className="h-7 w-7" aria-label={t('topbar.tooltips.openApiKeySettings')}>
                  <KeyRound className="h-[14px] w-[14px]" />
                </BrandButton>
              </ActionTooltip>
            )}

            {/* More menu */}
            <ActionTooltip label={t('topbar.tooltips.appSettings')}>
              <BrandButton
                iconButton
                className="h-7 w-7"
                onClick={() => setMobileMoreOpen(true)}
                aria-label={t('topbar.tooltips.appSettings')}
              >
                <MoreHorizontal className="h-[14px] w-[14px]" />
              </BrandButton>
            </ActionTooltip>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {/* Folder Selector */}
            <div className="shrink-0">
              <FolderSelector />
            </div>

            {/* API Key status - consistent button style */}
            {hasApiKeyLoaded && !hasApiKey && (
              <ActionTooltip label={t('topbar.tooltips.openApiKeySettings')}>
                <button
                  type="button"
                  onClick={() => openSettings()}
                  className="hover:bg-warning-100 focus:ring-warning inline-flex h-8 items-center gap-1.5 rounded-md border border-warning-200 bg-warning-50 px-2.5 text-xs font-medium text-warning focus:outline-none focus:ring-2"
                >
                  <KeyRound className="h-4 w-4" />
                  <span>{t('topbar.noApiKey')}</span>
                </button>
              </ActionTooltip>
            )}

            <div className="shrink-0">
              <ModelQuickSwitch onManageProviders={() => openSettings('llm')} />
            </div>

            {/* Image generation model + aspect ratio (combined) */}
            <ImageGenDropdown />

            {/* Conversation Storage - OPFS conversation status with storage dropdown */}
            <div className="shrink-0">
              <ConversationStorageBadge compact onSelectWorkspace={onSelectWorkspace} />
            </div>

            <div className="h-5 w-px bg-muted" />

            {/* Tools Panel */}
            <ActionTooltip label={t('topbar.tooltips.toolsPanel')}>
              <BrandButton iconButton className="shrink-0" onClick={onToolsPanelOpen} data-tour="tools">
                <List className="h-[14px] w-[14px]" />
              </BrandButton>
            </ActionTooltip>

            {/* Workflow Canvas (only in an active conversation) */}
            {conversationName && onWorkflowOpen && (
              <ActionTooltip label={t('topbar.tooltips.workflow')}>
                <BrandButton
                  iconButton
                  className="shrink-0"
                  variant={flowPanelOpen ? 'primary' : undefined}
                  onClick={onWorkflowOpen}
                  aria-pressed={flowPanelOpen}
                >
                  <Workflow className="h-[14px] w-[14px]" />
                </BrandButton>
              </ActionTooltip>
            )}

            {/* Quick Actions / Command Palette */}
            <ActionTooltip label={t('topbar.tooltips.commandPalette')}>
              <BrandButton iconButton onClick={onCommandPaletteOpen}>
                <Keyboard className="h-[14px] w-[14px]" />
              </BrandButton>
            </ActionTooltip>

            {/* Skills */}
            <ActionTooltip label={t('topbar.tooltips.skillsManager')}>
              <BrandButton iconButton className="shrink-0" onClick={onSkillsManagerOpen} data-tour="skills">
                <WandSparkles className="h-[14px] w-[14px]" />
              </BrandButton>
            </ActionTooltip>

            <div className="h-5 w-px bg-muted" />

            {/* Settings */}
            <ActionTooltip label={t('topbar.tooltips.appSettings')}>
              <BrandButton iconButton className="shrink-0" onClick={() => openSettings()}>
                <Settings className="h-[14px] w-[14px]" />
              </BrandButton>
            </ActionTooltip>

            {/* Side panel only: open current workspace in a new tab */}
            {isSidePanelMode() && (
              <ActionTooltip label="在新标签页打开">
                <BrandButton
                  iconButton
                  className="shrink-0"
                  onClick={() => window.open(window.location.href, '_blank', 'noopener')}
                >
                  <ExternalLink className="h-[14px] w-[14px]" />
                </BrandButton>
              </ActionTooltip>
            )}
          </div>
        )}
      </header>

      {isMobile && mobileMoreOpen && (
        <div className="fixed inset-0 z-40 bg-black/20" onClick={closeMobileMorePanel} />
      )}

      {isMobile && mobileMoreOpen && (
        <div
          ref={mobileMorePanelRef}
          className="fixed right-2 top-14 z-50 w-[min(92vw,340px)] rounded-xl border border-neutral-200 bg-white p-2 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
        >
            {/* Workspace settings */}
            <div className="mb-2 rounded-lg border border-neutral-200 bg-neutral-50/60 p-2 dark:border-neutral-700 dark:bg-neutral-800/60">
              <div className="mb-1.5 text-[11px] font-medium text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">
                {t('topbar.mobile.workDirectory')}
              </div>
              <FolderSelector />
            </div>

            {/* Image generation model + aspect ratio (combined).
                Container hides when the current provider has no image models, so the
                mobile "more" panel doesn't leave a blank bordered card behind. */}
            {hasImageModels && (
              <div className="mb-2 rounded-lg border border-neutral-200 p-2 dark:border-neutral-700">
                <ImageGenDropdown />
              </div>
            )}

            {/* Quick actions grid */}
            <div className="grid grid-cols-2 gap-1.5">
              <BrandButton
                variant="ghost"
                className="h-9 justify-start gap-2 text-xs"
                onClick={() => {
                  openSettings()
                  closeMobileMorePanel()
                }}
              >
                <Settings className="h-3.5 w-3.5" />
                {t('topbar.tooltips.appSettings')}
              </BrandButton>
              <BrandButton
                variant="ghost"
                className="h-9 justify-start gap-2 text-xs"
                onClick={() => {
                  onSkillsManagerOpen?.()
                  closeMobileMorePanel()
                }}
              >
                <WandSparkles className="h-3.5 w-3.5" />
                {t('topbar.mobile.skills')}
              </BrandButton>
              <BrandButton
                variant="ghost"
                className="h-9 justify-start gap-2 text-xs"
                onClick={() => {
                  onCommandPaletteOpen?.()
                  closeMobileMorePanel()
                }}
              >
                <Keyboard className="h-3.5 w-3.5" />
                {t('topbar.mobile.commandPalette')}
              </BrandButton>
              {isSidePanelMode() && (
                <BrandButton
                  variant="ghost"
                  className="h-9 justify-start gap-2 text-xs"
                  onClick={() => {
                    window.open(window.location.href, '_blank', 'noopener')
                    closeMobileMorePanel()
                  }}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  新标签页
                </BrandButton>
              )}
            </div>
        </div>
      )}
      </TooltipProvider>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} initialTab={settingsInitialTab} />
    </>
  )
}
