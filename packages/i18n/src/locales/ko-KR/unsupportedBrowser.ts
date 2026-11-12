export const unsupportedBrowser = {
  title: "브라우저 저장소를 사용할 수 없습니다",
  insecureTitle: "보안 연결이 필요합니다",
  description:
    "이 페이지에서 앱 실행에 필요한 브라우저 저장소에 접근할 수 없습니다.",
  currentBrowser: "현재 브라우저: {browser}",
  unknownBrowser: "확인할 수 없음",
  guidance: {
    secureConnection:
      "HTTPS로 이 사이트에 접속하세요. 로컬 개발에는 localhost를 사용할 수 있습니다. 주소를 변경할 수 없다면 사이트 관리자에게 문의하세요.",
    chromium:
      "{browser}를 최신 버전으로 업데이트하고 일반 창(시크릿 모드가 아닌 창)에서 다시 시도하세요. 저장소를 계속 사용할 수 없다면 사이트 관리자에게 문의하세요.",
    firefox:
      "Firefox를 업데이트하고 일반 창에서 다시 시도하세요. Firefox에서는 브라우저 저장소로 온라인 대화를 할 수 있지만 로컬 폴더를 직접 열 수는 없습니다.",
    safari:
      "Safari 또는 기기의 운영체제를 업데이트하고 일반 창에서 다시 시도하세요. Safari에서는 브라우저 저장소로 온라인 대화를 할 수 있지만 로컬 폴더를 직접 열 수는 없습니다.",
    ios: "iOS 또는 iPadOS를 업데이트하고 브라우저의 일반 탭에서 이 페이지를 여세요. 다른 앱 안에서 열었다면 Safari를 사용해 보세요.",
    unknown:
      "브라우저를 업데이트하고 다른 앱의 내장 브라우저 대신 일반 브라우저 창에서 이 페이지를 여세요. 최신 Chrome이나 Edge를 사용해 볼 수도 있습니다. 문제가 계속되면 사이트 관리자에게 문의하세요.",
  },
  download: "{browser} 다운로드",
  technicalDetails: "기술 정보",
  secureContext: "보안 연결",
  browserStorage: "브라우저 저장소(OPFS)",
  localFolders: "로컬 폴더 접근",
  siteIsolation: "사이트 격리",
  available: "사용 가능",
  unavailable: "사용 불가",
  isolationHelp:
    "사이트 격리도 활성화되어 있지 않습니다. SQLite 저장소에는 COOP/COEP 응답 헤더가 필요할 수 있습니다. 사이트 관리자에게 배포 설정을 확인해 달라고 요청하세요. 브라우저를 바꿔도 사이트에 누락된 헤더는 추가되지 않습니다.",
  compatibilityTitle: "데스크톱 브라우저 API 지원 정보",
  browser: "브라우저",
  notSupported: "지원 안 함",
  compatibilityNote:
    "표의 버전은 API가 처음 제공된 버전이며 앱 전체의 호환성을 보장하지 않습니다. 최신 브라우저를 사용하세요. 모바일 지원은 다르며 iOS/iPadOS는 최신 운영체제가 필요합니다. 저장소는 HTTPS, 브라우저 정책, 사이트 설정의 영향도 받습니다.",
} as const;
