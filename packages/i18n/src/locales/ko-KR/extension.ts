// 브라우저 확장 프로그램 관련
export const extension = {
  // 배너
  bannerTitle: "웹 검색 기능을 해제하세요!",
  bannerDescription: "브라우저 확장 프로그램을 설치하면 AI가 웹 검색과 페이지 내용 읽기를 할 수 있습니다.",
  bannerAction: "자세히 보고 설치",
  bannerDismiss: "나중에",

  // 설치 가이드 다이얼로그
  guideTitle: "eo2weave 브라우저 확장 프로그램 설치",
  guideSubtitle: "AI 어시스턴트를 인터넷에 연결하세요",
  guideAlreadyInstalled: "이미 설치하셨나요?",
  verifyInstallLink: "페이지 새로고침",
  estimatedTime: "예상 소요 시간: 3-5분",
  prerequisite: "준비물: Chrome 또는 Edge 브라우저",

  // 설치 방법 선택 (1단계)
  methodChoose: "설치 방법을 선택하세요:",
  methodRecommended: "추천",
  methodStoreTitle: "Chrome 웹 스토어에서 설치",
  methodStoreDesc: "한 번의 클릭으로 설치하고 자동 업데이트됩니다. chromewebstore.google.com 접근이 필요합니다.",
  methodStoreBadge: "자동 업데이트",
  methodEdgeStoreTitle: "Edge 추가 기능에서 설치",
  methodEdgeStoreDesc: "한 번의 클릭으로 설치하고 자동 업데이트됩니다. Edge 전용 스토어로 중국 본토 네트워크에서도 바로 접근할 수 있습니다.",
  methodZipTitle: "수동 설치 (패키지 다운로드)",
  methodZipDesc: "확장 프로그램 패키지를 다운로드하여 수동으로 로드합니다. 스토어에 접근할 수 없는 환경에서도 사용할 수 있습니다.",
  methodZipBadge: "스토어 불필요",

  // 기능 목록
  featureSearch: "인터넷 검색",
  featureFetch: "웹 페이지 내용 읽기",

  // Chrome 웹 스토어 플로우
  stepStoreOpen: "Chrome 웹 스토어 열기",
  stepStoreInstall: "Chrome에 추가",
  storeOpenDesc: "확장 프로그램은 Chrome 웹 스토어에 게시되어 있습니다. 클릭 한 번으로 설치되며 업데이트는 자동입니다.",
  storeOpenButton: "Chrome 웹 스토어 열기",
  storeOpenHint: "스토어 페이지가 새 탭에서 열립니다. \"Chrome에 추가\"를 클릭한 뒤 이 페이지로 돌아와 \"다음\"을 클릭하세요.",
  storeNeedsChromium: "이 브라우저는 Chrome 웹 스토어 확장 프로그램을 지원하지 않습니다. Chrome 또는 Edge로 이 페이지를 열어주세요.",
  storeInstallDesc: "Chrome 웹 스토어 페이지에서 설치를 완료하세요",
  storeInstallStepA: "스토어 페이지에서 \"Chrome에 추가\" 클릭",
  storeInstallStepADesc: "버튼은 스토어 페이지 오른쪽 상단에 있습니다",
  storeInstallStepB: "브라우저 대화상자에서 \"확장 프로그램 추가\"를 클릭하여 확인",
  storeInstallStepBDesc: "개발자 모드가 필요 없습니다. 확장 프로그램이 자동으로 설치되고 자동 업데이트됩니다",
  storeInstallHint: "설치가 완료되면 확장 프로그램 목록에 \"EO2Weave\"가 나타납니다",

  // Edge 추가 기능 플로우 (Edge 브라우저 사용자)
  edgeStepStoreOpen: "Edge 추가 기능 열기",
  edgeStepStoreInstall: "가져오기",
  edgeStoreOpenDesc: "확장 프로그램은 Edge 추가 기능에 게시되어 있습니다. 클릭 한 번으로 설치되며 업데이트는 자동입니다.",
  edgeStoreOpenButton: "Edge 추가 기능 열기",
  edgeStoreOpenHint: "스토어 페이지가 새 탭에서 열립니다. \"가져오기\"를 클릭한 뒤 이 페이지로 돌아와 \"다음\"을 클릭하세요.",
  edgeStoreInstallDesc: "Edge 추가 기능 페이지에서 설치를 완료하세요",
  edgeStoreInstallStepA: "스토어 페이지에서 \"가져오기\" 클릭",
  edgeStoreInstallStepADesc: "버튼은 스토어 페이지 오른쪽 상단에 있습니다",
  edgeStoreInstallStepB: "브라우저 대화상자에서 확장 프로그램 추가를 확인",
  edgeStoreInstallStepBDesc: "개발자 모드가 필요 없습니다. 확장 프로그램이 자동으로 설치되고 자동 업데이트됩니다",

  // 단계
  stepIntro: "소개",
  stepDownload: "다운로드",
  stepExtract: "압축 풀기",
  stepInstall: "설치",
  stepRefresh: "새로고침",

  stepIntroDesc: "이 확장 프로그램으로 할 수 있는 일 알아보기",
  stepDownloadDesc: "확장 프로그램 패키지 다운로드",
  stepExtractDesc: "다운로드한 파일 압축 풀기",
  stepInstallDesc: "브라우저에 확장 프로그램 로드",
  stepRefreshDesc: "페이지를 새로고침하여 활성화",

  // 다운로드 단계
  downloadButton: "확장 프로그램 패키지 다운로드",
  downloadHint: "저장한 위치를 기억해 주세요. 다음 단계에서 필요합니다",
  downloadSize: "약 500KB",

  // 압축 풀기 단계
  extractTitle: "다운로드한 파일 압축 풀기",
  extractWindows: "Windows: 마우스 오른쪽 버튼 → 모두 압축 풀기",
  extractMac: "macOS: zip 파일을 더블클릭하여 압축 해제",
  extractLinux: "Linux: 마우스 오른쪽 버튼 → 다음으로 추출...",

  // 설치 단계
  installStepA: "확장 프로그램 관리 페이지 열기",
  installStepAChrome: "Chrome: 주소창에 chrome://extensions 입력",
  installStepAEdge: "Edge: 주소창에 edge://extensions 입력",
  installCopyLink: "링크 복사",
  installStepB: "오른쪽 상단의 \"개발자 모드\" 스위치 켜기",
  installStepC: "\"압축해제된 확장 프로그램을 로드합니다\" 클릭",
  installStepCSelect: "압축을 푼 chrome-extension 폴더 선택",
  installSuccessHint: "확장 프로그램 목록에 \"EO2Weave\"가 나타나면 설치 성공입니다",

  // 확인 단계 (하위 호환을 위해 유지)
  verifyTitle: "페이지 새로고침",
  verifyChecking: "확장 프로그램 상태 확인 중...",
  verifySuccess: "확장 프로그램이 준비되었습니다!",
  verifyFailed: "확장 프로그램이 감지되지 않았습니다",
  verifyRetry: "다시 시도",
  verifyTroubleshootTitle: "문제 해결",
  verifyTroubleshoot1: "chrome://extensions에서 확장 프로그램이 사용 중지되지 않았는지 확인하세요",
  verifyTroubleshoot2: "이 페이지를 새로고침한 후 다시 확인하세요",
  verifyTroubleshoot3: "올바른 압축 해제 폴더를 선택했는지 확인하세요",

  // 새로고침 단계
  refreshTitle: "마지막 단계: 페이지 새로고침",
  refreshDescription: "확장 프로그램을 활성화하려면 페이지 새로고침이 필요합니다. 아래 버튼을 클릭하여 새로고침하세요.",
  refreshButton: "페이지 새로고침",
  refreshHint: "새로고침 후 확장 프로그램이 활성화되어 웹 검색을 사용할 수 있습니다.",
  refreshPageLink: "페이지 새로고침",

  // 성공
  successTitle: "설치 완료!",
  successDescription: "AI 어시스턴트가 이제 인터넷을 검색할 수 있습니다. \"오늘 뉴스 뭐 있어?\"라고 물어보세요.",

  // 내비게이션
  nextStep: "다음",
  prevStep: "이전",
  finish: "완료",
  skip: "나중에",

  // 오류 카드 (대화 내)
  errorCardTitle: "웹 검색을 사용할 수 없습니다",
  errorCardDescription: "브라우저 확장 프로그램이 설치되지 않아 AI가 인터넷을 검색할 수 없습니다.",
  errorCardFeature1: "인터넷 검색 (DuckDuckGo)",
  errorCardFeature2: "모든 웹 페이지 내용 읽기",
  errorCardFeature3: "동적 페이지 렌더링 (Twitter, Reddit 등)",
  errorCardAction: "브라우저 확장 프로그램 설치",
  errorCardDismiss: "나중에",

  // 설정 탭
  settingsTab: "브라우저 확장",
  settingsInstalled: "확장 프로그램 준비 완료",
  settingsNotInstalled: "설치되지 않음",
  settingsInstallButton: "확장 프로그램 설치",
  settingsStoreButton: "Chrome 웹 스토어에서 설치",
  settingsEdgeStoreButton: "Edge 추가 기능에서 설치",
  settingsVersion: "버전",
  settingsDescription: "브라우저 확장 프로그램은 AI 어시스턴트에 웹 검색과 콘텐츠 읽기 기능을 제공합니다",
  settingsCapabilities: "확장 프로그램 기능",

  // 설정 — 버전 표시
  settingsVersionTitle: "버전",
  settingsLatestVersion: "최신 버전",
  settingsBundledVersion: "번들 ZIP 버전",
  settingsUpdateChannel: "업데이트 채널",
  settingsStoreAutoUpdates: "브라우저 스토어에서 자동으로 업데이트됨",
  settingsCurrentVersion: "현재 설치됨",
  settingsUpdateAvailable: "업데이트 있음",
  settingsNewerThanWeb: "웹 버전보다 최신",

  // 만료 배너
  outdatedBannerTitle: "확장 프로그램 업데이트 있음",
  outdatedBannerDescription: "설치된 확장 프로그램 (v{current})이 오래되었습니다. 최신 버전: v{latest}",
  outdatedBannerStoreAction: "스토어에서 업데이트",
  storeButtonEdgeTitle: "Edge 추가 기능 페이지를 엽니다",
  outdatedBannerZipAction: "패키지 다운로드",

  // 웹 버전보다 최신 배너

  // 모바일 알림
  mobileNotice: "브라우저 확장 프로그램은 데스크톱에서만 사용할 수 있습니다. PC의 Chrome 또는 Edge로 이 페이지를 열어 설치해 주세요.",
}
