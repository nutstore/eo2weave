export const workflowEditor = {
    // Node Properties Panel
    properties: "プロパティ",
    selectNodeToEdit: "ノードを選択してプロパティを編集",
    clickCanvasNode:
      "キャンバスのノードをクリックするか、右側から新しいノードを追加",
    kind: "タイプ",
    role: "役割",
    outputKey: "出力キー",
    taskInstruction: "タスク指示",
    taskInstructionHint: "クリアしてデフォルトを復元",
    setAsWorkflowEntry: "ワークフローエントリに設定",
    maxRetries: "最大再試行",
    timeout: "タイムアウト (ms)",
    advancedConfig: "高度設定",
    // Model config
    modelConfig: "モデル設定",
    modelProvider: "モデルプロバイダー",
    useDefault: "デフォルトを使用",
    modelId: "モデル ID",
    temperature: "Temperature",
    maxTokens: "最大トークン",
    resetToDefault: "デフォルトにリセット",
    // Prompt template
    promptTemplate: "プロンプトテンプレート",
    templateContent: "テンプレート内容",
    templateContentHint: "{{変数}} 構文をサポート",
    templatePlaceholder:
      "カスタムプロンプトテンプレート、{{outputKey}} を使用してアップストリーム出力を参照...",
    availableVariables: "利用可能な変数：",
    upstreamOutput: "アップストリームノード出力",
    useDefaultTemplate: "デフォルトテンプレートを使用",
    // Node kinds
    plan: "計画",
    produce: "制作",
    review: "レビュー",
    repair: "修復",
    assemble: "アセンブル",
    condition: "条件",
    planDescription: "目標と戦略を定義",
    produceDescription: "作成タスクを実行",
    reviewDescription: "出力品質を確認",
    repairDescription: "レビュー問題を修正",
    assembleDescription: "最終出力を統合",
    conditionDescription: "条件分岐の判断",
    // Add node toolbar
    add: "追加",
    addNodeTooltip: "{kind}ノードを追加 - {description}",
    // Canvas context menu
    addNodes: "ノードを追加",
    fitView: "表示に合わせる",
    editProperties: "プロパティを編集",
    setAsEntry: "エントリに設定",
    deleteNodeContext: "ノードを削除",
    // Node card
    entry: "エントリ",
    retry: "再試行",
    timeoutSec: "タイムアウト",
    // Actions
    deleteNode: "ノードを削除",
    // Canvas empty state
    noWorkflowYet: "ワークフローがまだありません",
    createOrOpenWorkflow:
      "新しいワークフローを作成するか、既存のワークフローを開く",
    // Custom workflow manager
    myWorkflows: "マイワークフロー",
    createWorkflow: "ワークフローを作成",
    editWorkflow: "ワークフローを編集",
    deleteWorkflow: "ワークフローを削除",
    workflowName: "ワークフロー名",
    workflowNamePlaceholder: "例：コードレビューパイプライン",
    workflowDescription: "説明",
    workflowDescriptionPlaceholder: "このワークフローの説明を記述...",
    confirmDelete: "削除の確認",
    workflowDeleted: "ワークフローが削除されました",
    createFailed: "ワークフローの作成に失敗しました",
    updateFailed: "ワークフローの更新に失敗しました",
    deleteFailed: "ワークフローの削除に失敗しました",
    importFailed: "ワークフローのインポートに失敗しました",
} as const

export const customWorkflowManager = {
    title: "ワークフロー管理",
    subtitle: "カスタムワークフローを管理",
    createNew: "新規ワークフロー",
    searchPlaceholder: "ワークフローを検索...",
    noResultsWithSearch: "一致するワークフローが見つかりません",
    noResultsWithoutSearch: "カスタムワークフローがまだありません",
    tryDifferentKeyword: "別のキーワードを試してください",
    clickToCreateFirst:
      "「ワークフローを作成」をクリックして最初のワークフローを作成してください",
    // Domain labels
    generic: "汎用",
    novel: "小説作成",
    video: "動画スクリプト",
    course: "コース作成",
    custom: "カスタム",
    nodesCount: "{count} ノード",
    // Status
    enabled: "有効",
    disabled: "無効",
    updatedAt: "{date} に更新",
    // Delete dialog
    confirmDelete: "削除の確認",
    deleteConfirmMessage:
      'ワークフロー "{name}" を削除してもよろしいですか？この操作は元に戻せません。',
    cancel: "キャンセル",
    delete: "削除",
    // Footer
    totalWorkflows: "ワークフロー {count} 件",
    close: "閉じる",
} as const

export const workflowEditorDialog = {
    // Header
    back: "戻る",
    workflowEditor: "ワークフローエディター",
    // Template selector
    switchTemplate: "テンプレートを切り替え",
    newWorkflow: "新規ワークフロー",
    myWorkflows: "マイワークフロー",
    builtInTemplates: "組み込みテンプレート",
    // Display names
    untitledWorkflow: "無題のワークフロー",
    customWorkflow: "カスタムワークフロー",
    workflow: "ワークフロー",
    // Confirm dialog
    unsavedChangesConfirm:
      "保存されていない変更があります。テンプレートを切り替えますか？",
    // Status
    valid: "有効",
    errors: "{count} 件のエラー",
    // Actions
    reset: "リセット",
    save: "保存",
    runSimulation: "シミュレーションを実行",
    // Aria labels
    close: "閉じる",
} as const

// Workflow
export const workflow = {
    label: "ワークフロー",
    description: "マルチステップAI協業、自动計画、作成、レビュー。",
    advancedSettings: "高度な設定",
    customRubricName: "カスタム・ルブリック・ルール",
    enableCustomRubric: "カスタム・ルブリック・ルールを有効化",
    passScore: "合格点",
    passScoreAria: "合格点",
    maxRepairRounds: "最大修復ラウンド",
    maxRepairRoundsAria: "最大修復ラウンド",
    paragraphRule: "段落文ルール",
    paragraphMin: "最小文数",
    paragraphMinAria: "段落最小文数",
    paragraphMax: "最大文数",
    paragraphMaxAria: "段落最大文数",
    dialoguePolicy: "ダイアログポリシー",
    allowSingleDialogue: "単一ダイアログを許可",
    hookRule: "オープニングフック・ルール",
    ctaRule: "CTA完全性ルール",
    customEditor: "カスタム・ワークフロー・エディター",
    manageWorkflows: "マイ・ワークフローを管理",
    simulateRun: "シミュレーション実行",
    realRun: "實際実行",
    // Template names
    templateNovelDaily: "小説日更ワークフロー",
    templateShortVideo: "短動画スクリプトワークフロー",
    templateEducationLesson: "教案ノートワークフロー",
    templateQualityLoop: "品質ループワークフロー",
    // Template labels (short)
    templateNovelDailyLabel: "小説日更",
    templateShortVideoLabel: "短動画",
    templateEducationLessonLabel: "教案ノート",
    templateQualityLoopLabel: "品質ループ",
    // Rubric names
    rubricNovelDaily: "小説日更ルブリック",
    rubricShortVideo: "短動画スクリプトル브리크",
    rubricEducationLesson: "教案ノートルブリック",
    rubricQualityLoop: "品質ループルブリック",
    // Execution progress
    thinking: "思考中...",
    thinkingProcess: "思考過程",
    executing: "執行中、お待ちください...",
    running: "実行中",
    completed: "完了",
    failed: "失敗",
    stopRunning: "実行を停止",
    contextSummary: "コンテキスト圧縮サマリー",
    status: "ステータス",
    template: "テンプレート",
    repairRounds: "修復ラウンド",
    input: "入力",
    output: "出力",
    validation: {
      rubricNameRequired: "ルブリック・ルール名を入力してください",
      passScoreRange: "合格点は0-100の間である必要があります",
      repairRoundsRange: "修復ラウンドは0-10の間である必要があります",
      paragraphRangeInvalid: "段落文数範囲が無効です",
      atLeastOneRule: "少なくとも1つのスコアリング・ルールを有効にしてください",
    },
} as const
