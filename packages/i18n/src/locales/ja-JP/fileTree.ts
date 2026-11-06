// ファイルツリー
export const fileTree = {
    pending: {
      create: "追加",
      modify: "変更",
      delete: "削除",
    },
    copyPath: "パスをコピー",
    inspectElement: "要素を検査",
    deleteFile: "削除",
    deleteConfirm: "「{name}」を削除してもよろしいですか？",
    deleteFileTitle: "削除の確認",
    emptyStateHint: "ローカルディレクトリを選択せずにも繼續できます",
    emptyStateDescription:
      "AIが変更したファイルはここに一時保存されます。確認後にローカルファイルに保存されます",
    draftFiles: "未確認の変更",
    gitBranch: "Git ブランチ",
    detachedHead: "detached HEAD",
    approvedNotSynced: "確認済み、ディスクへの書き込み待ち",
    loadFailed: "ディレクトリにアクセスできません",
    opfsDraftRoot: "OPFS 下書き",
} as const
