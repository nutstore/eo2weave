// Side-panel WebMCP package opt-in prompt (issue #100)
export const sidePanelPackage = {
  title: "이 사이트에서 AI 도구를 사용할까요?",
  description:
    "eo2weave 브라우저 확장은 이 사이트에 MCP 도구(총 {count}개)를 주입할 수 있습니다. 허용하면 AI 어시스턴트가 이 사이트를 직접 검색하고 조작할 수 있게 됩니다.",
  packageLabel: "지원 사이트 패키지",
  toolsTitle: "이 페이지에 노출될 WebMCP 도구({count})",
  toolsCollapse: "도구 목록 접기",
  toolsExpand: "도구 목록 펼치기",
  readOnly: "읽기 전용",
  write: "쓰기",
  additionalToolsNote: "활성화하면 이 패키지의 추가 도구 {count}개가 다른 지원 사이트에서도 활성화됩니다.",
  privacyNote:
    "이 권한은 확장 프로그램의 \"지원 사이트\" 관리 페이지에서 언제든 해제할 수 있습니다. 쓰기 작업은 별도로 확인을 요청합니다.",
  confirm: "활성화 후 페이지 새로고침",
  enabling: "활성화 중…",
  notNow: "나중에 (1일 동안 다시 알리지 않음)",
  enabledReloadFailedToast: "{name}이(가) 활성화되었지만 페이지 새로고침에 실패했습니다. 수동으로 새로고침하면 도구가 활성화됩니다",
  enableTimeoutToast: "활성화 요청이 시간 초과되었습니다. 잠시 후 다시 시도해 주세요.",
  enabledToast: "{name}이(가) 활성화되었습니다. 도구를 적용하기 위해 페이지를 새로고침합니다",
  enableFailedToast: "활성화에 실패했습니다. 확장 프로그램이 최신 버전인지 확인 후 다시 시도해 주세요.",
  consentRetryToast: "확인 토큰이 만료되었습니다. 이 대화상자를 닫으면 다시 시도할 수 있습니다(쿨다운이 기록되지 않음).",
  enabledVerificationUnavailableToast: "{name}을(를) 활성화하고 페이지를 새로고침했지만 쓰기 검증을 완료하지 못했습니다 — 도구가 나타나지 않으면 확장 프로그램의 '지원되는 사이트' 관리 페이지에서 확인하세요.",
}
