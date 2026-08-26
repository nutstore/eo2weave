// 首页
export const projectHome = {
    // Hero 区域
    hero: {
      badge: "本地优先",
      title: "创作从这里开始",
      description: "在本地 AI 创作工坊中，用自然语言与你的文件对话。",
      descriptionSuffix: "数据始终在你的设备上。",
      projectCount: "{count} 项目",
      workspaceCount: "{count} 对话",
      docsHub: "文档中心",
      userDocs: "用户文档",
      developerDocs: "开发者文档",
    },
    // 侧边栏卡片
    sidebar: {
      continueWork: "继续工作",
      createNew: "新建",
      createNewDescription: "创建一个新项目，开始你的创作之旅。",
      shortcutHint: "快捷键: N",
      createProject: "创建项目",
      startFresh: "重新开始",
      startFreshDescription:
        "遇到问题？可以从头开始。这会删除所有项目和对话记录。",
      resetApp: "重置应用",
      resetting: "重置中...",
      helpDocs: "帮助文档",
      helpDocsDescription: "查看用户与开发者文档，快速找到使用说明和技术资料。",
      openDocs: "打开文档中心",
      appearance: "外观",
      advanced: "高级",
      advancedHint: "重置、备份、缓存清理等",
      cache: "缓存",
      cacheDescription: "清除浏览器缓存以刷新响应头和静态资源。",
      clearCache: "清除缓存",
      clearing: "清除中...",
      backup: "数据备份",
      backupDescription:
        "导出完整的 OPFS 数据（SQLite 数据库 + 工作区文件），可用于备份或迁移到新设备。",
      exportBackup: "导出",
      backingUp: "正在备份…",
      importBackup: "导入",
      restoringBackup: "正在恢复…",
      diagnostics: "诊断",
      diagnosticsDescription:
        "收集运行环境和存储状态信息，遇到问题时可一键复制反馈给开发者。",
      runDiagnostics: "运行诊断",
    },
    // 主题设置
    theme: {
      modeTitle: "主题模式",
      light: "浅色",
      dark: "深色",
      system: "跟随系统",
      accentColorTitle: "主题色",
      languageTitle: "语言",
    },
    // 主题色名称
    accentColors: {
      teal: "青色",
      rose: "玫瑰",
      amber: "琥珀",
      violet: "紫罗兰",
      emerald: "翡翠",
      slate: "石墨",
    },
    activity: {
      title: "活跃度",
      less: "少",
      more: "多",
      count: "次活动",
      docsLabel: "个文档",
      chatsLabel: "次对话",
      activeDaysLabel: "个活跃天",
      clickToView: "点击查看详情",
      noActivity: "这天没有工作记录",
      dayWork: "{date} 的工作",
      moreItems: "项…",
      emptyHint: "还没有工作记录，开始创建你的第一个项目吧",
      loadFailed: "加载活跃度失败",
      retry: "重试",
      range: {
        label: "时间范围",
        "1m": "最近1个月",
        "3m": "最近3个月",
        "6m": "最近6个月",
        "1y": "最近一年",
      },
    },
    // 项目时间线
    timeline: {
      today: "今天",
      yesterday: "昨天",
      thisWeek: "本周",
      thisMonth: "本月",
      older: "更早",
    },
    // 搜索和过滤
    filters: {
      searchPlaceholder: "搜索项目...",
      all: "全部",
      active: "活跃",
      archived: "已归档",
    },
    // 项目项
    project: {
      archived: "已归档",
      workspaceCount: "{count} 对话",
      open: "打开",
      openProject: "打开项目「{name}」",
      rename: "重命名",
      exportUsage: "导出模型与用量",
      exportingUsage: "正在导出…",
      moreActions: "更多操作",
      archive: "归档",
      unarchive: "取消归档",
      delete: "删除",
    },
    // 对话框
    dialogs: {
      createProject: "创建新项目",
      createProjectDescription:
        "为你的新项目起一个名字，用于组织和区分不同的工作区。",
      projectNamePlaceholder: "输入项目名称",
      createButton: "创建项目",
      creating: "创建中...",
      renameProject: "重命名项目",
      renamePlaceholder: "输入新的项目名称",
      archiveProject: "归档项目",
      archiveConfirm:
        "确认归档项目「{name}」？归档后项目不会默认展示，但可随时取消归档。",
      dontAskAgain: "下次不再提示",
      deleteProject: "删除项目",
      deleteConfirm:
        "确认删除项目「{name}」？该操作会删除项目关联的工作区记录，且不可撤销。",
      deleteConfirmHint: "请输入项目名称以确认删除：",
      startFreshTitle: "重新开始",
      startFreshDescription: "这会删除你在这个应用中创建的所有内容：",
      startFreshItems: {
        projects: "所有项目和工作区",
        conversations: "所有对话记录",
        files: "所有上传的文件",
      },
      startFreshNote: "就像第一次打开这个应用一样。",
      startFreshConfirmHint: "输入 重新开始 确认：",
      startFreshConfirmPlaceholder: "重新开始",
      clearCacheUnavailable: "Service Worker 未激活，请刷新页面后重试。",
      diagnosticsInProgress: "运行中…",
      confirmReset: "确认重置",
      retry: "重试",
      resetting: "重置中...",
      importBackupTitle: "导入备份",
      importBackupWarning:
        "导入会清空当前全部数据（项目、对话、文件），并用备份内容完全替换。建议先导出一份当前备份再继续。",
      importBackupSecurityNote:
        "备份文件包含加密密钥和应用设置（含登录凭据），可完整恢复 API 密钥等数据，请妥善保管，不要分享给他人。",
      importBackupFile: "备份文件：{name}",
      importBackupHint: "恢复项目、对话、文件、API 密钥和应用设置（含主题、语言、模型配置等）。完成后页面会自动刷新。",
      importBackupConfirm: "覆盖并恢复",
      exportBackupTitle: "导出备份",
      exportBackupSensitive:
        "备份文件包含加密密钥、API 密钥和应用设置（含登录凭据），等同于完整的账户访问权限，请妥善保管。",
      exportBackupHint: "备份内容包括：SQLite 数据库、工作区文件、API 密钥、应用设置。",
      exportBackupConfirm: "导出备份",
      diagnosticsTitle: "诊断报告",
      diagnosticsRunning: "正在收集诊断信息...",
      diagnosticsHint: "点击下方「复制报告」按钮，然后粘贴给开发者即可。",
      diagnosticsFailed: "诊断失败，请打开浏览器控制台手动收集信息。",
      copyReport: "复制报告",
      copied: "已复制",
    },
    // 空状态
    empty: {
      noProjects: "还没有项目",
      noResults: "没有找到匹配的项目",
      createFirst: "创建第一个项目",
    },
    defaultProjectName: "我的项目",
} as const

// Site footer (compliance bar on public pages)
export const siteFooter = {
  privacy: "隐私政策",
} as const
