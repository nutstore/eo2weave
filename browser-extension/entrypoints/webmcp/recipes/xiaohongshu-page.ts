import { readCardCover, readNoteImages } from './xiaohongshu-media'
import type { CoverInfo } from './xiaohongshu-media'

type PageKind = 'home' | 'search' | 'note' | 'profile' | 'login' | 'unavailable' | 'unknown'
type LoginState = 'logged_in' | 'logged_out' | 'unknown'

interface ToolResult {
  status: 'ok' | 'navigated' | 'error'
  page_url: string
  page_kind: PageKind
  data: Record<string, unknown> | null
  target_url?: string
  error_code: string | null
  message: string | null
}

interface StateFeed {
  id?: string
  modelType?: string
  xsecToken?: string
  noteCard?: {
    type?: string
    displayTitle?: string
    user?: { nickname?: string; nickName?: string }
    interactInfo?: { likedCount?: string; commentCount?: string; collectedCount?: string }
    cover?: unknown
  }
}

interface StateNote {
  noteId?: string
  title?: string
  desc?: string
  type?: string
  time?: number
  user?: { nickname?: string; nickName?: string }
  interactInfo?: { likedCount?: string; commentCount?: string; collectedCount?: string }
  imageList?: unknown
}

const HOST = 'www.xiaohongshu.com'
const ERROR_SELECTOR = '.access-wrapper, .error-wrapper, .not-found-wrapper, .blocked-wrapper'
const NOTE_PATH = /^\/(?:explore|search_result|discovery\/item)\/([a-zA-Z0-9_-]{8,80})\/?$/

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function limited(value: unknown, max: number): string | null {
  const text = clean(value)
  return text ? text.slice(0, max) : null
}

function visible(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false
  const style = getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
}

function textAt(root: ParentNode, selectors: string, max = 4000): string | null {
  for (const selector of selectors.split(',')) {
    const element = root.querySelector(selector.trim())
    if (visible(element)) {
      const value = limited(element.innerText, max)
      if (value) return value
    }
  }
  return null
}

function isUnavailablePage(): boolean {
  return location.pathname === '/404' || Array.from(document.querySelectorAll(ERROR_SELECTOR)).some(visible)
}

function pageKind(): PageKind {
  if (location.hostname !== HOST) return 'unknown'
  if (isUnavailablePage()) return 'unavailable'
  if (NOTE_PATH.test(location.pathname)) return 'note'
  if (/^\/user\/profile\/[a-zA-Z0-9_-]{8,80}\/?$/.test(location.pathname)) return 'profile'
  if (location.pathname === '/search_result') return 'search'
  if (visible(document.querySelector('.login-container .qrcode-img'))) return 'login'
  if (location.pathname === '/' || location.pathname === '/explore') return 'home'
  return 'unknown'
}

function result(status: ToolResult['status'], data: Record<string, unknown> | null = null): ToolResult {
  return { status, page_url: location.href, page_kind: pageKind(), data, error_code: null, message: null }
}

function error(code: string, message: string): ToolResult {
  return { ...result('error'), error_code: code, message }
}

function unavailableNote(): ToolResult {
  const params = new URLSearchParams(location.search)
  return {
    ...error('NOTE_UNAVAILABLE', 'The site could not display this note. The page does not establish the cause.'),
    data: {
      site_error_code: params.get('error_code'),
      site_error_message: params.get('error_msg'),
    },
  }
}

function navigation(url: string, message: string, link?: HTMLAnchorElement): ToolResult {
  const response = {
    ...result('navigated', { navigation_method: link ? 'page_click' : 'url' }),
    target_url: url,
    message,
  }
  // Let the WebMCP relay deliver the response before a full-page navigation
  // tears down the page execution context.
  window.setTimeout(() => {
    if (link) {
      // Preserve the site's click handler and keep navigation in the bound tab.
      // If the card disappeared, leave the page intact for the next read to fail.
      if (!link.isConnected) return
      const previousTarget = link.getAttribute('target')
      const previousHref = link.getAttribute('href')
      link.setAttribute('target', '_self')
      link.setAttribute('href', url)
      try {
        link.click()
      } finally {
        if (previousTarget === null) link.removeAttribute('target')
        else link.setAttribute('target', previousTarget)
        if (previousHref === null) link.removeAttribute('href')
        else link.setAttribute('href', previousHref)
      }
    } else {
      location.assign(url)
    }
  }, 150)
  return response
}

function initialState(): Record<string, any> | null {
  const state = (window as Window & { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__
  return state && typeof state === 'object' ? state as Record<string, any> : null
}

function loginState(): LoginState {
  const state = initialState()
  const userInfo = state?.user?.userInfo?.value ?? state?.user?.userInfo?._value ?? state?.user?.userInfo
  if (userInfo && typeof userInfo === 'object') {
    if (userInfo.guest === true) return 'logged_out'
    if (userInfo.guest === false && (userInfo.userId || userInfo.user_id)) return 'logged_in'
  }
  if (visible(document.querySelector('.main-container .user .link-wrapper .channel'))) return 'logged_in'
  if (visible(document.querySelector('.login-container .qrcode-img'))) return 'logged_out'
  return 'unknown'
}

function loadedSearchFeeds(): StateFeed[] | null {
  const node = initialState()?.search?.feeds
  const feeds = node?.value ?? node?._value ?? node
  return Array.isArray(feeds) ? feeds.filter((feed): feed is StateFeed => feed?.modelType === 'note') : null
}

function currentNoteId(): string | null {
  return location.pathname.match(NOTE_PATH)?.[1] ?? null
}

function loadedStateNote(): StateNote | null {
  const id = currentNoteId()
  const detailMap = initialState()?.note?.noteDetailMap
  const note = id && detailMap && typeof detailMap === 'object' ? detailMap[id]?.note : null
  if (!note || typeof note !== 'object' || (note.noteId && note.noteId !== id)) return null
  return note as StateNote
}

function normalizedNoteUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 3000) return null
  try {
    const url = new URL(value, location.origin)
    if (url.protocol !== 'https:' || url.hostname !== HOST || url.port || url.username || url.password || !NOTE_PATH.test(url.pathname)) return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

function noteUrlFromFeed(feed: StateFeed, originalUrl?: string): string | null {
  if (!feed.id || !/^[a-zA-Z0-9_-]{8,80}$/.test(feed.id) || !feed.xsecToken) return null
  const url = new URL(originalUrl ?? `/explore/${feed.id}`, `https://${HOST}`)
  if (url.pathname.match(NOTE_PATH)?.[1] !== feed.id) return null
  url.searchParams.set('xsec_token', feed.xsecToken)
  if (!url.searchParams.has('xsec_source')) {
    url.searchParams.set('xsec_source', location.pathname === '/search_result' ? 'pc_search' : 'pc_feed')
  }
  return url.href
}

function hasAccessToken(url: string): boolean {
  return !!new URL(url).searchParams.get('xsec_token')
}

function searchCards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('section.note-item, .note-item')).filter(visible)
}

function resolveCardNote(card: HTMLElement, feeds: StateFeed[]) {
  const links = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]')).flatMap((element) => {
    const url = normalizedNoteUrl(element.href)
    return url ? [{ element, url, id: new URL(url).pathname.match(NOTE_PATH)![1] }] : []
  })
  const id = links[0]?.id
  const matchingLinks = links.filter((link) => link.id === id)
  // A card can contain a bare SEO link before its real interactive link.
  const selected = matchingLinks.find((link) => hasAccessToken(link.url) && visible(link.element))
    ?? matchingLinks.find((link) => hasAccessToken(link.url))
    ?? matchingLinks.find((link) => visible(link.element))
    ?? matchingLinks[0]
  // Never attach another note's token based on a similar title.
  const feed = id ? feeds.find((candidate) => candidate.id === id) : undefined
  let url = selected?.url ?? null
  if (url && !hasAccessToken(url) && feed) url = noteUrlFromFeed(feed, url) ?? url
  const clickable = matchingLinks.find((link) => visible(link.element) && hasAccessToken(link.url))
    ?? matchingLinks.find((link) => visible(link.element))
  return { id, url, feed, link: clickable?.element }
}

function metricText(root: ParentNode, selectors: string): string | null {
  const text = textAt(root, selectors, 40)
  return text && /\d/.test(text) ? text : null
}

interface SearchItem {
  index: number
  title: string | null
  author: string | null
  note_url: string | null
  note_type: string | null
  cover: CoverInfo | null
  visible_metrics: { likes_text: string | null }
  source: 'dom' | 'page_state_correlated_with_dom'
}

function domSearchItems(): SearchItem[] {
  const cards = searchCards()
  const feeds = loadedSearchFeeds() ?? []
  const items: SearchItem[] = []
  for (const card of cards) {
    const resolved = resolveCardNote(card, feeds)
    const title = textAt(card, '.title, .note-title, a.title', 300)
    const matched = resolved.feed
    const noteUrl = resolved.url
    if (!title && !noteUrl) continue
    items.push({
      index: items.length,
      title: title ?? limited(matched?.noteCard?.displayTitle, 300),
      author: textAt(card, '.author .name, .author, .user-name', 120),
      note_url: noteUrl,
      note_type: matched?.noteCard?.type ?? null,
      cover: readCardCover(card, matched?.noteCard?.cover),
      visible_metrics: { likes_text: metricText(card, '.like-wrapper .count, .like-wrapper, .like-count') },
      source: 'dom',
    })
  }
  return items
}

function correlatedStateItems(): SearchItem[] {
  const feeds = loadedSearchFeeds() ?? []
  const pageText = clean(document.body.innerText)
  const items: SearchItem[] = []
  for (const feed of feeds) {
    const title = clean(feed.noteCard?.displayTitle)
    if (!title || !pageText.includes(title.slice(0, Math.min(8, title.length)))) continue
    items.push({
      index: items.length,
      title,
      author: limited(feed.noteCard?.user?.nickname ?? feed.noteCard?.user?.nickName, 120),
      note_url: noteUrlFromFeed(feed),
      note_type: feed.noteCard?.type ?? null,
      cover: null,
      visible_metrics: { likes_text: null },
      source: 'page_state_correlated_with_dom',
    })
  }
  return items
}

function searchItems(): SearchItem[] {
  const dom = domSearchItems()
  return dom.length > 0 ? dom : correlatedStateItems()
}

function visibleEmptySearch(): boolean {
  const empty = document.querySelector('.search-empty, .empty-state, .no-result, .no-results')
  if (visible(empty)) return true
  const main = document.querySelector<HTMLElement>('#app, main')
  const text = visible(main) ? clean(main.innerText) : ''
  return /暂无搜索结果|没有找到相关内容|没有搜索到相关内容/.test(text)
}

async function waitForSearch(): Promise<'ready' | 'empty' | 'login' | 'timeout'> {
  const start = Date.now()
  let emptySince: number | null = null
  while (Date.now() - start < 12000) {
    if (loginState() === 'logged_out') return 'login'
    if (searchItems().length > 0) return 'ready'
    const feeds = loadedSearchFeeds()
    if ((visibleEmptySearch() || (feeds && feeds.length === 0)) && document.readyState === 'complete') {
      emptySince ??= Date.now()
      if (Date.now() - emptySince > 1800) return 'empty'
    } else {
      emptySince = null
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return 'timeout'
}

async function waitForNote(): Promise<'ready' | 'unavailable' | 'login' | 'timeout'> {
  const start = Date.now()
  while (Date.now() - start < 12000) {
    if (isUnavailablePage()) return 'unavailable'
    if (loginState() === 'logged_out') return 'login'
    const stateNote = loadedStateNote()
    const renderedText = document.body.innerText
    if (
      textAt(document, '#detail-title, .note-content .title, .note-scroller .title') ||
      visibleStateValue(stateNote?.title, renderedText, 500) ||
      visibleStateValue(stateNote?.desc, renderedText, 1000)
    ) return 'ready'
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return 'timeout'
}

function visibleStateValue(value: unknown, area: string, max: number): string | null {
  const text = limited(value, max)
  return text && clean(area).includes(text.slice(0, Math.min(10, text.length))) ? text : null
}

function readComments(): Array<{ author: string | null; text: string | null }> {
  return Array.from(document.querySelectorAll<HTMLElement>('.parent-comment'))
    .filter(visible)
    .slice(0, 10)
    .map((comment) => ({
      author: textAt(comment, '.user-name, .name', 120),
      text: textAt(comment, '.content, .comment-content', 1000),
    }))
    .filter((comment) => comment.text)
}

function readNote(): Record<string, unknown> {
  const state = loadedStateNote()
  const container = document.querySelector<HTMLElement>('.note-scroller, .note-detail, .note-content')
  const area = visible(container) ? container.innerText : document.body.innerText
  const body = textAt(document, '#detail-desc, .note-content .desc, .note-scroller .desc', 8000)
    ?? visibleStateValue(state?.desc, area, 8000)
  const title = textAt(document, '#detail-title, .note-content .title, .note-scroller .title', 500)
    ?? visibleStateValue(state?.title, area, 500)
  const stateAuthor = state?.user?.nickname ?? state?.user?.nickName
  const author = textAt(document, '.author-container .username, .author-container .name, .note-scroller .user-name', 120)
    ?? visibleStateValue(stateAuthor, area, 120)
  const authorProfileUrl = Array.from(document.querySelectorAll<HTMLAnchorElement>('.author-container a[href], .note-scroller .author a[href]'))
    .filter(visible).map((link) => {
      try {
        const url = new URL(link.href)
        return url.protocol === 'https:' && url.hostname === HOST && !url.port && !url.username && !url.password
          && /^\/user\/profile\/[a-zA-Z0-9_-]{8,80}\/?$/.test(url.pathname) ? url.href : null
      } catch { return null }
    }).find((url) => url !== null) ?? null
  const publishedAt = textAt(document, '.publish-time, .note-time, .bottom-container .date', 120)
  const metricsRoot = document.querySelector('.interact-container') ?? document
  const metrics = {
    likes_text: metricText(metricsRoot, '.like-wrapper .count, .like-wrapper .count-num, .like-count'),
    favorites_text: metricText(metricsRoot, '.collect-wrapper .count, .collect-wrapper .count-num, .collect-count'),
    comments_text: metricText(metricsRoot, '.chat-wrapper .count, .chat-wrapper .count-num, .comment-count'),
  }
  const noteType = state?.type ?? (document.querySelector('video') ? 'video' : null)
  const mediaRoot = document.querySelector('#noteContainer, .note-container, .note-detail') ?? document
  return {
    note_url: location.href,
    note_id: currentNoteId(),
    title,
    author,
    author_profile_url: authorProfileUrl,
    body,
    published_at: publishedAt,
    note_type: noteType,
    ...readNoteImages(state?.imageList, mediaRoot),
    visible_metrics: metrics,
    loaded_comments: readComments(),
    comments_scope: 'currently_loaded',
  }
}

export {
  HOST, NOTE_PATH, clean, limited, visible, textAt, isUnavailablePage, pageKind,
  result, error, unavailableNote, navigation, initialState, loginState,
  loadedSearchFeeds, currentNoteId, loadedStateNote, normalizedNoteUrl, noteUrlFromFeed,
  hasAccessToken, searchCards, resolveCardNote, metricText, domSearchItems, searchItems,
  visibleEmptySearch, waitForSearch, waitForNote, visibleStateValue, readComments, readNote,
}
export type { ToolResult, StateFeed, StateNote, SearchItem, PageKind, LoginState }
