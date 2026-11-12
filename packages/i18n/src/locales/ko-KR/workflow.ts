export const workflowEditor = {
    // Node Properties Panel
    properties: "속성",
    selectNodeToEdit: "속성을 편집할 노드를 선택하세요",
    clickCanvasNode:
      "캔버스의 노드를 클릭하거나 오른쪽에서 새 노드를 추가하세요",
    kind: "유형",
    role: "역할",
    outputKey: "출력 키",
    taskInstruction: "태스크 지시",
    taskInstructionHint: "지우면 기본 지시 복원",
    setAsWorkflowEntry: "워크플로우 진입점으로 설정",
    maxRetries: "최대 재시도",
    timeout: "타임아웃 (ms)",
    advancedConfig: "고급 설정",
    // Model config
    modelConfig: "모델 설정",
    modelProvider: "모델 제공자",
    useDefault: "기본값 사용",
    modelId: "모델 ID",
    temperature: "Temperature",
    maxTokens: "최대 토큰",
    resetToDefault: "기본값으로 재설정",
    // Prompt template
    promptTemplate: "프롬프트 템플릿",
    templateContent: "템플릿 콘텐츠",
    templateContentHint: "{{변수}} 구문 지원",
    templatePlaceholder:
      "사용자 정의 프롬프트 템플릿, {{outputKey}}를 사용하여 업스트림 출력 참조...",
    availableVariables: "사용 가능한 변수：",
    upstreamOutput: "업스트림 노드 출력",
    useDefaultTemplate: "기본 템플릿 사용",
    // Node kinds
    plan: "계획",
    produce: "제작",
    review: "검토",
    repair: "수리",
    assemble: "조립",
    condition: "조건",
    planDescription: "목표와 전략 정의",
    produceDescription: "창작 작업 실행",
    reviewDescription: "출력 품질 확인",
    repairDescription: "검토 문제 수정",
    assembleDescription: "최종 출력 통합",
    conditionDescription: "조건 분기 판단",
    // Add node toolbar
    add: "추가",
    addNodeTooltip: "{kind} 노드 추가 - {description}",
    // Canvas context menu
    addNodes: "노드 추가",
    fitView: "뷰에 맞춤",
    editProperties: "속성 편집",
    setAsEntry: "진입점으로 설정",
    deleteNodeContext: "노드 삭제",
    // Node card
    entry: "진입점",
    retry: "재시도",
    timeoutSec: "시간 초과",
    // Actions
    deleteNode: "노드 삭제",
    // Canvas empty state
    noWorkflowYet: "아직 워크플로우가 없습니다",
    createOrOpenWorkflow: "새 워크플로우를 만들거나 기존 워크플로우를 여세요",
    // Custom workflow manager
    myWorkflows: "내 워크플로우",
    createWorkflow: "워크플로우 만들기",
    editWorkflow: "워크플로우 편집",
    deleteWorkflow: "워크플로우 삭제",
    workflowName: "워크플로우 이름",
    workflowNamePlaceholder: "예: 코드 검토 파이프라인",
    workflowDescription: "설명",
    workflowDescriptionPlaceholder: "이 워크플로우가 무엇をする지 설명...",
    confirmDelete: "삭제 확인",
    workflowDeleted: "워크플로우가 삭제되었습니다",
    createFailed: "워크플로우 만들기 실패",
    updateFailed: "워크플로우 업데이트 실패",
    deleteFailed: "워크플로우 삭제 실패",
    importFailed: "워크플로우 가져오기 실패",
} as const

export const customWorkflowManager = {
    title: "워크플로우 관리",
    subtitle: "사용자 정의 워크플로우 관리",
    createNew: "새 워크플로우",
    searchPlaceholder: "워크플로우 검색...",
    noResultsWithSearch: "일치하는 워크플로우를 찾을 수 없습니다",
    noResultsWithoutSearch: "아직 사용자 정의 워크플로우가 없습니다",
    tryDifferentKeyword: "다른 키워드를 사용해 보세요",
    clickToCreateFirst:
      "「새 워크플로우」를 클릭하여 첫 번째 워크플로우를 만드세요",
    // Domain labels
    generic: "범용",
    novel: "소설 작성",
    video: "비디오 스크립트",
    course: "강좌 제작",
    custom: "사용자 정의",
    nodesCount: "{count}개 노드",
    // Status
    enabled: "활성화됨",
    disabled: "비활성화됨",
    updatedAt: "{date}에 업데이트됨",
    // Delete dialog
    confirmDelete: "삭제 확인",
    deleteConfirmMessage:
      '워크플로우 "{name}"을(를) 삭제하시겠습니까? 이 작업은 취소할 수 없습니다.',
    cancel: "취소",
    delete: "삭제",
    // Footer
    totalWorkflows: "워크플로우 {count}개",
    close: "닫기",
} as const

export const workflowEditorDialog = {
    // Header
    back: "뒤로",
    workflowEditor: "워크플로우 편집기",
    // Template selector
    switchTemplate: "템플릿 전환",
    newWorkflow: "새 워크플로우",
    myWorkflows: "내 워크플로우",
    builtInTemplates: "내장 템플릿",
    // Display names
    untitledWorkflow: "제목 없는 워크플로우",
    customWorkflow: "사용자 정의 워크플로우",
    workflow: "워크플로우",
    // Confirm dialog
    unsavedChangesConfirm:
      "저장되지 않은 변경 사항이 있습니다. 템플릿을 전환하시겠습니까?",
    // Status
    valid: "유효",
    errors: "{count}개 오류",
    // Actions
    reset: "초기화",
    save: "저장",
    runSimulation: "시뮬레이션 실행",
    // Aria labels
    close: "닫기",
} as const

// Workflow
export const workflow = {
    label: "워크플로우",
    description: "멀티스텝 AI 협업, 자동 계획, 생성, 리뷰.",
    advancedSettings: "고급 설정",
    customRubricName: "커스텀 루브릭 규칙",
    enableCustomRubric: "커스텀 루브릭 규칙 활성화",
    passScore: "통과 점수",
    passScoreAria: "통과 점수",
    maxRepairRounds: "최대修复 라운드",
    maxRepairRoundsAria: "최대修复 라운드",
    paragraphRule: "단락 문장 규칙",
    paragraphMin: "최소 문장 수",
    paragraphMinAria: "단락 최소 문장 수",
    paragraphMax: "최대 문장 수",
    paragraphMaxAria: "단락 최대 문장 수",
    dialoguePolicy: "대화 정책",
    allowSingleDialogue: "단일 대화 허용",
    hookRule: "오프닝 훅 규칙",
    ctaRule: "CTA 완전성 규칙",
    customEditor: "커스텀 워크플로우 에디터",
    manageWorkflows: "내 워크플로우 관리",
    simulateRun: "시뮬레이션 실행",
    realRun: "실제 실행",
    // Template names
    templateNovelDaily: "소설 일간 워크플로우",
    templateShortVideo: "짧은 영상 스크립트 워크플로우",
    templateEducationLesson: "教案 노트 워크플로우",
    templateQualityLoop: "품질 루프 워크플로우",
    // Template labels (short)
    templateNovelDailyLabel: "소설 일간",
    templateShortVideoLabel: "짧은 영상",
    templateEducationLessonLabel: "教案 노트",
    templateQualityLoopLabel: "품질 루프",
    // Rubric names
    rubricNovelDaily: "소설 일간 루브릭",
    rubricShortVideo: "짧은 영상 루브릭",
    rubricEducationLesson: "教案 노트 루브릭",
    rubricQualityLoop: "품질 루프 루브릭",
    // Execution progress
    thinking: "생각 중...",
    thinkingProcess: "생각 과정",
    executing: "실행 중, 기다려 주세요...",
    running: "실행 중",
    completed: "완료",
    failed: "실패",
    stopRunning: "실행 중지",
    contextSummary: "컨텍스트 압축 요약",
    status: "상태",
    template: "템플릿",
    repairRounds: "수정 라운드",
    input: "입력",
    output: "출력",
    validation: {
      rubricNameRequired: "루브릭 규칙 이름을 입력하세요",
      passScoreRange: "통과 점수는 0-100 사이여야 합니다",
      repairRoundsRange: "修复 라운드는 0-10 사이여야 합니다",
      paragraphRangeInvalid: "단락 문장 범위가 유효하지 않습니다",
      atLeastOneRule: "최소 하나의 점수 규칙을 활성화해야 합니다",
    },
} as const
