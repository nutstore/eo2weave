import {
  HOST, clean, visible, textAt, result, error, navigation, loginState,
  initialState, isUnavailablePage, searchCards, resolveCardNote, metricText,
} from './xiaohongshu-page'
import type { SearchItem, StateFeed } from './xiaohongshu-page'
import { readCardCover } from './xiaohongshu-media'
import { fieldRecord, readCardFields } from './xiaohongshu-fields'

const PROFILE_PATH = /^\/user\/profile\/([a-zA-Z0-9_-]{8,80})\/?$/
const EMPTY_SELECTORS = '.feeds-empty, .note-list-empty, .empty-notes, .empty-state, .empty-container, .no-note, .no-content, .feeds-container .empty, .note-list .empty'
const EMPTY_TEXT = /暂无笔记|暂无内容|暂无作品|还没有发布|还没有笔记|还没有内容|没有发布过|还没有收藏|还没有赞过/
const PROFILE_TABS = { notes: '笔记', favorites: '收藏', liked: '点赞' } as const
type ProfileTab = keyof typeof PROFILE_TABS
type ProfileCard = SearchItem & { author_profile_url: string | null }
let pendingProfileTab: {
  profileId: string
  tab: ProfileTab
  previousSignature: string
  observedSignature: string | null
  stableSince: number | null
} | null = null

function profileTabs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.reds-tab-item.sub-tab-list, .user-page [role="tab"], .user-profile [role="tab"]')).filter(visible)
}

function selectedProfileTab(): ProfileTab | null {
  for (const tab of profileTabs()) {
    if (tab.getAttribute('aria-selected') !== 'true' && !tab.classList.contains('active') && !tab.classList.contains('selected')) continue
    const label = clean(tab.innerText)
    const entry = Object.entries(PROFILE_TABS).find(([, text]) => text === label)
    if (entry) return entry[0] as ProfileTab
  }
  return null
}

function normalizedProfileUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 3000) return null
  if (/^https:\/\/[^/?#]*:\d+(?:[/?#]|$)/i.test(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== HOST || url.port || url.username || url.password || !PROFILE_PATH.test(url.pathname)) return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

function unwrap(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const ref = value as Record<string, unknown>
  return ref.value ?? ref._value ?? value
}

function loadedCardReferences(kind: 'feed' | 'profile'): StateFeed[] {
  const state = initialState()
  let feeds: unknown = kind === 'feed' ? unwrap(state?.feed?.feeds) : unwrap(state?.user?.notes)
  if (kind === 'profile' && Array.isArray(feeds)) {
    const active = unwrap(state?.user?.activeTab) as { index?: unknown; query?: unknown } | undefined
    const selected = selectedProfileTab()
    const expectedQuery = selected ? { notes: 'note', favorites: 'fav', liked: 'liked' }[selected] : null
    // Profile state stores a separate array for each tab. Never borrow another tab's cards.
    feeds = active && Number.isInteger(active.index) && expectedQuery === active.query ? feeds[Number(active.index)] : []
  }
  if (!Array.isArray(feeds)) return []
  return feeds.flatMap((feed) => {
    if (!feed || typeof feed !== 'object' || typeof feed.id !== 'string') return []
    if (feed.modelType && feed.modelType !== 'note') return []
    // State can repair access parameters for an exact visible card ID only.
    const noteCard = fieldRecord(feed.noteCard)
    return [{
      id: feed.id,
      xsecToken: typeof feed.xsecToken === 'string' ? feed.xsecToken : undefined,
      noteCard: noteCard ? {
        cover: noteCard?.cover,
        user: noteCard?.user as NonNullable<StateFeed['noteCard']>['user'],
        interactInfo: noteCard?.interactInfo as NonNullable<StateFeed['noteCard']>['interactInfo'],
        video: noteCard?.video,
      } : undefined,
    }]
  })
}

function visibleCards(kind: 'feed' | 'profile'): ProfileCard[] {
  const references = loadedCardReferences(kind)
  const items: ProfileCard[] = []
  const seen = new Set<string>()
  for (const card of searchCards()) {
    const resolved = resolveCardNote(card, references)
    if (!resolved.id || !resolved.url || seen.has(resolved.id)) continue
    seen.add(resolved.id)
    items.push({
      index: items.length,
      title: textAt(card, '.title, .note-title, a.title', 300),
      author: textAt(card, '.author .name, .author .author-name, .author .nickname, .user-name', 120),
      author_profile_url: Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]')).filter(visible)
        .map((link) => normalizedProfileUrl(link.href)).find((url) => url !== null) ?? null,
      note_url: resolved.url,
      note_type: Array.from(card.querySelectorAll('video, .play-icon, .video-icon')).some(visible) ? 'video' : null,
      cover: readCardCover(card, resolved.feed?.noteCard?.cover),
      ...readCardFields(resolved.feed?.noteCard),
      visible_metrics: { likes_text: metricText(card, '.like-wrapper .count, .like-wrapper .count-num, .like-count') },
      source: 'dom',
    })
  }
  return items
}

function visibleEmpty(root: ParentNode = document): boolean {
  return Array.from(root.querySelectorAll(EMPTY_SELECTORS)).some((element) => visible(element) && EMPTY_TEXT.test(clean(element.innerText)))
}

function resultsLoading(): boolean {
  return Array.from(document.querySelectorAll('.feeds-loading, .feeds-container .loading, .note-list .loading, .loading-wrapper, .user-page [aria-busy="true"], .user-profile [aria-busy="true"]')).some(visible)
}

function resultsSignature(): string {
  // Observe rendered results, not state-derived access parameters that may lag a tab change.
  return JSON.stringify({ cards: searchCards().map((card) => ({
    links: Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]')).map((link) => link.href),
    text: clean(card.innerText),
  })), empty: visibleEmpty() })
}

function pendingResultsReady(): boolean {
  if (!pendingProfileTab) return true
  const signature = resultsSignature()
  if (
    selectedProfileTab() !== pendingProfileTab.tab || resultsLoading() ||
    (visibleCards('profile').length === 0 && !visibleEmpty()) ||
    signature === pendingProfileTab.previousSignature
  ) {
    pendingProfileTab.observedSignature = null
    pendingProfileTab.stableSince = null
    return false
  }
  if (signature !== pendingProfileTab.observedSignature) {
    pendingProfileTab.observedSignature = signature
    pendingProfileTab.stableSince = Date.now()
  }
  if (pendingProfileTab.stableSince !== null && Date.now() - pendingProfileTab.stableSince >= 750) {
    pendingProfileTab = null
    return true
  }
  return false
}

function profileRoot(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('.user-page, .user-profile, .user-info-container, .user-info'))
    .find(visible) ?? null
}

function profileNickname(): string | null {
  const root = profileRoot()
  return textAt(root ?? document, '.user-nickname, .user-basic .nickname, .info-part .nickname, .user-info .nickname', 120)
}

function profileMetric(root: ParentNode, labels: string[]): string | null {
  const entries = Array.from(root.querySelectorAll('.user-interactions > *, .data-info > *, .user-stats > *, .interactions > *')).filter(visible)
  for (const entry of entries) {
    const label = textAt(entry, '.shows, .label, .name, .text, .count-label', 40)
    if (label && labels.includes(label)) return metricText(entry, '.count, .number, .value, .count-num')
    const content = clean(entry.innerText)
    for (const expected of labels) {
      const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const match = content.match(new RegExp(`^([0-9][0-9.,万亿千百wWkKmM+ ]*)\\s*${escaped}$`))
        ?? content.match(new RegExp(`^${escaped}\\s*([0-9][0-9.,万亿千百wWkKmM+ ]*)$`))
      if (match) return clean(match[1])
    }
  }
  return null
}

async function waitForCards(kind: 'feed' | 'profile'): Promise<'ready' | 'empty' | 'login' | 'unavailable' | 'timeout' | 'changed' | 'pending'> {
  const start = Date.now()
  const pageUrl = location.href
  let emptySince: number | null = null
  while (Date.now() - start < 10000) {
    if (location.href !== pageUrl) return 'changed'
    if (isUnavailablePage()) return 'unavailable'
    if (loginState() === 'logged_out') return 'login'
    const profileReady = kind === 'feed' || (!!profileNickname() && pendingResultsReady())
    if (resultsLoading()) {
      emptySince = null
      await new Promise((resolve) => setTimeout(resolve, 250))
      continue
    }
    if (profileReady && visibleCards(kind).length > 0) return 'ready'
    if (profileReady && visibleEmpty()) {
      emptySince ??= Date.now()
      if (Date.now() - emptySince >= 1000) return 'empty'
    } else {
      emptySince = null
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return kind === 'profile' && pendingProfileTab ? 'pending' : 'timeout'
}

function readLimit(value: unknown): number | null {
  const limit = value === undefined ? 10 : value
  if (typeof limit !== 'number') return null
  return Number.isInteger(limit) && limit >= 1 && limit <= 20 ? limit : null
}

function readinessError(readiness: string, kind: 'feed' | 'profile') {
  if (readiness === 'changed') return error('PAGE_CHANGED', 'The page changed while waiting. Read the current page again before continuing.')
  if (readiness === 'pending') return error('PROFILE_RESULTS_PENDING', 'The requested profile tab is selected, but a stable new result list has not been observed. Do not attribute the old cards to this tab.')
  if (readiness === 'login') return error('LOGIN_REQUIRED', 'Sign in on the current Xiaohongshu tab first.')
  if (readiness === 'unavailable') return error(kind === 'profile' ? 'PROFILE_UNAVAILABLE' : 'FEED_UNAVAILABLE', 'The site displays an unavailable page; it does not establish the cause.')
  if (readiness === 'timeout') return error('PAGE_TIMEOUT', 'The page did not expose readable cards or an explicit empty state. It may still be loading or its layout may have changed.')
  return null
}

export const xiaohongshuProfileTools: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  async xhs_open_home() {
    if (location.hostname !== HOST) return error('UNSUPPORTED_PAGE', 'Not on a supported Xiaohongshu page.')
    if (location.pathname === '/' || location.pathname === '/explore') return result('ok', { home_url: location.href })
    return navigation(`https://${HOST}/explore`, 'Home page navigation started in this tab. Call xhs_list_feeds next.')
  },

  async xhs_list_feeds(args) {
    if (location.hostname !== HOST) return error('UNSUPPORTED_PAGE', 'Not on a supported Xiaohongshu page.')
    if (isUnavailablePage()) return error('FEED_UNAVAILABLE', 'The site displays an unavailable page.')
    if (location.pathname !== '/' && location.pathname !== '/explore') return error('NOT_FEED_PAGE', 'Call xhs_open_home in this tab before listing home feed cards.')
    const limit = readLimit(args.limit)
    if (limit === null) return error('INVALID_LIMIT', 'limit must be an integer from 1 to 20.')
    const readiness = await waitForCards('feed')
    const failure = readinessError(readiness, 'feed')
    if (failure) return failure
    const items = visibleCards('feed')
    return result('ok', {
      items: items.slice(0, limit),
      loaded_count: items.length,
      returned_count: Math.min(items.length, limit),
      is_empty: readiness === 'empty',
      partial: items.length > limit,
      results_scope: 'currently_loaded',
    })
  },

  async xhs_open_profile(args) {
    if (location.hostname !== HOST) return error('UNSUPPORTED_PAGE', 'Not on a supported Xiaohongshu page.')
    const target = normalizedProfileUrl(args.profile_url)
    if (!target) return error('INVALID_TARGET', 'profile_url must be a complete HTTPS www.xiaohongshu.com/user/profile/{id} URL from the page.')
    const id = new URL(target).pathname.match(PROFILE_PATH)![1]
    if (location.pathname.match(PROFILE_PATH)?.[1] === id && !isUnavailablePage()) return result('ok', { profile_url: location.href, profile_id: id })
    const matches = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).flatMap((link) => {
      if (!visible(link)) return []
      const url = normalizedProfileUrl(link.href)
      return url && new URL(url).pathname.match(PROFILE_PATH)?.[1] === id ? [{ link, url }] : []
    })
    const selected = matches.find((match) => new URL(match.url).searchParams.get('xsec_token')) ?? matches[0]
    const url = new URL(target)
    if (selected) {
      for (const [key, value] of new URL(selected.url).searchParams) {
        if (!url.searchParams.has(key)) url.searchParams.set(key, value)
      }
    }
    return navigation(url.href, 'Profile navigation started in this tab. Call xhs_read_profile to verify the opened page.', selected?.link)
  },

  async xhs_read_profile(args) {
    if (location.hostname !== HOST) return error('UNSUPPORTED_PAGE', 'Not on a supported Xiaohongshu page.')
    if (isUnavailablePage()) return error('PROFILE_UNAVAILABLE', 'The site displays an unavailable profile page; it does not establish the cause.')
    const id = location.pathname.match(PROFILE_PATH)?.[1]
    if (!id) return error('NOT_PROFILE_PAGE', 'Call xhs_open_profile or manually open a user profile in this tab first.')
    if (pendingProfileTab && pendingProfileTab.profileId !== id) pendingProfileTab = null
    const limit = readLimit(args.limit)
    if (limit === null) return error('INVALID_LIMIT', 'limit must be an integer from 1 to 20.')
    const readiness = await waitForCards('profile')
    const failure = readinessError(readiness, 'profile')
    if (failure) return failure
    const root = profileRoot() ?? document
    const items = visibleCards('profile')
    return result('ok', {
      profile_url: location.href,
      profile_id: id,
      nickname: profileNickname(),
      description: textAt(root, '.user-desc, .user-description, .user-basic .desc, .info-part .desc', 2000),
      red_id_text: textAt(root, '.user-redId, .user-red-id, .red-id', 120),
      location_text: textAt(root, '.user-IP, .user-ip, .ip-location', 120),
      visible_metrics: {
        following_text: profileMetric(root, ['关注']),
        followers_text: profileMetric(root, ['粉丝']),
        likes_and_favorites_text: profileMetric(root, ['获赞与收藏']),
      },
      profile_tab: selectedProfileTab(),
      items: items.slice(0, limit),
      loaded_count: items.length,
      returned_count: Math.min(items.length, limit),
      is_empty: readiness === 'empty',
      partial: items.length > limit,
      results_scope: 'currently_loaded',
      profile_scope: 'visible_dom',
    })
  },

  async xhs_select_profile_tab(args) {
    if (location.hostname !== HOST) return error('UNSUPPORTED_PAGE', 'Not on a supported Xiaohongshu page.')
    if (isUnavailablePage()) return error('PROFILE_UNAVAILABLE', 'The site displays an unavailable profile page.')
    const profileId = location.pathname.match(PROFILE_PATH)?.[1]
    if (!profileId) return error('NOT_PROFILE_PAGE', 'Open a user profile in this tab before selecting its notes tab.')
    if (loginState() === 'logged_out') return error('LOGIN_REQUIRED', 'Sign in on the current Xiaohongshu tab first.')
    const tab = args.tab
    if (typeof tab !== 'string' || !Object.hasOwn(PROFILE_TABS, tab)) return error('INVALID_PROFILE_TAB', 'tab must be notes, favorites, or liked.')
    const target = profileTabs().find((element) => clean(element.innerText) === PROFILE_TABS[tab as ProfileTab])
    if (!target || target.getAttribute('aria-disabled') === 'true' || target.hasAttribute('disabled')) return error('PROFILE_TAB_UNAVAILABLE', 'The requested profile tab is not visibly available. It may be private or unsupported by this page.')
    if (selectedProfileTab() === tab) return result('ok', { profile_tab: tab, selection_verified: true, already_selected: true, results_refresh_observed: false, results_ready: !pendingProfileTab })
    pendingProfileTab = { profileId, tab: tab as ProfileTab, previousSignature: resultsSignature(), observedSignature: null, stableSince: null }
    target.click()
    const start = Date.now()
    let refreshed = false
    while (Date.now() - start < 3000) {
      if (location.hostname !== HOST || location.pathname.match(PROFILE_PATH)?.[1] !== profileId) {
        pendingProfileTab = null
        return error('PAGE_CHANGED', 'The profile changed while selecting a tab. Read the current page again.')
      }
      if (loginState() === 'logged_out') return error('LOGIN_REQUIRED', 'The site requires login to access this profile tab.')
      if (isUnavailablePage()) return error('PROFILE_UNAVAILABLE', 'The site could not display this profile tab.')
      refreshed = pendingResultsReady()
      if (selectedProfileTab() === tab && refreshed) break
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    if (selectedProfileTab() !== tab) {
      pendingProfileTab = null
      return error('PROFILE_TAB_NOT_APPLIED', 'The page did not confirm the requested tab selection.')
    }
    return result('ok', {
      profile_tab: tab,
      selection_verified: true,
      already_selected: false,
      results_refresh_observed: refreshed,
      results_ready: refreshed,
      message: refreshed ? 'The tab changed and stable results were observed. Call xhs_read_profile to read the visible cards.' : 'The tab is selected, but stable new results have not been observed. xhs_read_profile will wait for confirmed results; current cards may still belong to the previous tab.',
    })
  },
}
