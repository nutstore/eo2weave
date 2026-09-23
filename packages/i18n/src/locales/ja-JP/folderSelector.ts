// フォルダ選択
export const folderSelector = {
    openFolder: "フォルダを選択",
    browserAccess: "ブラウザーアクセス",
    browserAccessDescription: "ブラウザーでフォルダーを選択してアクセスを許可",
    localConnection: "ローカル接続",
    localConnectionDescription: "おすすめ —— eo2weave のローカルサービスで接続。セッションをまたいで認証が維持され、再選択は不要",
    switchFolder: "フォルダを切り替え",
    releaseHandle: "ハンドルを解放",
    copyPath: "フォルダ名をコピー",
    permissionDenied: "権限が拒否されました",
    selectionFailed: "選択に失敗しました",
    sandboxMode: "サンドボックスモード (OPFS)",
    restorePermission: "権限を回復",
    needsPermissionRestore: "権限の回復が必要",
    loading: "読み込み中...",
    unknown: "不明",
    storageWarning: "キャッシュ",
    storageTooltip:
      "永続ストレージが許可されていません。クリックして再試行。キャッシュは更新時にクリアされる可能性があります。",
    storageSuccess: "ストレージが永続化されました",
    storageFailed: "永続ストレージを取得できません",
    storageRequestFailed: "リクエストに失敗しました",
} as const
