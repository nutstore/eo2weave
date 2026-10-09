import type { WebMCPRecipe } from './types'

const FEED_FIELDS_DESCRIPTION = ' Each item includes feed with upstream id/modelType/xsecToken/noteCard/index, only for an exact rendered note ID match; inspect feed_scope and feed_partial. feed.noteCard preserves state type/displayTitle/user/interactInfo/cover/video.capa separately from DOM summaries. Missing fields are null, explicit empty strings are retained. item.index is the return position; feed.index is the original state index or null, never inferred. loaded_count_scope identifies the counted subset, and return_truncated only indicates the limit excluded items, not that all site results were loaded. Summarize IDs, fields and URL/token presence without repeating signed URLs, access tokens or the full feed objects.'

export const xiaohongshuRecipe: WebMCPRecipe = {
  id: 'xiaohongshu',
  hostname: 'www.xiaohongshu.com',
  additionalHostnames: ['creator.xiaohongshu.com'],
  displayName: '小红书 — Xiaohongshu',
  description: 'Read Xiaohongshu notes and profiles, and prepare image or video notes in your current creator-platform tab. Final publishing is deferred.',
  category: 'social',
  version: '0.4.0',
  glyph: '📕',
  tools: [
    {
      name: 'xhs_publish_video', title: '准备小红书视频', readOnlyHint: false,
      description: '参照原仓库 publish_with_video，在当前标签页准备单个本地视频，最终发布暂缓，不点击发布或暂存离开。open 打开创作页面后重新发现工具；prepare 提供 operation_id、title、content、video 和选项并选择上传视频；upload 用同一 operation_id 和 video 传入文件；status 查询处理进度；处理完成后 configure 填写文稿、话题、定时、可见范围和商品。video 使用知知已授权工作区相对路径、vfs://workspace 或 vfs://assets，不支持远程视频地址，不传文件字节。EO2 内部分块传递完整文件，不压缩、转码或截断，不需要 Agent 分块调用。处理完成按上游发布按钮可用状态判断，这不等于发布成功。VIDEO_PROCESSING_PENDING 时继续查询 status，保留已交给网页的文件。文稿和选项使用已有 CDP 输入；逐字填写会需要等待。准备好后只核对网页，明确尚未发布。后续 configure 可只修改本次提供的字段，局部失败重试保留修改范围，不重新上传视频。话题沿用前十项和首个建议；定时沿用初始一小时至十四天范围；商品需要账号支持。返回请求设置和网页观察值，未知标 null。上游视频没有原创声明或自选封面参数，本工具不增加这些能力，也不增加视频理解、音频转写或登录工具。报告不输出文件字节或账号 token。',
      inputSchema: { type: 'object', properties: {
        action: { type: 'string', enum: ['open', 'prepare', 'upload', 'configure', 'status'] },
        operation_id: { type: 'string', description: 'Associate the preparation steps for this video.' },
        title: { type: 'string', description: 'Upstream weighted title length <=20.' },
        content: { type: 'string', description: 'Full body with line breaks; put topics in tags.' },
        video: { type: 'string', description: 'Single authorized local video source, required for prepare/upload.' },
        tags: { type: 'array', items: { type: 'string' } },
        schedule_at: { type: 'string', description: 'RFC3339 with timezone, initially 1 hour to 14 days ahead.' },
        visibility: { type: 'string', enum: ['', '公开可见', '仅自己可见', '仅互关好友可见'] },
        products: { type: 'array', items: { type: 'string' } },
      }, required: ['action'] },
    },
    {
      name: 'xhs_publish_content', title: '准备小红书图文', readOnlyHint: false,
      description: '在当前标签页准备小红书图文，参考原仓库 publish_content 的字段和操作顺序。目前只上传图片、填写标题正文、添加话题和设置选项，最终发布暂缓，不执行 submit，不通过其他页面工具点击发布或暂存离开。步骤：open 打开创作页面后重新获取工具；prepare 提供 operation_id、title、content、images 和选项；upload 按顺序逐张传入同一个 operation_id、image_index 和原图片来源；configure 首次填写完整页面，也可直接传入新的标题、正文、话题或选项；修改已准备内容时只改本次提供的字段，局部修改失败后重试保留原修改范围，未提供的保持原值，不重复上传图片；status 查询准备进度。准备完成后停下来请用户查看网页，明确报告尚未发布，也未主动保存草稿。图片支持 HTTP/HTTPS 地址、已授权工作区相对路径、vfs://workspace 和 vfs://assets；本地图片由 EO2 读取传递，Agent 不传入图片字节。已有页面内容不自动清空，已有图片数量另行报告；相同图片列表可通过 prepare 更新文字和选项，不重复上传已完成图片。UPLOAD_PENDING 时查询 status 等待预览。话题沿用前十项、首个建议及无建议时空格回退；商品沿用首个搜索结果，需要账号支持。选项返回请求值及实际观察值，未知报告 null，不冒充已设置成功。schedule_at 沿用带时区日期和一小时至十四天的初始范围。登录操作继续由用户完成，不新增登录工具。报告不输出完整图片签名地址、token 或图片字节。',
      inputSchema: { type: 'object', properties: {
        action: { type: 'string', enum: ['open', 'prepare', 'upload', 'configure', 'status'] },
        operation_id: { type: 'string', description: 'Associate the preparation steps; reuse when updating the same image list.' },
        title: { type: 'string', description: 'Upstream weighted title length <=20; preserved verbatim.' },
        content: { type: 'string', description: 'Full body with line breaks; put topics in tags.' },
        images: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Ordered image sources, required for prepare.' },
        tags: { type: 'array', items: { type: 'string' } },
        schedule_at: { type: 'string', description: 'RFC3339 timestamp with timezone, 1 hour to 14 days ahead.' },
        is_original: { type: 'boolean' },
        visibility: { type: 'string', enum: ['', '公开可见', '仅自己可见', '仅互关好友可见'] },
        products: { type: 'array', items: { type: 'string' } },
        image_index: { type: 'integer', minimum: 0 },
        image: { type: 'string', description: 'Exact source at image_index in prepare.images.' },
      }, required: ['action'] },
    },
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
      description: 'Read currently loaded search cards, cover images and exact-ID matched page-state user, interactInfo and video.capa fields. fields_scope identifies the state source. liked/collected are current account states; null means unknown, not false. visible_metrics are webpage counts and may differ from state counts. Missing fields are null. An empty list means the loaded page has no matching notes; it is not a timeout.' + FEED_FIELDS_DESCRIPTION,
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
      description: 'Read title, author, text, type, visible counts, loaded comments, imageList and video from the open note. title and body (upstream desc) preserve full strings and line breaks from exact current-note state, including explicit empty strings. Inspect title/body _scope, _complete, _truncated, _length and _returned_length; lengths are UTF-16 code units. DOM-only fallback retains 500/8000 limits and reports actual clipping; complete=null means the website may hide or collapse text, not proven complete. Do not call the entire note complete based on these text flags alone. Exact current-note state also supplies user, interactInfo, time, ipLocation and xsecToken; inspect fields_scope. liked/collected are current account states, null means unknown; state counts may differ from visible_metrics and time is returned unchanged. Video preserves all available encoding/quality streams and existing subtitle URLs from mediaV2; capability/meta duration is seconds and stream duration is milliseconds. Inspect image_list_scope/image_list_partial and video_scope/video_partial/subtitles_scope. URLs may expire and are not downloaded, transcribed or interpreted. Missing fields are null; null subtitles means unavailable, not proven absent. Keep full text and raw media in tool history and produce a brief summary, not the full returned body or every URL. NOTE_UNAVAILABLE includes site error details; do not infer an account restriction or risk-control cause from this error alone.',
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
      description: 'Read rendered comments with parent/reply relationships. Report top-level recipe_version to identify this executed tool implementation. Exact current-note/DOM comment IDs also supply upstream id, noteId, content, likeCount, createTime, ipLocation, liked, userInfo, subCommentCount and showTags. Inspect fields_scope/state_match; signature IDs are not server IDs and unknown fields are null. A likes_text label such as 赞 is not a numeric zero. subComments repeats only matched replies included in this return; inspect sub_comments_scope/sub_comments_partial and do not double-count nested/flat copies. cursor/hasMore refer to page-state parent pagination, not proof of all replies. Displayed total, loaded count and returned count are separate. Summarize at most 5 rows; keep raw results in tool history.',
      inputSchema: { type: 'object', properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum returned comments (default 20)' },
        include_replies: { type: 'boolean', description: 'Include currently rendered replies (default true)' },
      } },
    },
    {
      name: 'xhs_load_more_comments', title: 'Load more comments',
      description: 'Load more parent comments toward max_comment_items (cumulative parent target, upstream default 20), with optional reply expansion. limit only caps returned parent+reply rows; it never sets the loading target. When asked to expand collapsed replies pass expand_replies=true. Without max_comment_items this preserves expansion-only behavior; supply max_comment_items to combine upstream-style periodic expansion and scrolling. reply_limit defaults to 10: larger numbered reply controls are skipped, not errors. scroll_speed uses upstream slow/normal/fast ratios. Retries, max_rounds and a 50s budget bound each call. Inspect parent_target_reached, loading_partial, stop_reason and loading_policy; continue with the same target if a round/time limit prevented reaching it. Inspect reply_expansion.succeeded, added_reply_count and diagnostics; a click alone does not prove replies loaded. Missing/blocked controls or unobserved expansion in expansion-only mode return explicit errors, never substituted scrolling. cursor/hasMore describe parent pagination, not reply completeness. Nested subComments repeat returned flat replies; do not double-count. Summarize at most 5 rows; retain raw results in tool history.',
      inputSchema: { type: 'object', properties: {
        max_rounds: { type: 'integer', minimum: 1, maximum: 500, description: 'Loading attempt cap. Parent mode defaults to target*3 capped at 500, expansion-only defaults to 2. All calls yield progress within 50 seconds.' },
        expand_replies: { type: 'boolean', description: 'Expand replies (default false). True without max_comment_items is expansion-only; true with a parent target combines expansion and parent loading.' },
        max_comment_items: { type: 'integer', minimum: 0, description: 'Cumulative loaded parent-comment target, excluding replies (upstream default 20; 0 also uses 20). Supplying this enables parent loading even when expand_replies=true. Batches may overshoot; this is not a return limit.' },
        reply_limit: { type: 'integer', minimum: 0, description: 'Skip numbered reply buttons above this threshold (upstream default 10; 0 also uses 10). Expand-more buttons without a number remain eligible.' },
        scroll_speed: { type: 'string', enum: ['slow', 'normal', 'fast'], description: 'Upstream scroll amplitude profile (default normal).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum returned parent+reply rows (default 20), independent of the parent loading target.' },
      } },
    },
    {
      name: 'xhs_open_home', title: 'Open home feeds',
      description: 'Navigate this tab to the Xiaohongshu home discovery page. Call xhs_list_feeds after navigation.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'xhs_list_feeds', title: 'Read home feed cards',
      description: 'Read rendered home cards, cover images, complete source links and exact-ID matched page-state user, interactInfo and video.capa fields. Inspect fields_scope; liked/collected null means unknown, not false. State counts may differ from visible_metrics. Does not fetch an entire recommendation feed. Call xhs_open_note with a returned note_url to read a note.' + FEED_FIELDS_DESCRIPTION,
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum returned cards (default 10)' } } },
    },
    {
      name: 'xhs_open_profile', title: 'Open a user profile',
      description: 'Open a complete same-site user profile URL in this tab. Use author_profile_url returned by a note or card and keep all query parameters. Call xhs_read_profile after navigation.',
      inputSchema: { type: 'object', properties: { profile_url: { type: 'string', description: 'Complete HTTPS www.xiaohongshu.com/user/profile/{id} URL from the page' } }, required: ['profile_url'] },
    },
    {
      name: 'xhs_read_profile', title: 'Read the open profile',
      description: 'Read visible profile information, displayed counts and loaded cards of the selected tab. Also return upstream userBasicInfo (source user.userPageData.basicInfo: gender, ipLocation, desc, imageb, nickname, images, redId) and interactions (type/name/count string entries). Inspect profile_fields_scope, profile_state_match, profile_match_basis and profile_fields_partial: these state fields require a matching profile ID or matching visible redId plus nickname. Unknown state fields remain null; empty strings and gender=0 are retained, not guessed. Numeric gender is not translated to a label; counts remain original strings. Keep visible_metrics separate from interactions; rounding or update timing can differ. Cards include cover and exact-ID matched page-state user, interactInfo and video.capa. Inspect card fields_scope; liked/collected null means unknown, not false. Pending tab results cannot be read as the new tab. Summarize fields and URL presence; do not repeat complete signed image URLs or all cards.' + FEED_FIELDS_DESCRIPTION,
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
