// 환영 페이지
export const welcome = {
    title: "EO2Weave",
    tagline:
      "지식베이스와 멀티 에이전트 오케스트레이션을 위한 AI 네이티브 Creator Workspace",
    placeholder: "메시지를 입력하여 대화를 시작하세요...",
    send: "전송",
    // Shown while the async API-key check is in flight (avoids flashing the
    // "no API key" setup card before SQLite has been consulted).
    checkingConfig: "AI 설정 확인 중...",
    // Setup card (shown when no API key configured)
    setupCardTitle: "시작하기 전에 AI 설정을 완료하세요",
    setupGatewayTitle: "견과클라우드 계정으로 로그인",
    setupGatewayDesc: "견과클라우드 계정이 있나요? 원클릭 로그인, API Key 불필요",
    setupGatewayRecommend: "추천",
    setupApiKeyTitle: "자체 API Key 구성",
    setupApiKeyDesc: "OpenAI, OpenRouter, Anthropic 등 지원",
    // select-model step (key saved but no default provider/model chosen)
    selectModelCardTitle: "Key 저장됨 — 기본 모델을 선택하세요",
    selectModelActionTitle: "기본 공급자 및 모델 선택",
    selectModelActionDesc: "설정에서 구성된 공급자를 펼치고 모델을 하나 기본값으로 선택하세요",
    // Link to the model configuration guide (shown as a ? icon on setup cards)
    setupGuideTooltip: "설정 가이드 열기：공급자 Key, 고정 모델 및 기본 모델",
    setupGuideLinkTitle: "설정 방법은?",
    setupGuideLinkDesc: "3 단계：공급자 Key → 고정 모델 → 기본 모델",
    setupLocalFirstHint: "모든 데이터는 브라우저에 로컬 저장되며 서버에 업로드되지 않습니다",
    // Conditional onboarding labels (these are not a linear progress count)
    welcomeLabel: "시작하기",
    apiKeyLabel: "AI 연결",
    mountFolderLabel: "로컬 폴더 추가",
    welcomeHeading: "EO2Weave 에 오신 것을 환영합니다",
    welcomeSubtitle: "로컬 AI 워크스페이스, 파일과 코드는 브라우저 안에",
    continueButton: "계속",
    skipButton: "나중에 하기",
    mountFolderTitle: "로컬 폴더 마운트",
    mountFolderDesc: "AI가 파일을 직접 읽고 쓸 수 있습니다. 파일은 브라우저를 벗어나지 않습니다.",
    mountFolderButton: "폴더 선택",
    mountFolderBack: "뒤로",
    mountFolderMounted: "마운트된 폴더",
    readyHint: "메시지를 입력하거나 파일을 드롭하세요",
    gateway: {
        title: "견과클라우드 AI 로그인",
        close: "닫기",
        requesting: "인증 세션 생성 중...",
        enterCode: "인증 페이지에서 다음 코드를 입력하세요",
        authCodeLabel: "인증 코드",
        copy: "복사",
        openAuthPage: "인증 페이지 열기",
        waiting: "인증 대기 중...",
        success: "로그인 성공!",
        clientIdMissing:
            "Client ID가 설정되지 않았습니다. NEXT_PUBLIC_JIANGUOYUN_AI_CLIENT_ID 환경 변수를 설정하세요.",
        authFailedFallback: "인증 실패",
    },
} as const
