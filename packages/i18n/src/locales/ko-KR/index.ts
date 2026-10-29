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
import { fileViewer, standalonePreview, filePreview, officePreview } from './fileViewer'
import { storageStatusBanner, pendingSync } from './storage'
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
import { agentProfile } from './agentProfile'
import { sidebar } from './sidebar'
import { goToFile } from './goToFile'
import { keyboardShortcuts } from './keyboardShortcuts'
import { assets } from './assets'
import { processes } from './processes'
import { sidePanelRecipe } from './sidePanelRecipe'
import { sidePanelPackage } from './sidePanelPackage'
import { execPolicy } from './execPolicy'
import { tools } from './tools'
import { schedule } from './schedule'
import { extension } from './extension'

export const koKR = {
  common,
  app,
  topbar,
  folderSelector,
  folderPick,
  projectRoots,
  settings,
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
  toolCallDisplay,
  mobile,
  offlineQueue,
  activityHeatmap,
  errorBoundary,
  pluginDialog,
  htmlPreview,
  filePreview,
    officePreview,
  commandPalette,
  mcp,
  onboarding,
  workspace,
  projectHome,
  siteFooter,
  fileTree,
  agent,
  agentProfile,
  sidebar,
  goToFile,
  keyboardShortcuts,
  workflow,
  questionCard,
  runChanges,
  assets,
  processes,
  sidePanelRecipe,
  sidePanelPackage,
  execPolicy,
  extension,
  tools,
  schedule,
} as const
