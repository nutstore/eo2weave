// Localized descriptions for WebMCP builtin package tools, keyed by the
// package's site hostname (matching the hostname embedded in the tool's
// provider-safe fullName). Consumed by localized UI surfaces only — the
// manifest descriptions sent to the LLM stay English (see
// browser-extension/builtin-webmcp/com.discord.main/README.md "Tool
// descriptions (i18n)" for the authoritative wording).
export const webmcpTools = {
    'discord.com': {
        read_messages: "Read recent messages from a Discord channel with optional pagination (before/after/around). Uses the logged-in session of the current discord.com tab.",
        send_message: "Send a message to a Discord channel in the logged-in discord.com tab, optionally replying to a message ID.",
        add_reaction: "Add an emoji reaction to a Discord message. Accepts Unicode emoji or custom emoji in name:id form.",
        remove_reaction: "Remove your own emoji reaction from a Discord message.",
        list_guilds: "List the Discord guilds your logged-in account belongs to, with approximate member counts.",
        list_channels: "List the channels of a Discord guild with type, topic, position, parent and NSFW metadata.",
        get_user_profile: "Read a Discord user profile by user ID, or pass '@me' for the logged-in account.",
        search_messages: "Search messages in a Discord guild by content with optional author, channel and attachment filters.",
    },
} as const
