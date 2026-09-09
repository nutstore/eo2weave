/**
 * SettingsDialog - LLM and workspace settings.
 * Using @creatorweave/ui brand components.
 *
 * Features:
 * - LLM Provider & API Key settings
 * - Model configuration (temperature, max tokens)
 */

import { useState, useEffect, useCallback, forwardRef } from 'react'
import {
  Settings,
  X,
  Download,
  Monitor,
  Bell,
  Lock,
  Trash2,
  Check,
  Copy,
  FlaskConical,
  Globe,
  Sun,
  Moon,
  Server,
  BookOpen,
  Puzzle,
  Search,
  FileText,
  CheckCircle2,
  XCircle,
  Terminal,
  LayoutDashboard,
  RotateCcw,
  AlertTriangle,
  Info,
  Keyboard,
  Database,
  ShieldCheck,
  Store,
} from 'lucide-react'
import { toast } from 'sonner'
import { useT, useLocale, LOCALE_LABELS } from '@/i18n'
import { ModelSettings } from './ModelSettings'
import { SecretManager } from './SecretManager'
import ExecPolicyPanel from './ExecPolicyPanel'
import ToolAuthPanel from './ToolAuthPanel'
import { MCPSettings } from '@/components/mcp/MCPSettings'
import { WebMCPSettings } from '@/components/webmcp/WebMCPSettings'
import {
  BrandDialog,
  BrandDialogClose,
  BrandDialogContent,
  BrandDialogHeader,
  BrandDialogTitle,
  BrandDialogBody,
} from '@creatorweave/ui'
import { BrandButton } from '@creatorweave/ui'
import { BrandSwitch } from '@creatorweave/ui'
import { useSettingsStore } from '@/store/settings.store'
import { useTheme, type ThemeMode } from '@/store/theme.store'
import { useExtensionStore } from '@/store/extension.store'
import { APP_BUILD_ID, APP_VERSION, EXTENSION_LATEST_VERSION } from '@/app-build'
import { CHROME_WEB_STORE_URL } from '@/lib/extension-distribution'
import { useWebContainerStore } from '@/store/webcontainer.store'
import { useWorkspacePreferencesStore } from '@/store/workspace-preferences.store'
import {
  BrandSlider,
} from '@creatorweave/ui'
import { KeyboardShortcutsHelp } from '@/components/workspace/KeyboardShortcutsHelp'
import { showTestNotification } from '@/services/test-notification'

// =============================================================================
// Types
// =============================================================================

type SettingsTab =
  | 'general'
  | 'workspace-layout'
  | 'workspace-editor'
  | 'workspace-shortcuts'
  | 'workspace-data'
  | 'llm'
  | 'secrets'
  | 'mcp'
  | 'webmcp'
  | 'extension'
  | 'exec-policy'
  | 'tool-auth'
  | 'experimental'
  | 'webcontainer'

interface SettingsDialogProps {
  open: boolean
  onOpenChange?: (open: boolean) => void
  /** Open the dialog with a specific tab pre-selected */
  initialTab?: SettingsTab
}

// =============================================================================
// Experimental Feature Toggle
// =============================================================================

interface ExperimentalToggleProps {
  title: string
  description: string
  checked: boolean
  onChange: (value: boolean) => void
}

function ExperimentalToggle({ title, description, checked, onChange }: ExperimentalToggleProps) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-secondary dark:text-foreground">{title}</p>
        <p className="mt-1 text-xs text-tertiary text-neutral-400 text-neutral-400 dark:text-neutral-400">{description}</p>
      </div>
      <BrandSwitch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

/** Batch spawn toggle — uses reactive zustand selector so the switch updates immediately */
function BatchSpawnToggle() {
  const t = useT()
  const enableBatchSpawn = useSettingsStore((s) => s.enableBatchSpawn)
  const setEnableBatchSpawn = useSettingsStore((s) => s.setEnableBatchSpawn)
  return (
    <ExperimentalToggle
      title={t('settings.batchSpawn')}
      description={t('settings.batchSpawnDesc')}
      checked={enableBatchSpawn}
      onChange={setEnableBatchSpawn}
    />
  )
}

// =============================================================================
// Version Info Section (within General tab)
// =============================================================================

/**
 * Displays the current app version and build identifier.
 *
 * - APP_VERSION: semantic version from package.json (e.g. "0.1.4")
 * - APP_BUILD_ID: git commit SHA in CI, or an identifier in local development
 *
 * Values are exposed through the Next-compatible app-build module.
 * Click anywhere on the card to copy full version info to clipboard.
 */
function VersionInfoSection() {
  const t = useT()
  const version = APP_VERSION
  const buildId = APP_BUILD_ID

  // Format the build ID for display:
  // - git SHA (40 hex) → short 7-char form
  // - ISO timestamp (dev mode) → readable date like "2026-08-13"
  const isSha = /^[0-9a-f]{40}$/i.test(buildId)
  const displayBuildId = isSha ? buildId.slice(0, 7) : buildId.slice(0, 10)

  const handleCopy = useCallback(() => {
    const fullInfo = `EO2Weave v${version} (${buildId})`
    navigator.clipboard.writeText(fullInfo).then(
      () => toast.success(t('settings.versionInfoCopied')),
      () => toast.error('Copy failed'),
    )
  }, [version, buildId, t])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Info className="h-4 w-4 text-tertiary" />
        <h3 className="text-sm font-medium text-secondary">{t('settings.versionInfoTitle')}</h3>
      </div>

      {/* Plain inline text — no box, matching neighboring sections.
          Click to copy full version info. */}
      <button
        type="button"
        onClick={handleCopy}
        title={t('settings.versionInfoCopy')}
        className="group flex items-baseline gap-2 text-left"
      >
        <span className="text-sm font-medium text-secondary dark:text-foreground">
          v{version}
        </span>
        <span className="text-xs text-tertiary">
          {displayBuildId}
        </span>
        <Copy className="ml-0.5 h-3 w-3 self-center text-muted opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    </div>
  )
}

// =============================================================================
// Notifications Section (within General tab)
// =============================================================================

/**
 * Settings panel for agent-loop notifications. Provides:
 *   - Master toggle (enabled)
 *   - "Only when away from the conversation" toggle (onlyWhenHidden)
 *   - Browser permission status display
 *   - "Send test notification" button
 */
function NotificationsSection() {
  const t = useT()
  const enabled = useSettingsStore((s) => s.agentLoopNotifications.enabled)
  const onlyWhenHidden = useSettingsStore((s) => s.agentLoopNotifications.onlyWhenHidden)
  const setEnabled = useSettingsStore((s) => s.setAgentLoopNotificationsEnabled)
  const setOnlyWhenHidden = useSettingsStore((s) => s.setAgentLoopNotificationsOnlyWhenHidden)

  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  )

  // Re-read permission when window regains focus (user may have changed it in browser settings)
  useEffect(() => {
    if (typeof Notification === 'undefined') return
    const update = () => setPermission(Notification.permission)
    update()
    window.addEventListener('focus', update)
    return () => window.removeEventListener('focus', update)
  }, [])

  const handleTestNotification = async () => {
    if (typeof Notification === 'undefined') {
      toast.error(t('settings.notifications.testUnsupported'))
      return
    }
    if (Notification.permission !== 'granted') {
      const result = await Notification.requestPermission()
      setPermission(result)
      if (result !== 'granted') {
        toast.error(t('settings.notifications.testDenied'))
        return
      }
    }
    try {
      // Test button should NOT go through notifyAgentComplete — that path
      // respects onlyWhenHidden and may skip while the user is viewing the
      // completed conversation. For the test button
      // we want a direct, unconditional notification so the user can
      // confirm the browser can actually display one.
      //
      await showTestNotification({
        title: t('settings.notifications.testTitle'),
        body: t('settings.notifications.testBody'),
      })
      toast.success(t('settings.notifications.testSent'))
    } catch (err) {
      console.warn('[Settings] test notification failed:', err)
      toast.error(t('settings.notifications.testFailed'))
    }
  }

  const permissionLabel =
    permission === 'granted'
      ? t('settings.notifications.permissionGranted')
      : permission === 'denied'
        ? t('settings.notifications.permissionDenied')
        : permission === 'default'
          ? t('settings.notifications.permissionDefault')
          : t('settings.notifications.permissionUnsupported')

  const permissionColor =
    permission === 'granted'
      ? 'text-green-600 dark:text-green-400'
      : permission === 'denied'
        ? 'text-red-600 dark:text-red-400'
        : 'text-amber-600 dark:text-amber-400'

  return (
    <div className="space-y-3">
      <ExperimentalToggle
        title={t('settings.notifications.enabled')}
        description={t('settings.notifications.enabledDesc')}
        checked={enabled}
        onChange={setEnabled}
      />

      <ExperimentalToggle
        title={t('settings.notifications.onlyWhenHidden')}
        description={t('settings.notifications.onlyWhenHiddenDesc')}
        checked={onlyWhenHidden}
        onChange={setOnlyWhenHidden}
      />

      <div className="flex items-start justify-between gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-secondary dark:text-foreground">
            {t('settings.notifications.permissionLabel')}
          </p>
          <p className="mt-1 text-xs text-tertiary text-neutral-400 text-neutral-400 dark:text-neutral-400">
            <span className={`font-medium ${permissionColor}`}>{permissionLabel}</span>
          </p>
        </div>
        <BrandButton
          variant="outline"
          className="h-8 gap-2 text-xs"
          onClick={handleTestNotification}
        >
          <Bell className="h-3.5 w-3.5" />
          {t('settings.notifications.testButton')}
        </BrandButton>
      </div>
    </div>
  )
}

// =============================================================================
// Extension Settings Panel
// =============================================================================

function ExtensionSettingsPanel() {
  const t = useT()
  const { checkStatus, openInstallGuide } = useExtensionStore()

  // Refresh status when this panel renders
  const currentStatus = checkStatus()
  const isInstalled = currentStatus === 'installed'
  const extensionVersion = useExtensionStore((s) => s.extensionVersion)
  const outdated = useExtensionStore((s) => s.outdated)
  const newerThanWeb = useExtensionStore((s) => s.newerThanWeb)
  const latestVersion = EXTENSION_LATEST_VERSION

  return (
    <div className="space-y-5 py-1">
      <p className="text-xs text-tertiary">{t('extension.settingsDescription')}</p>

      {/* Status */}
      <div className="flex items-center justify-between rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-800">
        <div className="flex items-center gap-3">
          <div className={`flex h-8 w-8 items-center justify-center rounded-full ${isInstalled ? 'bg-green-100 dark:bg-green-900/40' : 'bg-neutral-100 dark:bg-neutral-700'}`}>
            {isInstalled ? (
              <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
            ) : (
              <Puzzle className="h-4 w-4 text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500" />
            )}
          </div>
          <div>
            <p className="text-sm font-medium text-secondary dark:text-foreground">
              {isInstalled ? t('extension.settingsInstalled') : t('extension.settingsNotInstalled')}
            </p>
            {isInstalled && (
              <p className="text-xs text-green-600 dark:text-green-400">● Connected</p>
            )}
          </div>
        </div>
      </div>

      {/* Version Info */}
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-secondary dark:text-foreground">
          {t('extension.settingsVersionTitle')}
        </h4>
        <div className="space-y-1.5">
          {/* Latest available version */}
          <div className="flex items-center justify-between rounded-lg border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800">
            <span className="text-sm text-secondary text-neutral-300 text-neutral-300 dark:text-neutral-300">{t('extension.settingsLatestVersion')}</span>
            <span className="font-mono text-sm font-medium text-secondary dark:text-foreground">{latestVersion}</span>
          </div>
          {/* Currently installed version */}
          <div className={`flex items-center justify-between rounded-lg border px-3 py-2 ${
            isInstalled && outdated
              ? 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20'
              : 'border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-800'
          }`}>
            <span className="text-sm text-secondary text-neutral-300 text-neutral-300 dark:text-neutral-300">{t('extension.settingsCurrentVersion')}</span>
            <div className="flex items-center gap-2">
              {isInstalled && outdated && (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                  {t('extension.settingsUpdateAvailable')}
                </span>
              )}
              {isInstalled && newerThanWeb && (
                <span className="rounded bg-primary-100 px-1.5 py-0.5 text-[10px] font-medium text-primary-700 dark:bg-primary-100/30 dark:text-primary-300">
                  {t('extension.settingsNewerThanWeb')}
                </span>
              )}
              <span className={`font-mono text-sm font-medium ${
                isInstalled && outdated
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-secondary dark:text-foreground'
              }`}>
                {isInstalled && extensionVersion ? extensionVersion : '—'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Capabilities */}
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-secondary dark:text-foreground">
          {t('extension.settingsCapabilities')}
        </h4>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800">
            <Search className="h-4 w-4 text-blue-500" />
            <span className="text-sm text-secondary text-neutral-300 text-neutral-300 dark:text-neutral-300">{t('extension.featureSearch')}</span>
            {isInstalled ? (
              <CheckCircle2 className="ml-auto h-4 w-4 text-green-500" />
            ) : (
              <XCircle className="ml-auto h-4 w-4 text-neutral-300 text-neutral-600 text-neutral-600 dark:text-neutral-600" />
            )}
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800">
            <FileText className="h-4 w-4 text-blue-500" />
            <span className="text-sm text-secondary text-neutral-300 text-neutral-300 dark:text-neutral-300">{t('extension.featureFetch')}</span>
            {isInstalled ? (
              <CheckCircle2 className="ml-auto h-4 w-4 text-green-500" />
            ) : (
              <XCircle className="ml-auto h-4 w-4 text-neutral-300 text-neutral-600 text-neutral-600 dark:text-neutral-600" />
            )}
          </div>
        </div>
      </div>

      {/* Install from Chrome Web Store — one-click install + auto-updates.
          Always visible: the store serves every Chromium browser and users
          without store access can fall back to the zip button below. */}
      <BrandButton
        variant="primary"
        className="w-full"
        onClick={() => window.open(CHROME_WEB_STORE_URL, '_blank')}
      >
        <Store className="mr-2 h-4 w-4" />
        {t('extension.settingsStoreButton')}
      </BrandButton>

      {/* Download extension button — always visible */}
      <BrandButton
        variant="outline"
        className="w-full"
        onClick={() => window.open(`/chrome-extension.zip?v=${APP_BUILD_ID}`, '_blank')}
      >
        <Download className="mr-2 h-4 w-4" />
        {t('extension.downloadButton')}
      </BrandButton>

      {/* Install guide button — only when not installed */}
      {!isInstalled && (
        <BrandButton
          variant="secondary"
          className="w-full"
          onClick={() => openInstallGuide()}
        >
          <Puzzle className="mr-2 h-4 w-4" />
          {t('extension.settingsInstallButton')}
        </BrandButton>
      )}
    </div>
  )
}

// =============================================================================
// WebContainer Settings Panel
// =============================================================================

function WebContainerSettingsPanel() {
  const t = useT()
  const openPanel = useWebContainerStore((s) => s.openPanel)
  const status = useWebContainerStore((s) => s.status)

  return (
    <div className="space-y-4 py-1">
      <p className="text-xs text-tertiary">{t('topbar.tooltips.webContainer')}</p>

      <div className="flex items-center justify-between rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-800">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-700">
            <Terminal className="h-4 w-4 text-neutral-600 text-neutral-300 text-neutral-300 dark:text-neutral-300" />
          </div>
          <div>
            <p className="text-sm font-medium text-secondary dark:text-foreground">
              WebContainer
            </p>
            <p className="text-xs text-tertiary">
              Status: {status}
            </p>
          </div>
        </div>
      </div>

      <BrandButton
        variant="primary"
        className="w-full"
        onClick={openPanel}
      >
        <Terminal className="mr-2 h-4 w-4" />
        Open WebContainer Panel
      </BrandButton>
    </div>
  )
}

// =============================================================================
// Workspace Settings Panels (merged from WorkspaceSettingsDialog)
// =============================================================================

/** Layout panel — sidebar/conversation/preview panel size sliders */
function WorkspaceLayoutPanel() {
  const t = useT()
  const {
    panelSizes,
    resetPanelSizes,
    setSidebarWidth,
    setConversationRatio,
    setPreviewRatio,
  } = useWorkspacePreferencesStore()

  const handleResetLayout = () => {
    if (confirm(t('workspaceSettings.layout.resetLayoutConfirm'))) {
      resetPanelSizes()
    }
  }

  return (
    <div className="space-y-6 py-1">
      <div>
        <h3 className="text-lg font-semibold text-secondary dark:text-foreground">
          {t('workspaceSettings.layout.title')}
        </h3>
        <p className="mt-1 text-sm text-tertiary dark:text-muted">
          {t('workspaceSettings.layout.description')}
        </p>
      </div>

      <div className="space-y-6">
        <div>
          <label htmlFor="sidebar-width-slider" className="mb-2 block text-sm font-medium text-secondary dark:text-muted">
            {t('workspaceSettings.layout.sidebarWidth', { value: panelSizes.sidebarWidth })}
          </label>
          <BrandSlider
            id="sidebar-width-slider"
            min={200}
            max={400}
            step={1}
            value={[panelSizes.sidebarWidth]}
            onValueChange={(value) => setSidebarWidth(value[0])}
          />
        </div>

        <div>
          <label htmlFor="conversation-ratio-slider" className="mb-2 block text-sm font-medium text-secondary dark:text-muted">
            {t('workspaceSettings.layout.conversationArea', { value: panelSizes.conversationRatio })}
          </label>
          <BrandSlider
            id="conversation-ratio-slider"
            min={20}
            max={80}
            step={1}
            value={[panelSizes.conversationRatio]}
            onValueChange={(value) => setConversationRatio(value[0])}
          />
        </div>

        <div>
          <label htmlFor="preview-ratio-slider" className="mb-2 block text-sm font-medium text-secondary dark:text-muted">
            {t('workspaceSettings.layout.previewPanel', { value: panelSizes.previewRatio })}
          </label>
          <BrandSlider
            id="preview-ratio-slider"
            min={30}
            max={80}
            step={1}
            value={[panelSizes.previewRatio]}
            onValueChange={(value) => setPreviewRatio(value[0])}
          />
        </div>
      </div>

      <div className="flex gap-2 border-subtle border-t pt-4">
        <BrandButton variant="outline" onClick={handleResetLayout}>
          <RotateCcw className="mr-2 h-4 w-4" />
          {t('workspaceSettings.layout.resetLayout')}
        </BrandButton>
      </div>
    </div>
  )
}

/** Editor display panel — font size, line numbers, word wrap, minimap */
function WorkspaceEditorPanel() {
  const t = useT()
  const {
    display,
    setFontSize,
    setShowLineNumbers,
    setWordWrap,
    setShowMiniMap,
  } = useWorkspacePreferencesStore()

  return (
    <div className="space-y-6 py-1">
      <div>
        <h3 className="text-lg font-semibold text-secondary dark:text-foreground">
          {t('workspaceSettings.display.editorTitle')}
        </h3>
        <p className="mt-1 text-sm text-tertiary dark:text-muted">
          {t('workspaceSettings.display.editorDescription')}
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="mb-2 block text-sm font-medium text-secondary dark:text-muted">
            {t('workspaceSettings.display.fontSize')}
          </label>
          <div className="grid grid-cols-3 gap-2">
            {(['small', 'medium', 'large'] as const).map((size) => (
              <button
                type="button"
                key={size}
                onClick={() => setFontSize(size)}
                className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                  display.fontSize === size
                    ? 'border-primary-100 bg-primary-50 font-medium text-primary-700 dark:border-primary-700 dark:bg-primary-100/30 dark:text-primary-700'
                    : 'border-neutral-200 text-secondary hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800'
                }`}
              >
                {t(`workspaceSettings.display.font.${size}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <label htmlFor="show-line-numbers" className="cursor-pointer text-sm font-medium text-secondary dark:text-muted">
            {t('workspaceSettings.display.showLineNumbers')}
          </label>
          <BrandSwitch id="show-line-numbers" checked={display.showLineNumbers} onCheckedChange={setShowLineNumbers} />
        </div>

        <div className="flex items-center justify-between">
          <label htmlFor="word-wrap" className="cursor-pointer text-sm font-medium text-secondary dark:text-muted">
            {t('workspaceSettings.display.wordWrap')}
          </label>
          <BrandSwitch id="word-wrap" checked={display.wordWrap} onCheckedChange={setWordWrap} />
        </div>

        <div className="flex items-center justify-between">
          <label htmlFor="show-minimap" className="cursor-pointer text-sm font-medium text-secondary dark:text-muted">
            {t('workspaceSettings.display.showMiniMap')}
          </label>
          <BrandSwitch id="show-minimap" checked={display.showMiniMap} onCheckedChange={setShowMiniMap} />
        </div>
      </div>
    </div>
  )
}

/** Keyboard shortcuts panel — launch the shortcuts help dialog */
function WorkspaceShortcutsPanel({ onShowHelp }: { onShowHelp: () => void }) {
  const t = useT()
  return (
    <div className="space-y-6 py-1">
      <div>
        <h3 className="text-lg font-semibold text-secondary dark:text-foreground">
          {t('workspaceSettings.shortcuts.title')}
        </h3>
        <p className="mt-1 text-sm text-tertiary dark:text-muted">
          {t('workspaceSettings.shortcuts.description')}
        </p>
      </div>

      <div className="space-y-2">
        <div className="border-subtle flex items-center justify-between rounded-md border px-4 py-3">
          <div>
            <div className="text-sm font-medium text-secondary dark:text-foreground">
              {t('workspaceSettings.shortcuts.showAllTitle')}
            </div>
            <div className="text-xs text-tertiary dark:text-muted">
              {t('workspaceSettings.shortcuts.showAllDescription')}
            </div>
          </div>
          <BrandButton variant="outline" onClick={onShowHelp}>
            <Keyboard className="mr-2 h-4 w-4" />
            {t('workspaceSettings.shortcuts.view')}
          </BrandButton>
        </div>
      </div>

      <div className="border-subtle flex items-start gap-3 rounded-md border bg-muted p-4 dark:bg-muted">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-primary-500 dark:text-primary-500" />
        <p className="text-sm text-secondary dark:text-muted">
          <strong>{t('workspaceSettings.shortcuts.tipLabel')}</strong>{' '}
          <kbd className="border-subtle rounded border bg-card px-1.5 py-0.5 font-mono text-xs dark:bg-card">
            {t('workspaceSettings.shortcuts.tipCommand')}
          </kbd>{' '}
          {t('workspaceSettings.shortcuts.tipSuffix')}
        </p>
      </div>
    </div>
  )
}

/** Data management panel — recent files, reset */
function WorkspaceDataPanel() {
  const t = useT()
  const { resetToDefaults, clearRecentFiles, recentFiles } = useWorkspacePreferencesStore()

  const handleResetAll = () => {
    if (confirm(t('workspaceSettings.data.resetAllConfirm'))) {
      resetToDefaults()
    }
  }

  const handleClearRecentFiles = () => {
    if (confirm(t('workspaceSettings.data.clearRecentConfirm'))) {
      clearRecentFiles()
    }
  }

  return (
    <div className="space-y-6 py-1">
      <div>
        <h3 className="text-lg font-semibold text-secondary dark:text-foreground">
          {t('workspaceSettings.data.title')}
        </h3>
        <p className="mt-1 text-sm text-tertiary dark:text-muted">
          {t('workspaceSettings.data.description')}
        </p>
      </div>

      <div className="space-y-4">
        <div className="border-subtle flex items-center justify-between rounded-md border px-4 py-3">
          <div>
            <div className="text-sm font-medium text-secondary dark:text-foreground">
              {t('workspaceSettings.data.recentFilesTitle')}
            </div>
            <div className="text-xs text-tertiary dark:text-muted">
              {t('workspaceSettings.data.recentFilesCount', { count: recentFiles.length })}
            </div>
          </div>
          <BrandButton variant="outline" onClick={handleClearRecentFiles} disabled={recentFiles.length === 0}>
            <Trash2 className="mr-2 h-4 w-4" />
            {t('workspaceSettings.data.clear')}
          </BrandButton>
        </div>

        <div className="flex items-start gap-3 rounded-md border border-warning bg-warning-50 p-4 dark:border-warning dark:bg-warning-bg">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning dark:text-warning-200" />
          <div>
            <p className="text-sm font-medium text-warning dark:text-warning-200">
              {t('workspaceSettings.data.warningTitle')}
            </p>
            <p className="mt-1 text-xs text-warning dark:text-warning-200">
              {t('workspaceSettings.data.warningDescription')}
            </p>
          </div>
        </div>

        <div className="border-subtle border-t pt-4">
          <h4 className="mb-2 text-sm font-medium text-secondary dark:text-foreground">
            {t('workspaceSettings.data.resetAllTitle')}
          </h4>
          <p className="mb-3 text-xs text-tertiary dark:text-muted">
            {t('workspaceSettings.data.resetAllDescription')}
          </p>
          <BrandButton variant="outline" onClick={handleResetAll}>
            <RotateCcw className="mr-2 h-4 w-4" />
            {t('workspaceSettings.data.resetAll')}
          </BrandButton>
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// Settings Dialog Content
// =============================================================================

const SettingsDialogContent = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BrandDialogContent> & { open?: boolean; initialTab?: SettingsTab }
>(({ className: _className, open, initialTab, ...props }, ref) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'general')
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false)
  const t = useT()
  const [locale, setLocale] = useLocale()
  const { mode: themeMode, setTheme } = useTheme()

  // Jump to initialTab when the dialog opens
  useEffect(() => {
    if (open && initialTab) {
      setActiveTab(initialTab)
    }
  }, [open, initialTab])

  useEffect(() => {
    if (!open) {
      setActiveTab('general')
    }
  }, [open])

  const docsUrl = locale === 'zh-CN' ? '/docs/zh' : '/docs/en'

  const themeOptions: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
    { value: 'light', label: t('settings.themeLight'), icon: <Sun className="h-4 w-4" /> },
    { value: 'dark', label: t('settings.themeDark'), icon: <Moon className="h-4 w-4" /> },
    { value: 'system', label: t('settings.themeSystem'), icon: <Monitor className="h-4 w-4" /> },
  ]

  const tabGroups: { id: string; label: string; tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] }[] = [
    {
      id: 'basics',
      label: t('settings.tabGroups.basics'),
      tabs: [
        { id: 'general', label: t('settings.general'), icon: <Globe className="h-4 w-4" /> },
      ],
    },
    {
      id: 'workspace',
      label: t('settings.tabGroups.workspace'),
      tabs: [
        { id: 'workspace-layout', label: t('workspaceSettings.tabs.layout'), icon: <LayoutDashboard className="h-4 w-4" /> },
        { id: 'workspace-editor', label: t('workspaceSettings.tabs.display'), icon: <Settings className="h-4 w-4" /> },
        { id: 'workspace-shortcuts', label: t('workspaceSettings.tabs.shortcuts'), icon: <Keyboard className="h-4 w-4" /> },
        { id: 'workspace-data', label: t('workspaceSettings.tabs.data'), icon: <Database className="h-4 w-4" /> },
      ],
    },
    {
      id: 'aiAndTools',
      label: t('settings.tabGroups.aiAndTools'),
      tabs: [
        { id: 'llm', label: t('settings.llmProvider'), icon: <Settings className="h-4 w-4" /> },
        { id: 'secrets', label: t('settings.secrets.tab'), icon: <Lock className="h-4 w-4" /> },
        { id: 'mcp', label: t('settings.mcp'), icon: <Server className="h-4 w-4" /> },
        { id: 'webmcp', label: t('settings.webMCP'), icon: <Globe className="h-4 w-4" /> },
        { id: 'exec-policy', label: t('execPolicy.tab'), icon: <Terminal className="h-4 w-4" /> },
        { id: 'tool-auth', label: t('agent.toolAuth.settingsTab'), icon: <ShieldCheck className="h-4 w-4" /> },
      ],
    },
    {
      id: 'extensions',
      label: t('settings.tabGroups.extensions'),
      tabs: [
        { id: 'extension', label: t('extension.settingsTab'), icon: <Puzzle className="h-4 w-4" /> },
      ],
    },
    {
      id: 'experimental',
      label: t('settings.tabGroups.experimental'),
      tabs: [
        { id: 'experimental', label: t('settings.experimental'), icon: <FlaskConical className="h-4 w-4" /> },
      ],
    },
  ]

  return (
    <BrandDialogContent
      ref={ref}
      className="flex h-[min(88vh,760px)] w-[min(94vw,760px)] max-w-none flex-col overflow-hidden p-0"
      showOverlay={true}
      {...props}
    >
      <BrandDialogHeader>
        <div className="flex items-center gap-2.5">
          <Settings className="h-[18px] w-[18px] text-primary-600" />
          <BrandDialogTitle>{t('settings.title')}</BrandDialogTitle>
        </div>
        <BrandDialogClose asChild>
          <button
            type="button"
            aria-label={t('common.close')}
            className="text-tertiary transition-colors hover:text-primary"
          >
            <X className="h-5 w-5" />
          </button>
        </BrandDialogClose>
      </BrandDialogHeader>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Sidebar tabs — w-52 (was w-44) so the longest tab label
            ("Browser Extension" / "浏览器扩展" + icon) fits on one line;
            nowrap guards against wrapping on narrower fallbacks. */}
        <div className="border-subtle custom-scrollbar shrink-0 border-b p-2 md:max-h-full md:w-52 md:min-h-0 md:overflow-y-auto md:border-b-0 md:border-r md:p-2">
          <nav role="tablist" aria-label="Settings tabs" aria-orientation="vertical" className="flex gap-3 overflow-x-auto md:block md:space-y-3">
            {tabGroups.map((group) => (
              <div key={group.id} className="flex shrink-0 flex-col gap-1 md:gap-1">
                <h3 className="hidden px-3 text-[10px] font-semibold uppercase tracking-wider text-tertiary md:block">
                  {group.label}
                </h3>
                <div className="flex gap-1 md:block md:space-y-1">
                  {group.tabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      id={`settings-tab-${tab.id}`}
                      aria-selected={activeTab === tab.id}
                      aria-controls={`settings-tabpanel-${tab.id}`}
                      tabIndex={activeTab === tab.id ? 0 : -1}
                      onClick={() => setActiveTab(tab.id)}
                      className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors md:w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
                        activeTab === tab.id
                          ? 'dark:bg-primary-100/30 dark:text-primary-700 bg-primary-50 text-primary-700'
                          : 'text-secondary hover:bg-muted dark:text-tertiary dark:hover:bg-muted'
                      }`}
                    >
                      {tab.icon}
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        </div>

        {/* Tab content */}
        <div
          role="tabpanel"
          id={`settings-tabpanel-${activeTab}`}
          aria-labelledby={`settings-tab-${activeTab}`}
          tabIndex={0}
          className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4"
        >
          {/* Workspace Layout Tab (merged from WorkspaceSettingsDialog) */}
          {activeTab === 'workspace-layout' && <WorkspaceLayoutPanel />}

          {/* Workspace Editor/Display Tab */}
          {activeTab === 'workspace-editor' && <WorkspaceEditorPanel />}

          {/* Workspace Keyboard Shortcuts Tab */}
          {activeTab === 'workspace-shortcuts' && (
            <WorkspaceShortcutsPanel onShowHelp={() => setShowShortcutsHelp(true)} />
          )}

          {/* Workspace Data Management Tab */}
          {activeTab === 'workspace-data' && <WorkspaceDataPanel />}

          {/* General Settings Tab */}
          {activeTab === 'general' && (
            <div className="space-y-5 py-1">
              <p className="text-xs text-tertiary">{t('settings.generalDescription')}</p>

              {/* Language Section */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-tertiary" />
                  <h3 className="text-sm font-medium text-secondary">{t('settings.language')}</h3>
                </div>
                <p className="text-xs text-tertiary">{t('settings.languageDescription')}</p>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(LOCALE_LABELS).map(([code, label]) => (
                    <button
                      key={code}
                      type="button"
                      onClick={() => setLocale(code as typeof locale)}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                        locale === code
                          ? 'border-primary-100 bg-primary-50 font-medium text-primary-700 dark:border-primary-700 dark:bg-primary-100/30 dark:text-primary-700'
                          : 'border-neutral-200 text-secondary hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800'
                      }`}
                    >
                      {locale === code && <Check className="h-3.5 w-3.5" />}
                      <span className={locale !== code ? 'ml-[22px]' : ''}>{label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Theme Section */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Sun className="h-4 w-4 text-tertiary" />
                  <h3 className="text-sm font-medium text-secondary">{t('settings.theme')}</h3>
                </div>
                <p className="text-xs text-tertiary">{t('settings.themeDescription')}</p>
                <div className="grid grid-cols-3 gap-2">
                  {themeOptions.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setTheme(opt.value)}
                      className={`flex flex-col items-center gap-1.5 rounded-lg border px-3 py-3 text-sm transition-colors ${
                        themeMode === opt.value
                          ? 'border-primary-100 bg-primary-50 font-medium text-primary-700 dark:border-primary-700 dark:bg-primary-100/30 dark:text-primary-700'
                          : 'border-neutral-200 text-secondary hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800'
                      }`}
                    >
                      {opt.icon}
                      <span className="text-xs">{opt.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Documentation Link */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <BookOpen className="h-4 w-4 text-tertiary" />
                  <h3 className="text-sm font-medium text-secondary">{t('settings.docs')}</h3>
                </div>
                <p className="text-xs text-tertiary">{t('settings.docsDescription')}</p>
                <BrandButton
                  variant="outline"
                  className="h-8 gap-2 text-xs"
                  onClick={() => window.open(docsUrl, '_blank')}
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  {t('settings.docs')}
                </BrandButton>
              </div>

              {/* Notifications Section */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Bell className="h-4 w-4 text-tertiary" />
                  <h3 className="text-sm font-medium text-secondary">{t('settings.notifications.title')}</h3>
                </div>
                <p className="text-xs text-tertiary">{t('settings.notifications.description')}</p>
                <NotificationsSection />
              </div>

              {/* Version Info Section */}
              <VersionInfoSection />
            </div>
          )}

          {/* LLM Settings Tab */}
          {activeTab === 'llm' && (
            <BrandDialogBody className="p-0">
              <ModelSettings open={open} />
            </BrandDialogBody>
          )}

          {/* Secret Manager Tab */}
          {activeTab === 'secrets' && <SecretManager />}

          {/* MCP Settings Tab */}
          {activeTab === 'mcp' && (
            <div className="py-1">
              <MCPSettings />
            </div>
          )}

          {/* WebMCP Settings Tab */}
          {activeTab === 'webmcp' && (
            <div className="py-1">
              <WebMCPSettings />
            </div>
          )}

          {/* Extension Tab */}
          {activeTab === 'extension' && (
            <ExtensionSettingsPanel />
          )}

          {/* Exec Policy Tab */}
          {activeTab === 'exec-policy' && (
            <ExecPolicyPanel />
          )}
          {activeTab === 'tool-auth' && (
            <ToolAuthPanel />
          )}

          {/* Experimental Features Tab */}
          {activeTab === 'experimental' && (
            <div className="space-y-4 py-1">
              {/* Warning banner */}
              <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/20">
                <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="text-sm text-amber-800 dark:text-amber-200">
                  <p className="font-medium">{t('settings.experimentalWarning')}</p>
                  <p className="mt-1 text-xs">
                    {t('settings.experimentalWarningDesc')}
                  </p>
                </div>
              </div>

              {/* batch_spawn toggle */}
              <BatchSpawnToggle />

            </div>
          )}

          {/* WebContainer Tab */}
          {activeTab === 'webcontainer' && (
            <WebContainerSettingsPanel />
          )}
        </div>
      </div>

      {/* Keyboard shortcuts help (launched from workspace-shortcuts tab) */}
      <KeyboardShortcutsHelp open={showShortcutsHelp} onOpenChange={setShowShortcutsHelp} />
    </BrandDialogContent>
  )
})
SettingsDialogContent.displayName = 'SettingsDialogContent'

const SettingsDialog = forwardRef<
  React.ElementRef<typeof BrandDialog>,
  React.ComponentPropsWithoutRef<typeof BrandDialog> & SettingsDialogProps
>(({ open, onOpenChange, ...props }, ref) => {
  return (
    <BrandDialog open={open} onOpenChange={onOpenChange} modal={true}>
      <SettingsDialogContent ref={ref as React.Ref<HTMLDivElement>} open={open} {...props} />
    </BrandDialog>
  )
})
SettingsDialog.displayName = 'SettingsDialog'

export { SettingsDialog, SettingsDialogContent }
export type { SettingsTab }
