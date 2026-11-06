// 파일 트리
export const fileTree = {
    pending: {
      create: "추가",
      modify: "수정",
      delete: "삭제",
    },
    copyPath: "경로 복사",
    inspectElement: "요소 검사",
    deleteFile: "삭제",
    deleteConfirm: "\"{name}\"을(를) 삭제하시겠습니까?",
    deleteFileTitle: "삭제 확인",
    emptyStateHint: "로컬 디렉터리를 선택하지 않고도 계속할 수 있습니다",
    emptyStateDescription:
      "AI가 수정한 파일이 여기에 임시 저장됩니다. 확인 후 로컬 파일에 저장됩니다",
    draftFiles: "확인 대기 중인 변경",
    gitBranch: "Git 브랜치",
    detachedHead: "detached HEAD",
    approvedNotSynced: "확인됨, 디스크 저장 대기 중",
    loadFailed: "디렉터리에 접근할 수 없습니다",
    opfsDraftRoot: "OPFS 초안",
} as const
