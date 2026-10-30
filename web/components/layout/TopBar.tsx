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
  List,
  Keyboard,
  Workflow,
  Menu,
  ArrowLeft,
  Clock,
  ExternalLink,
  SquarePen,
  MoreHorizontal,
  MessageCircle,
} from 'lucide-react'
import { ProjectSwitcher } from './ProjectSwitcher'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import type { SettingsTab } from '@/components/settings/SettingsDialog'
import { FolderSelector } from './FolderSelector'
import { useT } from '@/i18n'
import {
  BrandButton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@creatorweave/ui'
import { isSidePanelMode } from '@/agent/workspace-assistant-context'
import { useFlowStore } from '@/store/flow.store'
import { useConversationStore } from '@/store/conversation.store'

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

/**
 * The convert entry for a kind='direct' conversation: a small badge button
 * that upgrades the standalone chat to a project conversation (folder
 * authorization + kind flip via convertDirectToProject). Shared by BOTH
 * route spaces so /chats/:id offers the same conversion entry as
 * /projects/:projectId (desktop only — the mobile header has no room for
 * the inline label and keeps the action in the more menu's reach via the
 * conversation surface).
 */
const ConvertDirectChatBadge = () => {
  const t = useT()
  return (
    <ActionTooltip label={t('topbar.directChat.convertTooltip')}>
      <button
        type="button"
        data-testid="direct-chat-convert"
        className="shrink-0 rounded-full border border-primary-200 bg-primary-50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary-700 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-300"
        onClick={async () => {
          const id = useConversationStore.getState().activeConversationId
          if (!id) return
          await useConversationStore.getState().convertDirectToProject(id)
        }}
      >
        {t('conversation.directChat.badge')}
      </button>
    </ActionTooltip>
  )
}

interface TopBarProps {
  onSkillsManagerOpen?: () => void
  onToolsPanelOpen?: () => void
  onCommandPaletteOpen?: () => void
  onBackToProjects?: () => void
  activeProjectName?: string
  activeConversationName?: string
  /** @deprecated use activeConversationName */
  activeWorkspaceName?: string
  /** Active conversation is kind='direct' (standalone chat) — shows the badge */
  activeConversationIsDirect?: boolean
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
  /** Open the schedule drawer */
  onScheduleDrawerOpen?: () => void
  /** Open the workflow canvas */
  onWorkflowOpen?: () => void
  /** Create a new conversation */
  onNewConversation?: () => void
  /** Navigate to the standalone chats home (/chats) — global ◇ entry */
  onOpenStandaloneChats?: () => void
  /**
   * Which route space hosts this TopBar. 'chats' hides the project switcher
   * (standalone chats have no project semantics) and swaps the back-target
   * wording.
   */
  routeSpace?: 'projects' | 'chats'
}

export function TopBar({
  onSkillsManagerOpen,
  onToolsPanelOpen,
  onCommandPaletteOpen,
  onBackToProjects,
  activeProjectName,
  activeConversationName,
  activeConversationIsDirect,
  activeWorkspaceName,
  onMenuOpen,
  isMobile,
  onSwitchProject,
  onCreateProject,
  onManageProjects,
  projectSwitcherOpen,
  onProjectSwitcherOpenChange,
  onScheduleDrawerOpen,
  onWorkflowOpen,
  onNewConversation,
  onOpenStandaloneChats,
  routeSpace = 'projects',
}: TopBarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>(undefined)
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
  const mobileMorePanelRef = useRef<HTMLDivElement | null>(null)
  const flowPanelOpen = useFlowStore((s) => s.panelOpen)
  const t = useT()
  const conversationName = activeConversationName ?? activeWorkspaceName

  useEffect(() => {
    if (!mobileMoreOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileMoreOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [mobileMoreOpen])

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
            isMobile ? 'min-h-11 px-2 py-0.5' : 'h-12 px-4'
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
          {routeSpace === 'chats' ? (
            // Standalone chats space: no project semantics — show the space
            // name instead of a project switcher. The convert badge is still
            // rendered here: a standalone chat opened in /chats/:id must keep
            // its conversion entry (identical to the project-space branch),
            // otherwise users in the chats route space have no convert UI.
            <div className="flex min-w-0 items-center gap-1">
              <span className="max-w-[200px] truncate rounded-md bg-muted px-2 py-1 text-xs text-secondary dark:bg-muted/50 dark:text-muted-foreground">
                {t('topbar.standaloneChats.spaceName')}
              </span>
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
              {activeConversationIsDirect && (
                <ConvertDirectChatBadge />
              )}
            </div>
          ) : (
            <>
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
                      {activeConversationIsDirect && (
                        <ConvertDirectChatBadge />
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}
            </>
          )}
          {isMobile && !activeConversationIsDirect && routeSpace === 'projects' && (
            <div className="flex min-w-0 shrink items-center">
              <FolderSelector />
            </div>
          )}
        </div>

        {/* Right: Actions */}
        {isMobile ? (
          <div className="ml-1 flex shrink-0 items-center gap-0.5">
            {/* Standalone chats — global entry (all pages, all route spaces) */}
            {onOpenStandaloneChats && (
              <ActionTooltip label={t('topbar.standaloneChats.tooltip')}>
                <BrandButton
                  iconButton
                  className="h-7 w-7"
                  onClick={onOpenStandaloneChats}
                  aria-label={t('topbar.standaloneChats.tooltip')}
                >
                  <MessageCircle className="h-[14px] w-[14px]" />
                </BrandButton>
              </ActionTooltip>
            )}
            {/* Model switcher — directly visible. Previously it only lived
                inside the ⋯ more menu, which new users (especially in the
                narrow side panel) never discovered. The TopBar renders on the
                Welcome screen too, so this is the always-visible entry. */}
            {/* Fixed-width slot so the trigger can never spill over the
                project switcher on the left (regression from 24bd878 where
                an unconstrained trigger overlapped it on narrow viewports). */}
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

            {/* More menu */}
            <ActionTooltip label={t('topbar.tooltips.more')}>
              <BrandButton
                iconButton
                className="h-7 w-7"
                onClick={() => setMobileMoreOpen(true)}
                aria-label={t('topbar.tooltips.more')}
                aria-expanded={mobileMoreOpen}
              >
                <MoreHorizontal className="h-[14px] w-[14px]" />
              </BrandButton>
            </ActionTooltip>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {/* Folder Selector — hidden in direct conversations (no folder semantics) */}
            {!activeConversationIsDirect && (
              <div className="shrink-0">
                <FolderSelector />
              </div>
            )}

            {/* Standalone chats — global ◇ entry (all pages, all route spaces) */}
            {onOpenStandaloneChats && (
              <ActionTooltip label={t('topbar.standaloneChats.tooltip')}>
                <BrandButton
                  iconButton
                  className="shrink-0"
                  onClick={onOpenStandaloneChats}
                  aria-label={t('topbar.standaloneChats.tooltip')}
                >
                  <MessageCircle className="h-[14px] w-[14px]" />
                </BrandButton>
              </ActionTooltip>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <BrandButton iconButton aria-label={t('topbar.tooltips.more')}>
                  <MoreHorizontal className="h-[14px] w-[14px]" />
                </BrandButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 rounded-xl p-1.5">
                <DropdownMenuItem onSelect={() => onToolsPanelOpen?.()}>
                  <List className="h-3.5 w-3.5" />
                  {t('topbar.tooltips.toolsPanel')}
                </DropdownMenuItem>
                <DropdownMenuItem data-tour="schedules" onSelect={() => onScheduleDrawerOpen?.()}>
                  <Clock className="h-3.5 w-3.5" />
                  {t('topbar.tooltips.schedules')}
                </DropdownMenuItem>
                {conversationName && onWorkflowOpen && (
                  <DropdownMenuItem onSelect={onWorkflowOpen}>
                    <Workflow className="h-3.5 w-3.5" />
                    {t('topbar.tooltips.workflow')}
                    {flowPanelOpen && <span className="ml-auto text-xs text-primary">●</span>}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => onCommandPaletteOpen?.()}>
                  <Keyboard className="h-3.5 w-3.5" />
                  {t('topbar.tooltips.commandPalette')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onSkillsManagerOpen?.()}>
                  <WandSparkles className="h-3.5 w-3.5" />
                  {t('topbar.tooltips.skillsManager')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {isSidePanelMode() && (
                  <DropdownMenuItem onSelect={() => window.open(window.location.href, '_blank', 'noopener')}>
                    <ExternalLink className="h-3.5 w-3.5" />
                    在新标签页打开
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="h-5 w-px bg-muted" />

            <ActionTooltip label={t('topbar.tooltips.appSettings')}>
              <BrandButton iconButton className="shrink-0" onClick={() => openSettings()}>
                <Settings className="h-[14px] w-[14px]" />
              </BrandButton>
            </ActionTooltip>
          </div>
        )}
      </header>

      {isMobile && mobileMoreOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 cursor-default bg-black/20"
          aria-label={t('common.close')}
          onClick={closeMobileMorePanel}
        />
      )}

      {isMobile && mobileMoreOpen && (
        <div
          ref={mobileMorePanelRef}
          role="region"
          aria-label={t('topbar.tooltips.more')}
          className="fixed right-2 top-14 z-50 w-[min(92vw,340px)] rounded-xl border border-neutral-200 bg-white p-2 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
        >
            {/* Quick actions grid — mirror the desktop tools menu */}
            <div className="grid grid-cols-2 gap-1.5">
              <BrandButton
                variant="ghost"
                className="h-9 justify-start gap-2 text-xs"
                onClick={() => {
                  onToolsPanelOpen?.()
                  closeMobileMorePanel()
                }}
              >
                <List className="h-3.5 w-3.5" />
                {t('topbar.tooltips.toolsPanel')}
              </BrandButton>
              <BrandButton
                variant="ghost"
                className="h-9 justify-start gap-2 text-xs"
                data-tour="schedules"
                onClick={() => {
                  onScheduleDrawerOpen?.()
                  closeMobileMorePanel()
                }}
              >
                <Clock className="h-3.5 w-3.5" />
                {t('topbar.tooltips.schedules')}
              </BrandButton>
              {conversationName && onWorkflowOpen && (
                <BrandButton
                  variant="ghost"
                  className="h-9 justify-start gap-2 text-xs"
                  onClick={() => {
                    onWorkflowOpen()
                    closeMobileMorePanel()
                  }}
                >
                  <Workflow className="h-3.5 w-3.5" />
                  {t('topbar.tooltips.workflow')}
                  {flowPanelOpen && <span className="ml-auto text-xs text-primary">●</span>}
                </BrandButton>
              )}
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
