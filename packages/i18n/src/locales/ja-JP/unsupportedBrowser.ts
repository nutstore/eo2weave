export const unsupportedBrowser = {
  title: "ブラウザーのストレージを利用できません",
  insecureTitle: "安全な接続が必要です",
  description:
    "このページでは、アプリの起動に必要なブラウザーのストレージにアクセスできません。",
  currentBrowser: "現在のブラウザー：{browser}",
  unknownBrowser: "識別できません",
  guidance: {
    secureConnection:
      "HTTPS でこのサイトを開いてください。ローカル開発では localhost を使用できます。アドレスを変更できない場合は、サイトの管理者にお問い合わせください。",
    chromium:
      "{browser} を最新版に更新し、通常のウィンドウ（プライベートモード以外）で再試行してください。ストレージを利用できない場合は、サイトの管理者にお問い合わせください。",
    firefox:
      "Firefox を更新し、通常のウィンドウで再試行してください。Firefox ではブラウザーのストレージを使ってオンラインで会話できますが、ローカルフォルダーは直接開けません。",
    safari:
      "Safari または端末の OS を更新し、通常のウィンドウで再試行してください。Safari ではブラウザーのストレージを使ってオンラインで会話できますが、ローカルフォルダーは直接開けません。",
    ios: "iOS または iPadOS を更新し、ブラウザーの通常のタブでこのページを開いてください。他のアプリ内で開いている場合は Safari をお試しください。",
    unknown:
      "ブラウザーを更新し、他のアプリ内ではなく通常のブラウザーウィンドウでこのページを開いてください。最新版の Chrome または Edge もお試しいただけます。問題が続く場合は、サイトの管理者にお問い合わせください。",
  },
  download: "{browser} をダウンロード",
  technicalDetails: "技術的な詳細",
  secureContext: "安全な接続",
  browserStorage: "ブラウザーストレージ（OPFS）",
  localFolders: "ローカルフォルダーへのアクセス",
  siteIsolation: "サイトの分離",
  available: "利用可能",
  unavailable: "利用不可",
  isolationHelp:
    "サイトの分離も無効です。SQLite ストレージには COOP/COEP レスポンスヘッダーが必要な場合があります。サイトの管理者に配信設定の確認を依頼してください。ブラウザーを変更しても、サイトに不足しているヘッダーは補えません。",
  compatibilityTitle: "デスクトップブラウザーの API 対応状況",
  browser: "ブラウザー",
  notSupported: "非対応",
  compatibilityNote:
    "表のバージョンは API が利用可能になった時点を示し、アプリ全体の互換性を保証するものではありません。最新版を使用してください。モバイルの対応状況は異なり、iOS/iPadOS では新しい OS が必要です。ストレージは HTTPS、ブラウザーのポリシー、サイトの設定にも依存します。",
} as const;
