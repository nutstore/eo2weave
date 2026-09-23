// ウェルカムページ
export const welcome = {
    title: "EO2Weave",
    tagline:
      "ナレッジベースとマルチエージェント編成のための AI ネイティブ Creator Workspace",
    placeholder: "メッセージを入力して会話を開始...",
    send: "送信",
    // Shown while the async API-key check is in flight (avoids flashing the
    // "no API key" setup card before SQLite has been consulted).
    checkingConfig: "AI 設定を確認中...",
    // Minimal-list setup card: header is the 'Connect AI' label
    // (welcome.apiKeyLabel); row descriptions carry the billing story.
    // Extension card (global build):
    setupExtensionTitle: "ブラウザ拡張機能で GPT を利用",
    setupExtensionDesc: "拡張機能をインストールし、ChatGPT アカウントで Codex にログインするだけ。利用量は ChatGPT サブスクリプションの枠から消費され、API 課金は発生しません（API Key 不要）。おすすめモデル：GPT-6 Luna（または GPT-5.6 Luna）",
    setupExtensionRecommend: "推奨",
    setupGatewayTitle: "堅果雲アカウントでログイン",
    setupGatewayDesc: "堅果雲アカウントをお持ちですか？ワンクリックでログイン、API Key 不要",
    setupGatewayRecommend: "推奨",
    setupApiKeyTitle: "独自の API Key を構成",
    setupApiKeyDesc: "プロバイダーごとの API 課金。OpenAI、OpenRouter、Anthropic などに対応",
    // select-model step (key saved but no default provider/model chosen)
    selectModelCardTitle: "Key 保存済み — デフォルトモデルを選択してください",
    selectModelActionTitle: "デフォルトのプロバイダーとモデルを選択",
    selectModelActionDesc: "設定で構成済みのプロバイダーを展開し、モデルを 1 つデフォルトとして選択してください",
    // Link to the model configuration guide (shown as a ? icon on setup cards)
    setupGuideTooltip: "設定ガイドを開く：プロバイダー Key、ピン留めモデルとデフォルトモデル",
    setupGuideLinkTitle: "設定方法は？",
    setupGuideLinkDesc: "3 ステップ：プロバイダー Key → ピン留めモデル → デフォルトモデル",
    setupLocalFirstHint: "すべてのデータはブラウザにローカル保存され、サーバーにアップロードされません",
    // Conditional onboarding labels (these are not a linear progress count)
    apiKeyLabel: "AI に接続",
    welcomeHeading: "EO2Weave へようこそ",
    welcomeSubtitle: "ローカル AI ワークスペース、ファイルとコードはブラウザ内に",
    continueButton: "続ける",
    skipButton: "今はスキップ",
    mountFolderTitle: "ローカルフォルダをマウント",
    mountFolderDesc: "AI がファイルを直接読み書きできます。ファイルはブラウザから出ません。",
    mountFolderButton: "フォルダを選択",
    mountFolderBack: "戻る",
    readyHint: "メッセージを入力、またはファイルをドロップしてください",
    sendBlockedNotReady: "先に上のセットアップを完了してください——入力内容は保存されており、準備ができたら送信できます。",
    gateway: {
        title: "堅果雲 AI にログイン",
        close: "閉じる",
        requesting: "認可セッションを作成中...",
        enterCode: "認可ページで次のコードを入力してください",
        authCodeLabel: "認可コード",
        copy: "コピー",
        openAuthPage: "認可ページを開く",
        waiting: "認可を待機中...",
        success: "ログイン成功！",
        clientIdMissing:
            "Client ID が設定されていません。NEXT_PUBLIC_JIANGUOYUN_AI_CLIENT_ID 環境変数を設定してください。",
        authFailedFallback: "認証に失敗しました",
    },
} as const
