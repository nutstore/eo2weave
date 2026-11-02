// Side-panel WebMCP package opt-in prompt (issue #100)
export const sidePanelPackage = {
  title: "このサイトで AI ツールを有効にしますか？",
  description:
    "eo2weave ブラウザ拡張はこのサイトへ MCP ツール（全 {count} 個）を注入できます。有効にすると、AI アシスタントがこのサイトを直接検索・操作できるようになります。",
  packageLabel: "対応サイトパッケージ",
  toolsTitle: "このページに公開される WebMCP ツール（{count}）",
  toolsCollapse: "ツール一覧を折りたたむ",
  toolsExpand: "ツール一覧を展開する",
  readOnly: "読み取り専用",
  write: "書き込み",
  additionalToolsNote: "有効にすると、このパッケージの他 {count} 個のツールが他の対応サイトでも有効になります。",
  privacyNote:
    "この許可は拡張機能の「対応サイト」管理ページでいつでも解除できます。書き込み操作は別途確認を求めます。",
  confirm: "有効にしてページを再読み込み",
  enabling: "有効化中…",
  notNow: "今はしない（1 日間は再通知しません）",
  enabledReloadFailedToast: "{name} を有効にしましたが、ページの再読み込みに失敗しました。手動で再読み込みするとツールが有効になります",
  enableTimeoutToast: "有効化リクエストがタイムアウトしました。しばらくしてからもう一度お試しください。",
  enabledToast: "{name} を有効にしました。ページを再読み込みしてツールを反映します",
  enableFailedToast: "有効化に失敗しました。拡張機能が最新版か確認して再度お試しください。",
  consentRetryToast: "確認トークンの有効期限が切れました。このダイアログを閉じると再試行できます（クールダウンは記録されません）。",
  enabledVerificationUnavailableToast: "{name} を有効にしてページを再読み込みしましたが、書き込みの検証を完了できませんでした——ツールが表示されない場合は拡張機能の「対応サイト」管理ページで確認してください。",
}
