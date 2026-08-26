// Project Home
export const projectHome = {
    // Hero section
    hero: {
      badge: "Local First",
      title: "Start Creating Here",
      description:
        "Chat with your files in natural language in your local AI workspace.",
      descriptionSuffix: "Your data stays on your device.",
      projectCount: "{count} projects",
      workspaceCount: "{count} conversations",
      docsHub: "Docs Hub",
      userDocs: "User Docs",
      developerDocs: "Developer Docs",
    },
    // Sidebar cards
    sidebar: {
      continueWork: "Continue",
      createNew: "New",
      createNewDescription:
        "Create a new project to start your creative journey.",
      shortcutHint: "Shortcut: N",
      createProject: "Create Project",
      startFresh: "Start Fresh",
      startFreshDescription:
        "Having issues? Start from scratch. This deletes all projects and conversations.",
      resetApp: "Reset App",
      resetting: "Resetting...",
      helpDocs: "Docs",
      helpDocsDescription:
        "Browse user and developer documentation for guides and technical references.",
      openDocs: "Open Docs Hub",
      appearance: "Appearance",
      advanced: "Advanced",
      advancedHint: "Reset, backup, cache clearing, etc.",
      cache: "Cache",
      cacheDescription:
        "Clear browser cache to refresh response headers and static resources.",
      clearCache: "Clear Cache",
      clearing: "Clearing...",
      backup: "Data Backup",
      backupDescription:
        "Export the entire OPFS (SQLite database + workspace files) — for backups or migration to a new device.",
      exportBackup: "Export",
      backingUp: "Backing up…",
      importBackup: "Import",
      restoringBackup: "Restoring…",
      diagnostics: "Diagnostics",
      diagnosticsDescription:
        "Collect runtime environment and storage state. Copy the report to share with the developer when something goes wrong.",
      runDiagnostics: "Run Diagnostics",
    },
    // Theme settings
    theme: {
      modeTitle: "Theme Mode",
      light: "Light",
      dark: "Dark",
      system: "System",
      accentColorTitle: "Accent Color",
      languageTitle: "Language",
    },
    // Accent color names
    accentColors: {
      teal: "Teal",
      rose: "Rose",
      amber: "Amber",
      violet: "Violet",
      emerald: "Emerald",
      slate: "Slate",
    },
    activity: {
      title: "Activity",
      less: "Less",
      more: "More",
      count: "activities",
      docsLabel: "docs",
      chatsLabel: "chats",
      activeDaysLabel: "active days",
      clickToView: "Click to view details",
      noActivity: "No activity this day",
      dayWork: "Work on {date}",
      moreItems: "more…",
      emptyHint: "No activity yet — create your first project to get started",
      loadFailed: "Couldn't load activity data",
      retry: "Retry",
      range: {
        label: "Range",
        "1m": "Last month",
        "3m": "Last 3 months",
        "6m": "Last 6 months",
        "1y": "Last year",
      },
    },
    // Project timeline
    timeline: {
      today: "Today",
      yesterday: "Yesterday",
      thisWeek: "This Week",
      thisMonth: "This Month",
      older: "Older",
    },
    // Search and filters
    filters: {
      searchPlaceholder: "Search projects...",
      all: "All",
      active: "Active",
      archived: "Archived",
    },
    // Project item
    project: {
      archived: "Archived",
      workspaceCount: "{count} conversations",
      open: "Open",
      openProject: "Open project \"{name}\"",
      rename: "Rename",
      exportUsage: "Export model & usage",
      exportingUsage: "Exporting…",
      moreActions: "More actions",
      archive: "Archive",
      unarchive: "Unarchive",
      delete: "Delete",
    },
    // Dialogs
    dialogs: {
      createProject: "Create New Project",
      createProjectDescription:
        "Give your new project a name to organize and distinguish different workspaces.",
      projectNamePlaceholder: "Enter project name",
      createButton: "Create Project",
      creating: "Creating...",
      renameProject: "Rename Project",
      renamePlaceholder: "Enter new project name",
      archiveProject: "Archive Project",
      archiveConfirm:
        'Archive project "{name}"? Archived projects won\'t be shown by default, but can be unarchived anytime.',
      dontAskAgain: "Don't ask again",
      deleteProject: "Delete Project",
      deleteConfirm:
        'Delete project "{name}"? This will delete associated workspace records and cannot be undone.',
      deleteConfirmHint: "Type project name to confirm:",
      startFreshTitle: "Start Fresh",
      startFreshDescription:
        "This will delete everything you've created in this app:",
      startFreshItems: {
        projects: "All projects and workspaces",
        conversations: "All conversation history",
        files: "All uploaded files",
      },
      startFreshNote: "Like opening the app for the first time.",
      startFreshConfirmHint: 'Type "Start Fresh" to confirm:',
      startFreshConfirmPlaceholder: "Start Fresh",
      clearCacheUnavailable: "Service Worker is not active yet. Refresh the page and try again.",
      diagnosticsInProgress: "Running…",
      confirmReset: "Confirm Reset",
      retry: "Retry",
      resetting: "Resetting...",
      importBackupTitle: "Import Backup",
      importBackupWarning:
        "Importing will wipe ALL current data (projects, conversations, files) and replace it with the backup. Exporting a fresh backup first is strongly recommended.",
      importBackupSecurityNote:
        "Backup files contain the encryption key and app settings (including login credentials) that can fully restore API keys and other data — store them safely and never share them.",
      importBackupFile: "Backup file: {name}",
      importBackupHint: "Restores projects, conversations, files, API keys, and app settings (theme, language, model config, …). The page will reload automatically once the restore completes.",
      importBackupConfirm: "Overwrite & Restore",
      exportBackupTitle: "Export Backup",
      exportBackupSensitive:
        "The backup file contains the encryption key, API keys, and app settings (including login credentials) — equivalent to full account access. Store it safely.",
      exportBackupHint: "Includes: SQLite database, workspace files, API keys, and app settings.",
      exportBackupConfirm: "Export Backup",
      diagnosticsTitle: "Diagnostic Report",
      diagnosticsRunning: "Collecting diagnostic information...",
      diagnosticsHint: "Click \"Copy Report\" below and paste it to the developer.",
      diagnosticsFailed:
        "Diagnostics failed. Please open the browser console to collect information manually.",
      copyReport: "Copy Report",
      copied: "Copied",
    },
    // Empty state
    empty: {
      noProjects: "No projects yet",
      noResults: "No matching projects found",
      createFirst: "Create First Project",
    },
    defaultProjectName: "My Project",
} as const

// Site footer (compliance bar on public pages)
export const siteFooter = {
  privacy: "Privacy Policy",
} as const
