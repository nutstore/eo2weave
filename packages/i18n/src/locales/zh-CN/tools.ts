// Tools Panel 组件
export const tools = {
  // ToolsPanel
  availableTools: '可用工具',
  toolCount: '{count} 个可用工具',
  searchTools: '搜索工具...',
  noToolsFound: '没有找到匹配 "{query}" 的工具',
  toolsAvailableHint: '这些工具在 AI 处理您的请求时可用',

  // Tool Detail Modal
  description: '描述',
  parameters: '参数',
  required: '必填',
  gotIt: '知道了',

  // Category
  toolCountInCategory: '{count} 个工具',

  // QuickActionsPanel
  quickActions: '快捷操作',
  commonTasks: '常用任务和快捷方式',
  actions: '操作',
  smart: '智能',
  upload: '上传',
  searchActions: '搜索操作...',
  suggestedForYou: '为你推荐',
  refreshSuggestions: '刷新推荐',
  recentFiles: '最近文件',
  typeScriptActions: 'TypeScript 操作',
  analyzeTypes: '分析类型和接口',
  findReactComponents: '查找 React 组件',
  selectProjectFolder: '选择项目文件夹',
  chooseFolderToAnalyze: '选择一个文件夹来分析其内容',
  browseFolders: '浏览文件夹',
  folderSelected: '已选择文件夹',
  openQuickActions: '按 {shortcut} 打开快捷操作',

  // Quick Actions Categories
  categories: {
    all: '全部',
    discovery: '发现',
    code: '代码',
    analysis: '分析',
    automation: '自动化',
  },

  // Quick Actions Items
  quickActionsItems: {
    findFiles: '查找文件',
    findFilesDesc: '按模式搜索文件',
    searchCode: '搜索代码',
    searchCodeDesc: '在文件中搜索文本',
    explainCode: '解释代码',
    explainCodeDesc: '获取代码解释',
    runPython: '运行 Python',
    runPythonDesc: '执行 Python 代码',
    analyzeCSV: '分析 CSV',
    analyzeCSVDesc: '分析 CSV 数据',
    createChart: '创建图表',
    createChartDesc: '从数据生成图表',
    batchRename: '批量重命名',
    batchRenameDesc: '重命名多个文件',
    convertFiles: '转换文件',
    convertFilesDesc: '转换文件格式',
  },

  // SmartSuggestions
  smartSuggestions: '智能建议',
  dropFilesToAnalyze: '拖放文件以分析',
  selectFolderForSuggestions: '选择文件夹以获取个性化建议',
  noSuggestionsAvailable: '暂无建议',
  suggestions: '建议',
  analyzeProjectCode: '分析项目代码',
  analyzeProjectCodeDesc: '检查结构、函数、类型和依赖',
  selectProjectFolderShort: '选择项目文件夹',
  selectFolderToAnalyzeShort: '选择文件夹以分析',

  // InlineSuggestions
  showAvailableTools: '展示所有可用工具和功能',
  findFilesMatchingPattern: '查找匹配模式的文件',
  searchTextInsideFiles: '在文件内搜索文本',
  analyzeProjectStructure: '分析项目结构',
  explainHowCodeWorks: '解释代码的工作原理',
  recommendedTools: '推荐工具',
  basedOnMessage: '根据您的消息，这些工具可能会有帮助',
  toolSuggestion: '{count} 个工具建议',
  toolSuggestions: '{count} 个工具建议',
  autoSuggestedHint: '这些工具根据您的意图自动推荐',
  tryLabel: '试试：',
} as const
