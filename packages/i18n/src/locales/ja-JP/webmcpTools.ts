// Localized descriptions for WebMCP builtin package tools, keyed by the
// package's site hostname (matching the hostname embedded in the tool's
// provider-safe fullName). Consumed by localized UI surfaces only — the
// manifest descriptions sent to the LLM stay English (see
// browser-extension/builtin-webmcp/com.discord.main/README.md "Tool
// descriptions (i18n)" for the authoritative wording).
export const webmcpTools = {
    'discord.com': {
        read_messages: "Discord チャンネルの最近のメッセージを before/after/around ページネーション付きで読み取ります。現在の discord.com タブのログインセッションを使用します。",
        send_message: "ログイン中の discord.com タブで Discord チャンネルにメッセージを送信します。メッセージ ID への返信も可能です。",
        add_reaction: "Discord メッセージに絵文字リアクションを追加します（Unicode 絵文字または name:id 形式のカスタム絵文字）。",
        remove_reaction: "自分の絵文字リアクションを Discord メッセージから削除します。",
        list_guilds: "ログイン中のアカウントが所属する Discord サーバー（ギルド）と概算メンバー数を一覧表示します。",
        list_channels: "Discord サーバーのチャンネル（id・種類・名前・トピック・並び順・親カテゴリ・NSFW）を一覧表示します。",
        get_user_profile: "ユーザー ID で Discord のプロフィールを取得します。'@me' でログイン中アカウントを指定できます。",
        search_messages: "Discord サーバー内のメッセージを内容で検索し、作者・チャンネル・添付ファイルでフィルターできます。",
    },
} as const
