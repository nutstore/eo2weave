// アプリ初期化
export const app = {
    initializing: "初期化中...",
    preparing: "準備中...",
    loadProgress: "読み込み進捗",
    firstLoadHint: "初回読み込みには数秒かかる場合があります",
    productName: "EO2Weave",
    initComplete: "初期化完了",
    initFailed: "初期化に失敗しました",
    sessionStorageOnly:
      "データは現在のセッションのみ保存され、更新時に失われます",
    localStorageMode: "ローカルストレージモードを使用中",
    migrationInProgress: "データを移行中",
    migrationComplete: "移行完了",
    conversationsMigrated: "{count} 件の会話",
    // App toast messages
    pwaInstall: {
      title: "デスクトップアプリとしてインストール",
      description:
        "ネイティブアプリのように専用ウィンドウで実行され、デスクトップから直接起動できます",
      action: "インストール",
      dismiss: "後で",
    },
    resetDatabaseFailed:
      "データベースのリセットに失敗しました。ページを手動で更新してください",
    localDataCleared: "ローカルデータが消去されました。最初からやり直せます",
    clearFailedCloseOtherTabs:
      "消去に失敗しました：まずこのアプリの他のタブ/ウィンドウを閉じてから再試行してください",
    clearLocalDataFailed: "ローカルデータの消去に失敗しました",
    storageInitError: "ストレージの初期化エラー",
    projectNotFound: "プロジェクトが見つからないか、削除されました",
    switchProjectFailed:
      "プロジェクトの切り替えに失敗しました。しばらくしてから再試行してください",
    noWorkspaceInProject: "現在のプロジェクトにはワークスペースがありません",
    projectCreated: "プロジェクト「{name}」が作成されました",
    projectCreatedButSwitchFailed:
      "プロジェクトは作成されましたが、切り替えに失敗しました。手動で再試行してください",
    createProjectFailed:
      "プロジェクトの作成に失敗しました。しばらくしてから再試行してください",
    projectRenamed: "プロジェクト名を変更しました",
    renameFailed: "名前変更に失敗しました。しばらくしてから再試行してください",
    projectArchived: "プロジェクトをアーカイブしました",
    projectUnarchived: "プロジェクトのアーカイブを解除しました",
    archiveFailed:
      "アーカイブに失敗しました。しばらくしてから再試行してください",
    unarchiveFailed:
      "アーカイブ解除に失敗しました。しばらくしてから再試行してください",
    projectDeleted: "プロジェクトを削除しました",
    projectUsageExporting: "モデル、トークン、料金を集計中…",
    projectUsageExported: "使用量レポートをエクスポートしました：{filename}",
    projectUsageExportFailed: "使用量のエクスポートに失敗しました：{error}",
    deleteFailed: "削除に失敗しました。しばらくしてから再試行してください",
    // Database refresh dialog
    databaseConnectionLost: "データベース接続が切断されました",
    whatHappened: "何が発生しましたか？",
    databaseHandleInvalidExplanation:
      "ブラウザタブが休止状態になると、データベースファイルハンドルが無効になります。これは通常のブラウザ動作です。",
    ifJustClearedData:
      "「データ消去」を実行したばかりの場合は、まず同じオリジンの他のタブ/ウィンドウを閉じてから、このページを更新してください。",
    yourDataIsSafe: "会話データは安全です！",
    dataStoredInOPFS:
      "データはブラウザのOPFSに保存されており、一時的にアクセスできないだけです。",
    willAutoRecoverAfterRefresh:
      "ページを更新すると、データベース接続は自動的に回復します。",
    showTechnicalDetails: "技術的な詳細を表示",
    refreshPage: "ページを更新",
    cannotCloseDialog:
      "このダイアログは閉じられません - 上のボタンをクリックしてページを更新してください",
    databaseInitFailed: "データベースの初期化に失敗しました",
    databaseResetExplanation:
      "これはデータベースの破損または移行の失敗による可能性があります。データベースをリセットすると、すべてのデータがクリアされ再作成されます。",
    databaseCorruptedHint:
      "最近ブラウザのストレージをクリーンアップした場合（CleanMyMac、CCleaner、ブラウザの「閲覧履歴の削除」など）、OPFS データベースファイルも削除されている可能性があります。リセットする前に、下の「データベースをバックアップ」ボタンで残ったデータを救出してください。",
    exportBeforeResetWarning:
      "⚠️ リセットするとすべての会話、設定、スキルが削除され、元に戻せません。事前に「データベースをバックアップ」でエクスポートすることを強く推奨します。",
    resetDatabaseConfirm:
      "もう一度クリックして確認—すべてのデータが完全に削除されます",
    resetDatabaseArmedHint:
      "本当によろしいですか？この操作は取り消せません。ボタン外をクリックするとキャンセルできます。",
    exportDatabase: "データベースをバックアップ",
    exportDatabaseSuccess: "データベースのバックアップをダウンロードしました：{filename}",
    exportDatabaseFailed: "エクスポートに失敗しました：{error}",
    backupSuccess: "完全バックアップをダウンロードしました：{filename}",
    backupSuccessWithKey:
      "完全バックアップをダウンロードしました（API キー含む、別デバイスに復元可能）：{filename}。安全に保管し、他人と共有しないでください。",
    backupFailed: "バックアップに失敗しました：{error}",
    restoreSuccess: "バックアップを復元しました（{fileCount} ファイル）。再読み込み中…",
    restoreFailed: "復元に失敗しました：{error}。現在のデータが不完全な可能性があります。インポートを再試行してください。",
    resetDatabase: "データベースをリセット",
    reloadPage: "ページを再読み込み",
    updateAvailable: "新しいバージョンが利用可能です。最新機能のために更新してください",
    updateNow: "今すぐ更新",
    notFoundTitle: "ページが見つかりません",
    notFoundDescription: "指定されたページは存在しないか、移動されました。",
    notFoundBack: "プロジェクト一覧に戻る",
} as const
