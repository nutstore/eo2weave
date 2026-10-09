import {
  HOST, NOTE_PATH, clean, loginState, result, error, navigation, waitForSearch,
  searchItems, normalizedNoteUrl, pageKind, currentNoteId, loadedSearchFeeds,
  searchCards, resolveCardNote, hasAccessToken, isUnavailablePage, unavailableNote,
  waitForNote, readNote,
} from './xiaohongshu-page'
import { xiaohongshuFilterTools, waitForFilterResults } from './xiaohongshu-filters'
import { xiaohongshuCommentTools } from './xiaohongshu-comments'
import { xiaohongshuProfileTools } from './xiaohongshu-profile'
import { xiaohongshuSessionTools } from './xiaohongshu-session'
import { readListWindow } from './xiaohongshu-feed-fields'
import { xiaohongshuPublishTools } from './xiaohongshu-publish'

export const xiaohongshuToolImplementations: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  ...xiaohongshuFilterTools,
  ...xiaohongshuCommentTools,
  ...xiaohongshuProfileTools,
  ...xiaohongshuSessionTools,
  ...xiaohongshuPublishTools,
  async xhs_check_login() {
    if (location.hostname !== HOST) return error('UNSUPPORTED_PAGE', 'Not on a supported Xiaohongshu page.')
    return result('ok', { login_state: loginState() })
  },

  async xhs_search_notes(args) {
    if (location.hostname !== HOST) return error('UNSUPPORTED_PAGE', 'Not on a supported Xiaohongshu page.')
    const keyword = clean(args.keyword)
    if (!keyword || keyword.length > 100) return error('INVALID_KEYWORD', 'keyword must contain 1-100 characters.')
    if (loginState() === 'logged_out') return error('LOGIN_REQUIRED', 'Sign in on the current Xiaohongshu tab first.')
    const url = new URL('/search_result', `https://${HOST}`)
    url.searchParams.set('keyword', keyword)
    url.searchParams.set('source', 'web_explore_feed')
    if (location.pathname === url.pathname && new URLSearchParams(location.search).get('keyword') === keyword) {
      return result('ok', { keyword, search_url: location.href })
    }
    return navigation(url.href, 'Search page navigation started. Call xhs_list_search_results on this tab next.')
  },

  async xhs_list_search_results(args) {
    if (location.hostname !== HOST) return error('UNSUPPORTED_PAGE', 'Not on a supported Xiaohongshu page.')
    if (location.pathname !== '/search_result') return error('NOT_SEARCH_PAGE', 'Open a Xiaohongshu search result page first.')
    const limit = args.limit === undefined ? 10 : Number(args.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return error('INVALID_LIMIT', 'limit must be an integer from 1 to 20.')
    const filterFailure = await waitForFilterResults()
    if (filterFailure) return filterFailure
    const readiness = await waitForSearch()
    if (readiness === 'login') return error('LOGIN_REQUIRED', 'Sign in on the current Xiaohongshu tab first.')
    if (readiness === 'timeout') return error('PAGE_TIMEOUT', 'Search results did not reach a recognizable loaded state.')
    const items = searchItems()
    return result('ok', {
      keyword: new URLSearchParams(location.search).get('keyword'),
      ...readListWindow(items, limit),
      is_empty: items.length === 0,
    })
  },

  async xhs_open_note(args) {
    if (location.hostname !== HOST) return error('UNSUPPORTED_PAGE', 'Not on a supported Xiaohongshu page.')
    let url = normalizedNoteUrl(args.note_url)
    if (!url) return error('INVALID_TARGET', 'note_url must be a Xiaohongshu note URL from the search results.')
    const noteId = new URL(url).pathname.match(NOTE_PATH)![1]
    if (pageKind() === 'note' && currentNoteId() === noteId) return result('ok', { note_url: location.href })
    if (location.pathname === '/search_result') {
      const filterFailure = await waitForFilterResults()
      if (filterFailure) return filterFailure
      const known = searchItems().find((item) => item.note_url && new URL(item.note_url).pathname.match(NOTE_PATH)?.[1] === noteId)
      if (!known) return error('STALE_RESULT', 'The target note is not in the currently loaded search results. Read the results again.')
      url = known.note_url!
      const feeds = loadedSearchFeeds() ?? []
      const card = searchCards().map((element) => resolveCardNote(element, feeds)).find((item) => item.id === noteId)
      if (card?.link) {
        return navigation(url, 'Note card click scheduled in this tab. Call xhs_read_current_note to verify the opened page.', card.link)
      }
    }
    if ((pageKind() === 'home' || pageKind() === 'profile')
      && searchCards().some((element) => resolveCardNote(element, []).id === noteId)) {
      const reader = pageKind() === 'profile' ? xiaohongshuProfileTools.xhs_read_profile : xiaohongshuProfileTools.xhs_list_feeds
      const loaded = await reader({ limit: 20 }) as { status: string; error_code: string | null }
      if (loaded.status !== 'ok') return loaded
      const card = searchCards().map((element) => resolveCardNote(element, [])).find((item) => item.id === noteId)
      if (!card?.link) return error('STALE_RESULT', 'The target card is no longer rendered on this page. Read the current list again.')
      // Prefer the card's full access URL; retain the supplied exact-ID token if its DOM link is bare.
      const target = card.url && hasAccessToken(card.url) ? card.url : url
      return navigation(target, 'Note card click scheduled in this tab. Call xhs_read_current_note to verify the opened page.', card.link)
    }
    if (!hasAccessToken(url)) {
      return error('NOTE_LINK_INCOMPLETE', 'This note URL has no access parameters and no current search card can be clicked. Search again and open its card, or open the note manually before reading.')
    }
    return navigation(url, 'Note navigation started. Call xhs_read_current_note on this tab next.')
  },

  async xhs_read_current_note() {
    if (location.hostname !== HOST) return error('UNSUPPORTED_PAGE', 'Not on a supported Xiaohongshu page.')
    if (isUnavailablePage()) return unavailableNote()
    if (!currentNoteId()) return error('NOT_NOTE_PAGE', 'Open a Xiaohongshu note first.')
    const readiness = await waitForNote()
    if (readiness === 'unavailable') return unavailableNote()
    if (readiness === 'login') return error('LOGIN_REQUIRED', 'Sign in on the current Xiaohongshu tab first.')
    if (readiness === 'timeout') return error('PAGE_TIMEOUT', 'The note did not reach a recognizable loaded state.')
    const data = readNote()
    const hasImages = Array.isArray(data.imageList) && data.imageList.length > 0
    if (!data.title && !data.body && !hasImages && !data.video) return error('NOTE_UNAVAILABLE', 'The note loaded, but no readable title, body or note media could be obtained.')
    return result('ok', data)
  },
}
