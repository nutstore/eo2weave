import type { WebMCPRecipe } from './types'

export const xiaohongshuRecipe: WebMCPRecipe = {
  id: 'xiaohongshu',
  hostname: 'www.xiaohongshu.com',
  displayName: '小红书 — Xiaohongshu',
  description: 'Search and filter notes, read loaded comments, home feeds and profiles, and manage sign-in in your current Xiaohongshu tab.',
  category: 'social',
  version: '0.2.5',
  glyph: '📕',
  tools: [
    {
      name: 'xhs_check_login',
      title: 'Check sign-in state',
      description: 'Check the sign-in state of the current Xiaohongshu tab without navigating away. Returns unknown when the page offers no reliable evidence.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'xhs_search_notes',
      title: 'Search notes',
      description: 'Navigate the current tab to Xiaohongshu search results for a keyword. After navigation, call xhs_list_search_results to read the loaded results.',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'Search keyword (1-100 characters)' },
        },
        required: ['keyword'],
      },
    },
    {
      name: 'xhs_list_search_results',
      title: 'Read search results',
      description: 'Read currently loaded search cards, cover images and exact-ID matched page-state user, interactInfo and video.capa fields. fields_scope identifies the state source. liked/collected are current account states; null means unknown, not false. visible_metrics are webpage counts and may differ from state counts. Missing fields are null. An empty list means the loaded page has no matching notes; it is not a timeout.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum cards to return (default 10)' },
        },
      },
    },
    {
      name: 'xhs_open_note',
      title: 'Open a note',
      description: 'Open a note returned by search, home feeds or profile tools in the same tab, preferring its page card click. Copy the full note_url including all query parameters. A navigated result only means opening has started; call xhs_read_current_note to verify success. If NOTE_LINK_INCOMPLETE is returned, search again and reopen the result card.',
      inputSchema: {
        type: 'object',
        properties: {
          note_url: { type: 'string', description: 'Full Xiaohongshu note URL from a current result card' },
        },
        required: ['note_url'],
      },
    },
    {
      name: 'xhs_read_current_note',
      title: 'Read the open note',
      description: 'Read title, author, text, type, visible counts, loaded comments, imageList and video from the open note. Exact current-note state also supplies user, interactInfo, time, ipLocation and xsecToken; inspect fields_scope. liked/collected are current account states, null means unknown; state counts may differ from visible_metrics and time is returned unchanged. Video preserves all available encoding/quality streams and existing subtitle URLs from mediaV2; capability/meta duration is seconds and stream duration is milliseconds. Inspect image_list_scope/image_list_partial and video_scope/video_partial/subtitles_scope. URLs may expire and are not downloaded, transcribed or interpreted. Missing fields are null; null subtitles means unavailable, not proven absent. Keep raw results in tool history and summarize media in short tables instead of repeating every URL. NOTE_UNAVAILABLE includes site error details; do not infer an account restriction or risk-control cause from this error alone.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'xhs_get_search_filters', title: 'Read search filters',
      description: 'Read the actual visible search filter groups and options. Labels nested inside the same control are returned once. Unknown or conflicting selection evidence remains null; never infer a default selection from null. If the hover panel cannot be opened, ask the user to open it and retry.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'xhs_apply_search_filters', title: 'Apply search filters',
      description: 'Set available search filters and verify their selected state. results_refresh is a separate fact: unconfirmed means existing cards must not be attributed to the new filters. Call xhs_list_search_results next; it also waits for refreshed results. Location permissions require user action.',
      inputSchema: {
        type: 'object', properties: {
          filters: { type: 'object', minProperties: 1, additionalProperties: false, properties: {
            sort_by: { type: 'string', enum: ['综合', '最新', '最多点赞', '最多评论', '最多收藏'] },
            note_type: { type: 'string', enum: ['不限', '视频', '图文'] },
            publish_time: { type: 'string', enum: ['不限', '一天内', '一周内', '半年内'] },
            search_scope: { type: 'string', enum: ['不限', '已看过', '未看过', '已关注'] },
            location: { type: 'string', enum: ['不限', '同城', '附近'] },
          } },
        }, required: ['filters'],
      },
    },
    {
      name: 'xhs_read_comments', title: 'Read loaded comments',
      description: 'Read rendered comments on the open note with parent/reply relationships. Displayed total, loaded count and returned count are separate. This reads currently loaded DOM, not all comments.',
      inputSchema: { type: 'object', properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum returned comments (default 20)' },
        include_replies: { type: 'boolean', description: 'Include currently rendered replies (default true)' },
      } },
    },
    {
      name: 'xhs_load_more_comments', title: 'Load more comments',
      description: 'Scroll the note comment area and optionally expand explicit reply controls for a bounded number of rounds. Inspect added_count, load_succeeded and stop_reason; no new comments does not mean all comments were read.',
      inputSchema: { type: 'object', properties: {
        max_rounds: { type: 'integer', minimum: 1, maximum: 5, description: 'Maximum loading rounds (default 2)' },
        expand_replies: { type: 'boolean', description: 'Expand visible show-more-replies controls (default false)' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum returned comments (default 20)' },
      } },
    },
    {
      name: 'xhs_open_home', title: 'Open home feeds',
      description: 'Navigate this tab to the Xiaohongshu home discovery page. Call xhs_list_feeds after navigation.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'xhs_list_feeds', title: 'Read home feed cards',
      description: 'Read rendered home cards, cover images, complete source links and exact-ID matched page-state user, interactInfo and video.capa fields. Inspect fields_scope; liked/collected null means unknown, not false. State counts may differ from visible_metrics. Does not fetch an entire recommendation feed. Call xhs_open_note with a returned note_url to read a note.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum returned cards (default 10)' } } },
    },
    {
      name: 'xhs_open_profile', title: 'Open a user profile',
      description: 'Open a complete same-site user profile URL in this tab. Use author_profile_url returned by a note or card and keep all query parameters. Call xhs_read_profile after navigation.',
      inputSchema: { type: 'object', properties: { profile_url: { type: 'string', description: 'Complete HTTPS www.xiaohongshu.com/user/profile/{id} URL from the page' } }, required: ['profile_url'] },
    },
    {
      name: 'xhs_read_profile', title: 'Read the open profile',
      description: 'Read visible profile information, displayed counts and loaded cards of the selected tab, including cover and exact-ID matched page-state user, interactInfo and video.capa fields. Inspect card fields_scope; liked/collected null means unknown, not false, and state counts may differ from visible_metrics. Missing fields and unknown tab are null. Pending tab results cannot be read as the new tab.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum returned cards (default 10)' } } },
    },
    {
      name: 'xhs_select_profile_tab', title: 'Select a profile tab',
      description: 'Select a visible notes, favorites or liked tab on the current profile. Private or absent tabs are unavailable. Check results_refresh_observed and read the profile to verify the refreshed list.',
      inputSchema: { type: 'object', properties: { tab: { type: 'string', enum: ['notes', 'favorites', 'liked'] } }, required: ['tab'] },
    },
    {
      name: 'xhs_open_login', title: 'Open website sign-in',
      description: 'Open the current website sign-in panel. The user completes QR or other authentication directly on the website. No QR image, cookies or credentials are returned. Opening a panel does not mean sign-in succeeded; call xhs_check_login afterward.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'xhs_logout', title: 'Sign out of Xiaohongshu', readOnlyHint: false,
      description: 'Sign out through the website only when the user explicitly requested it. This affects the Xiaohongshu session in this browser and may sign out other Xiaohongshu tabs. Requires confirm=true and EO2 tool authorization. Website confirmation may require user action; success requires observed signed-out evidence.',
      inputSchema: { type: 'object', properties: { confirm: { type: 'boolean', const: true, description: 'True only when the user requested signing out of Xiaohongshu in this browser' } }, required: ['confirm'] },
    },
  ],
}
