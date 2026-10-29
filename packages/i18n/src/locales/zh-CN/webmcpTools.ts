// Localized descriptions for WebMCP builtin package tools, keyed by the
// package's site hostname (matching the hostname embedded in the tool's
// provider-safe fullName). Consumed by localized UI surfaces only — the
// manifest descriptions sent to the LLM stay English (see
// browser-extension/builtin-webmcp/com.discord.main/README.md "Tool
// descriptions (i18n)" for the authoritative wording).
export const webmcpTools = {
    'discord.com': {
        read_messages: "读取 Discord 频道的最近消息，支持 before/after/around 分页。使用当前 discord.com 标签页的登录态。",
        send_message: "向 Discord 频道发送消息，可通过 reply_to 回复指定消息。",
        add_reaction: "为 Discord 消息添加 emoji 表情回应（Unicode 或 name:id 自定义表情）。",
        remove_reaction: "移除自己在 Discord 消息上的 emoji 表情回应。",
        list_guilds: "列出当前登录账号所在的 Discord 服务器及大致成员数。",
        list_channels: "列出 Discord 服务器的频道（id、类型、名称、主题、排序、父分类、NSFW）。",
        get_user_profile: "按 ID 读取 Discord 用户资料，传 '@me' 查询当前登录账号。",
        search_messages: "在 Discord 服务器内按内容搜索消息，支持作者、频道与附件过滤。",
    },
} as const
