import { common } from './common'
import { app } from './app'
import { topbar } from './topbar'
import { folderSelector } from './folderSelector'
import { folderPick } from './folderPick'
import { settings } from './settings'
import { projectRoots } from './projectRoots'
import { workspaceSettings } from './workspaceSettings'
import { welcome } from './welcome'
import { skills, discover, skillCard, skillEditor, skillUpload, skillDetail, skillFileEditor } from './skills'
import { webContainer } from './webContainer'
import { workflowEditor, customWorkflowManager, workflowEditorDialog, workflow } from './workflow'
import { conversation, toolCallDisplay, questionCard, runChanges, session } from './conversation'
import { fileViewer, standalonePreview, filePreview, recentFiles, officePreview } from './fileViewer'
import { storageStatusBanner, pendingSync, conversationStorage, workspaceStorage } from './storage'
import { themeToggle } from './themeToggle'
import { mobile, offlineQueue } from './mobile'
import { activityHeatmap } from './activityHeatmap'
import { errorBoundary } from './errorBoundary'
import { pluginDialog } from './pluginDialog'
import { htmlPreview } from './htmlPreview'
import { commandPalette } from './commandPalette'
import { mcp } from './mcp'
import { onboarding } from './onboarding'
import { workspace } from './workspace'
import { projectHome, siteFooter } from './projectHome'
import { fileTree } from './fileTree'
import { agent } from './agent'
import { sidebar } from './sidebar'
import { goToFile } from './goToFile'
import { keyboardShortcuts } from './keyboardShortcuts'
import { extension } from './extension'
import { sidePanelRecipe } from './sidePanelRecipe'
import { execPolicy } from './execPolicy'
import { assets } from './assets'
import { processes } from './processes'
import { tools } from './tools'
export const zhCN = {
  common,
  app,
  topbar,
  folderSelector,
  folderPick,
  settings,
  projectRoots,
  workspaceSettings,
  welcome,
  skills: { ...skills, discover },
  discover,
  skillCard,
  skillEditor,
  skillUpload,
  skillDetail,
  skillFileEditor,
  webContainer,
  workflowEditor,
  customWorkflowManager,
  workflowEditorDialog,
  session,
  fileViewer,
  standalonePreview,
  storageStatusBanner,
  pendingSync,
  themeToggle,
  conversation,
  conversationStorage,
  workspaceStorage,
  toolCallDisplay,
  mobile,
  offlineQueue,
  activityHeatmap,
  errorBoundary,
  pluginDialog,
  htmlPreview,
  filePreview,
  recentFiles,
  officePreview,
  commandPalette,
  mcp,
  onboarding,
  workspace,
  projectHome,
  siteFooter,
  fileTree,
  agent,
  sidebar,
  goToFile,
  keyboardShortcuts,
  workflow,
  questionCard,
  runChanges,
  extension,
  sidePanelRecipe,
  execPolicy,
  assets,
  processes,
  tools,
} as const
