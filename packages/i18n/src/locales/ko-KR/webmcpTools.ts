// Localized descriptions for WebMCP builtin package tools, keyed by the
// package's site hostname (matching the hostname embedded in the tool's
// provider-safe fullName). Consumed by localized UI surfaces only — the
// manifest descriptions sent to the LLM stay English (see
// browser-extension/builtin-webmcp/com.discord.main/README.md "Tool
// descriptions (i18n)" for the authoritative wording).
export const webmcpTools = {
    'discord.com': {
        read_messages: "Discord 채널의 최근 메시지를 before/after/around 페이지네이션과 함께 읽어옵니다. 현재 discord.com 탭의 로그인 세션을 사용합니다.",
        send_message: "로그인된 discord.com 탭에서 Discord 채널에 메시지를 보냅니다. 메시지 ID로 답장할 수 있습니다.",
        add_reaction: "Discord 메시지에 이모지 반응을 추가합니다(유니코드 이모지 또는 name:id 형식의 커스텀 이모지).",
        remove_reaction: "Discord 메시지에서 내 이모지 반응을 제거합니다.",
        list_guilds: "로그인한 계정이 속한 Discord 서버와 대략적인 멤버 수를 나열합니다.",
        list_channels: "Discord 서버의 채널(id, 유형, 이름, 주제, 정렬, 상위 카테고리, NSFW)을 나열합니다.",
        get_user_profile: "사용자 ID로 Discord 프로필을 조회합니다. '@me'로 로그인 계정을 조회할 수 있습니다.",
        search_messages: "Discord 서버에서 메시지 내용을 검색하고 작성자·채널·첨부 파일로 필터링합니다.",
    },
} as const
