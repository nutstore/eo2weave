// 앱 초기화
export const app = {
    initializing: "초기화 중...",
    preparing: "준비 중...",
    loadProgress: "로딩 진행률",
    firstLoadHint: "첫 로딩은 몇 초 정도 걸릴 수 있습니다",
    productName: "EO2Weave",
    initComplete: "초기화 완료",
    initFailed: "초기화 실패",
    sessionStorageOnly:
      "데이터는 현재 세션에만 저장되며, 새로고침 시 사라집니다",
    localStorageMode: "로컬 스토리지 모드 사용 중",
    migrationInProgress: "데이터 마이그레이션 중",
    migrationComplete: "마이그레이션 완료",
    conversationsMigrated: "{count}개 대화",
    // App toast messages
    pwaInstall: {
      title: "데스크톱 앱으로 설치",
      description:
        "네이티브 앱처럼 전용 창에서 실행되며 바탕화면에서 바로 시작할 수 있습니다",
      action: "설치",
      dismiss: "나중에",
    },
    resetDatabaseFailed:
      "데이터베이스 재설정에 실패했습니다. 페이지를 수동으로 새로고침해 주세요",
    localDataCleared:
      "로컬 데이터가 삭제되었습니다. 처음부터 다시 시작할 수 있습니다",
    clearFailedCloseOtherTabs:
      "삭제에 실패했습니다. 먼저 이 앱의 다른 탭/창을 닫은 후 다시 시도해 주세요",
    clearLocalDataFailed: "로컬 데이터 삭제에 실패했습니다",
    storageInitError: "스토리지 초기화 오류",
    projectNotFound: "프로젝트를 찾을 수 없거나 삭제되었습니다",
    switchProjectFailed:
      "프로젝트 전환에 실패했습니다. 나중에 다시 시도해 주세요",
    noWorkspaceInProject: "현재 프로젝트에 작업 공간이 없습니다",
    projectCreated: '프로젝트 "{name}"이(가) 생성되었습니다',
    projectCreatedButSwitchFailed:
      "프로젝트가 생성되었지만 전환에 실패했습니다. 수동으로 다시 시도해 주세요",
    createProjectFailed:
      "프로젝트 생성에 실패했습니다. 나중에 다시 시도해 주세요",
    projectRenamed: "프로젝트 이름이 변경되었습니다",
    renameFailed: "이름 변경에 실패했습니다. 나중에 다시 시도해 주세요",
    projectArchived: "프로젝트가 보관됨으로 설정되었습니다",
    projectUnarchived: "프로젝트 보관이 취소되었습니다",
    archiveFailed: "보관 설정에 실패했습니다. 나중에 다시 시도해 주세요",
    unarchiveFailed: "보관 취소에 실패했습니다. 나중에 다시 시도해 주세요",
    projectDeleted: "프로젝트가 삭제되었습니다",
    projectUsageExporting: "모델, 토큰 및 비용을 집계하는 중…",
    projectUsageExported: "사용량 보고서를 내보냈습니다: {filename}",
    projectUsageExportFailed: "사용량 내보내기 실패: {error}",
    deleteFailed: "삭제에 실패했습니다. 나중에 다시 시도해 주세요",
    // Database refresh dialog
    databaseConnectionLost: "데이터베이스 연결이 끊어졌습니다",
    whatHappened: "무슨 일이 발생했나요?",
    databaseHandleInvalidExplanation:
      "브라우저 탭이 최대 절전 모드 후 데이터베이스 파일 핸들이 무효가 됩니다. 이는 정상적인 브라우저 동작입니다.",
    ifJustClearedData:
      '"데이터 삭제"를 방금 실행한 경우 먼저 동일한 출처의 다른 탭/창을 닫은 다음 현재 페이지를 새로고침해 주세요.',
    yourDataIsSafe: "대화 데이터는 안전합니다!",
    dataStoredInOPFS:
      "데이터는 브라우저 OPFS에 저장되어 있으며 일시적으로 액세스할 수 없을 뿐입니다.",
    willAutoRecoverAfterRefresh:
      "페이지를 새로고침하면 데이터베이스 연결이 자동으로 복원됩니다.",
    showTechnicalDetails: "기술 세부 정보 보기",
    refreshPage: "페이지 새로고침",
    cannotCloseDialog:
      "이 대화상자는 닫을 수 없습니다 - 위 버튼을 클릭하여 페이지를 새로고침해 주세요",
    databaseInitFailed: "데이터베이스 초기화 실패",
    databaseResetExplanation:
      "이는 데이터베이스 손상 또는 마이그레이션 실패로 인해 발생할 수 있습니다. 데이터베이스를 재설정하면 모든 데이터가 지워지고 다시 생성됩니다.",
    databaseCorruptedHint:
      "최근 브라우저 저장소를 정리한 경우(CleanMyMac, MacKeeper, 브라우저의 '브라우징 데이터 삭제' 등) OPFS 데이터베이스 파일도 함께 삭제되었을 수 있습니다. 재설정하기 전에 아래 '데이터베이스 백업 내보내기' 버튼으로 남은 데이터를 복구해 보세요.",
    exportBeforeResetWarning:
      "⚠️ 재설정하면 모든 대화, 설정, 스킬이 삭제되며 복구할 수 없습니다. 먼저 '데이터베이스 백업 내보내기'를 사용하는 것을 강력히 권장합니다.",
    resetDatabaseConfirm:
      "다시 클릭하여 확인 — 모든 데이터가 영구적으로 삭제됩니다",
    resetDatabaseArmedHint:
      "정말 진행하시겠습니까? 되돌릴 수 없습니다. 버튼 바깥을 클릭하면 취소됩니다.",
    exportDatabase: "데이터베이스 백업 내보내기",
    exportDatabaseSuccess: "데이터베이스 백업이 다운로드되었습니다: {filename}",
    exportDatabaseFailed: "내보내기 실패: {error}",
    backupSuccess: "전체 백업이 다운로드되었습니다: {filename}",
    backupSuccessWithKey:
      "전체 백업이 다운로드되었습니다(API 키 포함, 다른 기기에서 복원 가능): {filename}. 안전하게 보관하고 다른 사람과 공유하지 마세요.",
    backupFailed: "백업 실패: {error}",
    restoreSuccess: "백업이 복원되었습니다({fileCount}개 파일). 새로고침 중…",
    restoreFailed: "복원 실패: {error}. 현재 데이터가 불완전할 수 있습니다. 가져오기를 다시 시도하세요.",
    resetDatabase: "데이터베이스 재설정",
    reloadPage: "페이지 새로고침",
    updateAvailable: "새 버전을 사용할 수 있습니다. 최신 기능을 위해 업데이트하세요",
    updateNow: "지금 업데이트",
    notFoundTitle: "페이지를 찾을 수 없습니다",
    notFoundDescription: "요청한 페이지가 존재하지 않거나 이동되었습니다.",
    notFoundBack: "프로젝트 목록으로 돌아가기",
} as const
