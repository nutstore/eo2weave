// ブラウザ拡張機能関連
export const extension = {
  // バナー
  bannerTitle: "ウェブ検索を解禁！",
  bannerDescription: "ブラウザ拡張機能をインストールすると、AI がウェブの検索やページの読み取りを行えるようになります。",
  bannerAction: "詳しく見てインストール",
  bannerDismiss: "後で",

  // インストールガイドダイアログ
  guideTitle: "eo2weave ブラウザ拡張機能のインストール",
  guideSubtitle: "AI アシスタントをインターネットに接続",
  guideAlreadyInstalled: "すでにインストール済みですか？",
  verifyInstallLink: "ページを更新",
  estimatedTime: "所要時間の目安：3〜5 分",
  prerequisite: "必要なもの：Chrome または Edge ブラウザ",

  // インストール方法の選択（ステップ 1）
  methodChoose: "インストール方法を選択してください：",
  methodRecommended: "おすすめ",
  methodStoreTitle: "Chrome ウェブストアからインストール",
  methodStoreDesc: "ワンクリックでインストール、自動更新。chromewebstore.google.com へのアクセスが必要です。",
  methodStoreBadge: "自動更新",
  methodEdgeStoreTitle: "Edge アドオンからインストール",
  methodEdgeStoreDesc: "ワンクリックでインストール、自動更新。Edge 専用ストアで、中国本土のネットワークからもアクセスできます。",
  methodZipTitle: "手動インストール（パッケージをダウンロード）",
  methodZipDesc: "拡張機能のパッケージをダウンロードして手動で読み込みます。ストアにアクセスできない環境でも使用できます。",
  methodZipBadge: "ストア不要",

  // 機能リスト
  featureSearch: "インターネットを検索",
  featureFetch: "ウェブページの内容を読み取る",

  // Chrome ウェブストアのフロー
  stepStoreOpen: "Chrome ウェブストアを開く",
  stepStoreInstall: "Chrome に追加",
  storeOpenDesc: "拡張機能は Chrome ウェブストアで公開されています。ワンクリックでインストールでき、更新は自動です。",
  storeOpenButton: "Chrome ウェブストアを開く",
  storeOpenHint: "ストアのページが新しいタブで開きます。「Chrome に追加」をクリックしてから、このページに戻り「次へ」をクリックしてください。",
  storeNeedsChromium: "このブラウザは Chrome ウェブストアの拡張機能に対応していません。Chrome または Edge でこのページを開いてください。",
  storeInstallDesc: "Chrome ウェブストアのページでインストールを完了してください",
  storeInstallStepA: "ストアのページで「Chrome に追加」をクリック",
  storeInstallStepADesc: "ボタンはストアページの右上にあります",
  storeInstallStepB: "ブラウザのダイアログで「拡張機能を追加」をクリックして確認",
  storeInstallStepBDesc: "開発者モードは不要です。拡張機能は自動的にインストールされ、自動更新されます",
  storeInstallHint: "インストールが完了すると、拡張機能の一覧に「EO2Weave」が表示されます",

  // Edge アドオンのフロー（Edge ブラウザユーザー向け）
  edgeStepStoreOpen: "Edge アドオンを開く",
  edgeStepStoreInstall: "取得",
  edgeStoreOpenDesc: "拡張機能は Edge アドオンで公開されています。ワンクリックでインストールでき、更新は自動です。",
  edgeStoreOpenButton: "Edge アドオンを開く",
  edgeStoreOpenHint: "ストアのページが新しいタブで開きます。「取得」をクリックしてから、このページに戻り「次へ」をクリックしてください。",
  edgeStoreInstallDesc: "Edge アドオンのページでインストールを完了してください",
  edgeStoreInstallStepA: "ストアのページで「取得」をクリック",
  edgeStoreInstallStepADesc: "ボタンはストアページの右上にあります",
  edgeStoreInstallStepB: "ブラウザのダイアログで拡張機能の追加を確認",
  edgeStoreInstallStepBDesc: "開発者モードは不要です。拡張機能は自動的にインストールされ、自動更新されます",

  // ステップ
  stepIntro: "紹介",
  stepDownload: "ダウンロード",
  stepExtract: "解凍",
  stepInstall: "インストール",
  stepRefresh: "更新",

  stepIntroDesc: "この拡張機能でできることを知る",
  stepDownloadDesc: "拡張機能のパッケージをダウンロード",
  stepExtractDesc: "ダウンロードしたファイルを解凍",
  stepInstallDesc: "ブラウザに拡張機能を読み込む",
  stepRefreshDesc: "ページを更新して有効化",

  // ダウンロードステップ
  downloadButton: "拡張機能パッケージをダウンロード",
  downloadHint: "保存した場所を覚えておいてください。次のステップで必要になります",
  downloadSize: "約 500KB",

  // 解凍ステップ
  extractTitle: "ダウンロードしたファイルを解凍",
  extractWindows: "Windows：右クリック → すべて展開",
  extractMac: "macOS：zip ファイルをダブルクリックして解凍",
  extractLinux: "Linux：右クリック → 次へ抽出...",

  // インストールステップ
  installStepA: "拡張機能の管理ページを開く",
  installStepAChrome: "Chrome：アドレスバーに chrome://extensions と入力",
  installStepAEdge: "Edge：アドレスバーに edge://extensions と入力",
  installCopyLink: "リンクをコピー",
  installStepB: "右上の「デベロッパーモード」をオンにする",
  installStepC: "「パッケージ化されていない拡張機能を読み込む」をクリック",
  installStepCSelect: "解凍した chrome-extension フォルダを選択",
  installSuccessHint: "拡張機能の一覧に「EO2Weave」が表示されればインストール成功です",

  // 確認ステップ（後方互換のため維持）
  verifyTitle: "ページを更新",
  verifyChecking: "拡張機能の状態を確認中...",
  verifySuccess: "拡張機能の準備ができました！",
  verifyFailed: "拡張機能が検出されません",
  verifyRetry: "再試行",
  verifyTroubleshootTitle: "トラブルシューティング",
  verifyTroubleshoot1: "chrome://extensions で拡張機能が有効になっているか確認してください",
  verifyTroubleshoot2: "このページを更新して再確認してください",
  verifyTroubleshoot3: "正しい解凍フォルダを選択したか確認してください",

  // 更新ステップ
  refreshTitle: "最後のステップ：ページを更新",
  refreshDescription: "拡張機能を有効にするにはページの更新が必要です。下のボタンをクリックして再読み込みしてください。",
  refreshButton: "ページを更新",
  refreshHint: "更新後、拡張機能が有効になり、ウェブ検索を利用できるようになります。",
  refreshPageLink: "ページを更新",

  // 成功
  successTitle: "インストール完了！",
  successDescription: "AI アシスタントがインターネットを検索できるようになりました。「今日のニュースは？」と聞いてみてください。",

  // ナビゲーション
  nextStep: "次へ",
  prevStep: "戻る",
  finish: "完了",
  skip: "今はしない",

  // エラーカード（会話内）
  errorCardTitle: "ウェブ検索を利用できません",
  errorCardDescription: "ブラウザ拡張機能がインストールされていないため、AI はインターネットを検索できません。",
  errorCardFeature1: "インターネットを検索（DuckDuckGo）",
  errorCardFeature2: "任意のウェブページの内容を読み取る",
  errorCardFeature3: "動的なページをレンダリング（Twitter、Reddit など）",
  errorCardAction: "ブラウザ拡張機能をインストール",
  errorCardDismiss: "今はしない",

  // 設定タブ
  settingsTab: "ブラウザ拡張",
  settingsInstalled: "拡張機能は準備完了",
  settingsNotInstalled: "未インストール",
  settingsInstallButton: "拡張機能をインストール",
  settingsStoreButton: "Chrome ウェブストアからインストール",
  settingsEdgeStoreButton: "Edge アドオンからインストール",
  settingsVersion: "バージョン",
  settingsDescription: "ブラウザ拡張機能は、AI アシスタントにウェブ検索とコンテンツ読み取りの機能を提供します",
  settingsCapabilities: "拡張機能の能力",

  // 設定 — バージョン表示
  settingsVersionTitle: "バージョン",
  settingsLatestVersion: "最新版",
  settingsBundledVersion: "同梱 ZIP バージョン",
  settingsUpdateChannel: "更新チャネル",
  settingsStoreAutoUpdates: "ブラウザストアによって自動更新されます",
  settingsCurrentVersion: "現在インストール済み",
  settingsUpdateAvailable: "更新あり",
  settingsNewerThanWeb: "ウェブ版より新しい",

  // 期限切れバナー
  outdatedBannerTitle: "拡張機能の更新があります",
  outdatedBannerDescription: "お使いの拡張機能 (v{current}) は古いです。最新版：v{latest}",
  outdatedBannerStoreAction: "ストアで更新",
  storeButtonEdgeTitle: "Edge アドオンのページを開きます",
  outdatedBannerZipAction: "パッケージをダウンロード",

  // ウェブ版より新しいバナー

  // モバイル通知
  mobileNotice: "ブラウザ拡張機能はデスクトップでのみ利用できます。お使いのパソコンの Chrome または Edge でこのページを開いてインストールしてください。",
}
