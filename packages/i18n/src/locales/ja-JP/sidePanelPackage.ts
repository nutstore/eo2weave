// サイドパネルの WebMCP パッケージ有効化プロンプト（issue #100）
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
  privacyNote:
    "この許可は拡張機能の「対応サイト」管理ページでいつでも解除できます。書き込み操作は別途確認を求めます。",
  enableToggle: "確認後にすぐ有効化してページを再読み込み",
  confirm: "有効にしてページを再読み込み",
  enabling: "有効化中…",
  notNow: "今はしない（1 日間は再通知しません）",
  enabledToast: "{name} を有効にしました。ページを再読み込みしてツールを反映します",
  enableFailedToast: "有効化に失敗しました。拡張機能が最新版か確認して再度お試しください。",
}
