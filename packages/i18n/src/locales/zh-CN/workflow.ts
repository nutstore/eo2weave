export const workflowEditor = {
    // Node Properties Panel
    properties: "属性",
    selectNodeToEdit: "选择节点以编辑属性",
    clickCanvasNode: "点击画布中的节点或从右侧添加新节点",
    kind: "类型",
    role: "角色",
    outputKey: "输出键",
    taskInstruction: "任务说明",
    taskInstructionHint: "清空后恢复默认说明",
    setAsWorkflowEntry: "设为工作流入口",
    maxRetries: "最大重试",
    timeout: "超时(ms)",
    advancedConfig: "高级配置",
    // Model config
    modelConfig: "模型配置",
    modelProvider: "模型提供商",
    useDefault: "使用默认",
    modelId: "模型 ID",
    temperature: "Temperature",
    maxTokens: "最大 Token",
    resetToDefault: "重置为默认",
    // Prompt template
    promptTemplate: "提示词模板",
    templateContent: "模板内容",
    templateContentHint: "支持 {{变量}} 语法",
    templatePlaceholder:
      "自定义提示词模板，可使用 {{outputKey}} 引用上游输出...",
    availableVariables: "可用变量：",
    upstreamOutput: "上游节点输出",
    useDefaultTemplate: "使用默认模板",
    // Node kinds
    plan: "规划",
    produce: "创作",
    review: "审查",
    repair: "修复",
    assemble: "组装",
    condition: "条件",
    planDescription: "定义目标和策略",
    produceDescription: "执行创作任务",
    reviewDescription: "检查输出质量",
    repairDescription: "修正审查问题",
    assembleDescription: "整合最终输出",
    conditionDescription: "条件分支判断",
    // Add node toolbar
    add: "添加",
    addNodeTooltip: "添加{kind}节点 - {description}",
    // Canvas context menu
    addNodes: "添加节点",
    fitView: "全部适应视图",
    editProperties: "编辑属性",
    setAsEntry: "设为入口",
    deleteNodeContext: "删除节点",
    // Node card
    entry: "入口",
    retry: "重试",
    timeoutSec: "超时",
    // Actions
    deleteNode: "删除节点",
    // Canvas empty state
    noWorkflowYet: "暂无工作流",
    createOrOpenWorkflow: "创建新工作流或打开现有工作流",
    // Custom workflow manager
    myWorkflows: "我的工作流",
    createWorkflow: "创建工作流",
    editWorkflow: "编辑工作流",
    deleteWorkflow: "删除工作流",
    workflowName: "工作流名称",
    workflowNamePlaceholder: "例如：代码审查流程",
    workflowDescription: "描述",
    workflowDescriptionPlaceholder: "描述这个工作流的作用...",
    confirmDelete: "确认删除",
    workflowDeleted: "工作流已删除",
    createFailed: "创建工作流失败",
    updateFailed: "更新工作流失败",
    deleteFailed: "删除工作流失败",
    importFailed: "导入工作流失败",
} as const

export const customWorkflowManager = {
    title: "工作流管理",
    subtitle: "管理您的自定义工作流",
    createNew: "新建工作流",
    searchPlaceholder: "搜索工作流...",
    noResultsWithSearch: "未找到匹配的工作流",
    noResultsWithoutSearch: "暂无自定义工作流",
    tryDifferentKeyword: "尝试使用其他关键词搜索",
    clickToCreateFirst: "点击「新建工作流」创建您的第一个工作流",
    // Domain labels
    generic: "通用",
    novel: "小说创作",
    video: "视频脚本",
    course: "课程制作",
    custom: "自定义",
    nodesCount: "{count} 个节点",
    // Status
    enabled: "已启用",
    disabled: "已禁用",
    updatedAt: "更新于 {date}",
    // Delete dialog
    confirmDelete: "确认删除",
    deleteConfirmMessage: '确定要删除工作流 "{name}" 吗？此操作不可撤销。',
    cancel: "取消",
    delete: "删除",
    // Footer
    totalWorkflows: "共 {count} 个工作流",
    close: "关闭",
} as const

export const workflowEditorDialog = {
    // Header
    back: "返回",
    workflowEditor: "工作流编辑器",
    // Template selector
    switchTemplate: "切换模板",
    newWorkflow: "新建工作流",
    myWorkflows: "我的工作流",
    builtInTemplates: "内置模板",
    // Display names
    untitledWorkflow: "未命名工作流",
    customWorkflow: "自定义工作流",
    workflow: "工作流",
    // Confirm dialog
    unsavedChangesConfirm: "当前有未保存改动，确认切换模板吗？",
    // Status
    valid: "有效",
    errors: "{count} 个错误",
    // Actions
    reset: "重置",
    save: "保存",
    runSimulation: "运行模拟",
    // Aria labels
    close: "关闭",
} as const

// Workflow
export const workflow = {
    label: "工作流",
    description: "多步骤 AI 协作，自动规划、创作、审查。",
    advancedSettings: "高级设置",
    customRubricName: "自定义评分规则",
    enableCustomRubric: "启用自定义评分规则",
    passScore: "通过分数",
    passScoreAria: "通过分",
    maxRepairRounds: "最大修复轮次",
    maxRepairRoundsAria: "最大修复轮次",
    paragraphRule: "段落句数规则",
    paragraphMin: "最小句数",
    paragraphMinAria: "段落最小句数",
    paragraphMax: "最大句数",
    paragraphMaxAria: "段落最大句数",
    dialoguePolicy: "对话段策略",
    allowSingleDialogue: "允许单句对话段",
    hookRule: "开场钩子规则",
    ctaRule: "CTA 完整性规则",
    customEditor: "自定义工作流编辑器",
    manageWorkflows: "管理我的工作流",
    simulateRun: "模拟运行",
    realRun: "真实运行",
    // Template names
    templateNovelDaily: "小说日更工作流",
    templateShortVideo: "短视频脚本工作流",
    templateEducationLesson: "教案笔记工作流",
    templateQualityLoop: "质量循环工作流",
    // Template labels (short)
    templateNovelDailyLabel: "小说日更",
    templateShortVideoLabel: "短视频脚本",
    templateEducationLessonLabel: "教案笔记",
    templateQualityLoopLabel: "质量循环",
    // Rubric names
    rubricNovelDaily: "小说日更评分规则",
    rubricShortVideo: "短视频脚本评分规则",
    rubricEducationLesson: "教案笔记评分规则",
    rubricQualityLoop: "质量循环评分规则",
    // Execution progress
    thinking: "思考中...",
    thinkingProcess: "思考过程",
    executing: "正在执行，请稍候...",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    stopRunning: "停止运行",
    contextSummary: "上下文压缩摘要",
    status: "状态",
    template: "模板",
    repairRounds: "修复轮次",
    input: "输入",
    output: "输出",
    validation: {
      rubricNameRequired: "请填写评分规则名称",
      passScoreRange: "通过分需在 0-100 之间",
      repairRoundsRange: "修复轮次需在 0-10 之间",
      paragraphRangeInvalid: "段落句数范围不合法",
      atLeastOneRule: "至少启用一条评分规则",
    },
} as const
