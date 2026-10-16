import {
  HOST, clean, visible, loginState, result, error, searchCards, visibleEmptySearch,
  type ToolResult,
} from './xiaohongshu-page'

export const searchFilterValues = {
  sort_by: ['综合', '最新', '最多点赞', '最多评论', '最多收藏'],
  note_type: ['不限', '视频', '图文'],
  publish_time: ['不限', '一天内', '一周内', '半年内'],
  search_scope: ['不限', '已看过', '未看过', '已关注'],
  location: ['不限', '同城', '附近'],
} as const

type FilterKey = keyof typeof searchFilterValues
const labels: Record<FilterKey, string[]> = {
  sort_by: ['排序依据'], note_type: ['笔记类型'], publish_time: ['发布时间'],
  search_scope: ['搜索范围'], location: ['位置距离'],
}
interface FilterGroup {
  key: FilterKey
  label: string
  element: HTMLElement
  options: Array<{ value: string; selected: boolean | null; element: HTMLElement }>
}
type FilterOption = FilterGroup['options'][number]
const pause = () => new Promise((resolve) => setTimeout(resolve, 150))
let pendingRefresh: { pageUrl: string; before: string } | null = null

function guard(startUrl?: string): ToolResult | null {
  if (location.hostname !== HOST) return error('UNSUPPORTED_PAGE', 'Not on a supported Xiaohongshu page.')
  if (startUrl && location.href !== startUrl) return error('PAGE_CHANGED', 'The search page changed during the filter operation.')
  if (location.pathname !== '/search_result') return error('NOT_SEARCH_PAGE', 'Open a search result page first.')
  if (loginState() === 'logged_out') return error('LOGIN_REQUIRED', 'Sign in on this tab first.')
  return null
}

function selection(element: HTMLElement): boolean | null {
  for (const attr of ['aria-selected', 'aria-checked', 'data-selected']) {
    const value = element.getAttribute(attr)
    if (value === 'true') return true
    if (value === 'false') return false
  }
  if (Array.from(element.classList).some((name) => /^(active|selected|checked|is-active|is-selected)$/.test(name))) return true
  return null
}

function rendered(element: Element): element is HTMLElement {
  if (!visible(element)) return false
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor)
    if (ancestor.hidden || style.display === 'none' || style.visibility === 'hidden'
      || (style.opacity !== '' && Number(style.opacity) === 0)) return false
  }
  return true
}

type HitState = 'reachable' | 'blocked_or_clipped' | 'unavailable'

function hitState(element: HTMLElement): HitState {
  if (typeof document.elementFromPoint !== 'function') return 'unavailable'
  if (!rendered(element) || element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') return 'blocked_or_clipped'
  const rect = element.getBoundingClientRect()
  const width = document.documentElement.clientWidth || window.innerWidth
  const height = document.documentElement.clientHeight || window.innerHeight
  if (![rect.left, rect.top, rect.right, rect.bottom, width, height].every(Number.isFinite)
    || width <= 0 || height <= 0) return 'unavailable'
  let left = Math.max(0, rect.left)
  let top = Math.max(0, rect.top)
  let right = Math.min(width, rect.right)
  let bottom = Math.min(height, rect.bottom)
  // A rendered node may be outside the viewport or clipped by a scroll/animation wrapper.
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor)
    const bounds = ancestor.getBoundingClientRect()
    if (/^(hidden|clip|auto|scroll)$/.test(style.overflowX || style.overflow)) {
      left = Math.max(left, bounds.left); right = Math.min(right, bounds.right)
    }
    if (/^(hidden|clip|auto|scroll)$/.test(style.overflowY || style.overflow)) {
      top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom)
    }
  }
  if (right <= left || bottom <= top) return 'blocked_or_clipped'
  for (const xRatio of [0.5, 0.15, 0.85]) {
    for (const yRatio of [0.5, 0.15, 0.85]) {
      const hit = document.elementFromPoint(left + (right - left) * xRatio, top + (bottom - top) * yRatio)
      if (hit && (hit === element || element.contains(hit))) return 'reachable'
    }
  }
  return 'blocked_or_clipped'
}

function disambiguate(options: FilterOption[]): FilterOption[] {
  if (options.length < 2) return options
  const states = options.map((option) => hitState(option.element))
  const reachable = options.filter((_, index) => states[index] === 'reachable')
  // Select only with positive hit evidence and negative evidence for every other candidate.
  return reachable.length === 1 && !states.includes('unavailable') ? reachable : options
}

function rawOptions(group: HTMLElement): FilterOption[] {
  return Array.from(group.querySelectorAll('.tags')).filter(rendered)
    .filter((element) => element.closest('.filters') === group)
    .map((element) => ({ value: clean(element.innerText), selected: selection(element), element }))
    .filter((option) => option.value)
}

function canonicalOptions(group: HTMLElement): FilterOption[] {
  const raw = rawOptions(group)
  // A tag wrapper and its label can both match .tags. Merge only nodes of
  // the same value within one ancestor chain; independent controls stay ambiguous.
  const canonical = raw.filter((option) => !raw.some((ancestor) => ancestor !== option
    && ancestor.value === option.value && ancestor.element.contains(option.element)))
    .map((outer) => {
      const cluster = raw.filter((option) => option.value === outer.value && outer.element.contains(option.element))
      const evidence = new Set(cluster.map((option) => option.selected).filter((state) => state !== null))
      const controls = cluster.filter((option) => option.element.matches('button, [role="option"], [role="radio"]'))
      return {
        value: outer.value,
        selected: evidence.size === 1 ? Array.from(evidence)[0]! : null,
        element: controls.length === 1 ? controls[0].element : outer.element,
      }
    })
  return Array.from(new Set(canonical.map((option) => option.value)))
    .flatMap((value) => disambiguate(canonical.filter((option) => option.value === value)))
}

function optionDiagnostics(key: FilterKey, value: string) {
  return groups().filter((group) => group.key === key).map((group) => ({
    group: key,
    value,
    canonical_control_count: group.options.filter((option) => option.value === value).length,
    controls: group.options.filter((option) => option.value === value).map((option) => ({
      tag: option.element.tagName.toLowerCase(),
      classes: option.element.className.slice(0, 160),
      role: option.element.getAttribute('role'),
      hit_test: hitState(option.element),
      rect: (() => {
        const rect = option.element.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })(),
      parent_chain: (() => {
        const chain: Array<Record<string, unknown>> = []
        for (let parent = option.element.parentElement; parent && chain.length < 4; parent = parent.parentElement) {
          const style = getComputedStyle(parent)
          chain.push({ tag: parent.tagName.toLowerCase(), classes: parent.className.slice(0, 160),
            display: style.display, visibility: style.visibility, opacity: style.opacity,
            pointer_events: style.pointerEvents, overflow_x: style.overflowX, overflow_y: style.overflowY })
        }
        return chain
      })(),
      same_value_descendant_count: Array.from(option.element.querySelectorAll('.tags')).filter(rendered)
        .filter((element) => clean(element.innerText) === value).length,
    })),
  }))
}

function groups(): FilterGroup[] {
  const found: FilterGroup[] = []
  for (const panel of Array.from(document.querySelectorAll('.filter-panel')).filter(rendered)) {
    for (const element of Array.from(panel.querySelectorAll('.filters')).filter(rendered)) {
      const heading = Array.from(element.children).find((child) => child.tagName === 'SPAN' && visible(child))
      const label = heading ? clean((heading as HTMLElement).innerText) : ''
      const key = (Object.keys(labels) as FilterKey[]).find((candidate) => labels[candidate].includes(label))
      if (!key) continue
      const options = canonicalOptions(element)
      found.push({ key, label, element, options })
    }
  }
  return (Object.keys(labels) as FilterKey[]).flatMap((key) => {
    const matching = found.filter((group) => group.key === key)
    if (matching.length < 2) return matching
    const states = matching.map((group) => group.options.map((option) => hitState(option.element)))
    const reachable = matching.filter((_, index) => states[index].includes('reachable'))
    return reachable.length === 1 && states.every((state) => !state.includes('unavailable')) ? reachable : matching
  })
}

function snapshot() {
  return groups().map(({ key, label, options }) => ({
    key, label, options: options.map(({ value, selected }) => ({ value, selected })),
    selected_value: options.filter((option) => option.selected === true).length === 1
      ? options.find((option) => option.selected === true)!.value : null,
  }))
}

async function reveal(startUrl: string): Promise<ToolResult | null> {
  if (groups().length) return null
  const triggers = Array.from(document.querySelectorAll('div.filter')).filter(visible)
    .filter((element) => !element.closest('.note-item, .note-detail, .comments-container'))
  if (triggers.length !== 1) return error('FILTER_UI_UNAVAILABLE', 'No unique visible search filter control was found.')
  // Use the site's event handlers; never force a hidden panel to be visible.
  triggers[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  triggers[0].dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
  const deadline = Date.now() + 1800
  while (Date.now() < deadline) {
    const failure = guard(startUrl)
    if (failure) return failure
    if (groups().length) return null
    await pause()
  }
  return error('FILTER_UI_UNAVAILABLE', 'The filter panel did not become readable. Open it on the page and retry.')
}

function fingerprint(): string {
  return JSON.stringify({
    cards: searchCards().filter(visible).map((card) => ({
      urls: Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]')).map((link) => link.href),
    })),
    empty: visibleEmptySearch(),
  })
}

export async function waitForFilterResults(): Promise<ToolResult | null> {
  if (!pendingRefresh) return null
  if (pendingRefresh.pageUrl !== location.href) { pendingRefresh = null; return null }
  const startUrl = location.href
  const before = pendingRefresh.before
  const deadline = Date.now() + 3000
  let candidate: string | null = null
  let stableSince = 0
  while (Date.now() < deadline) {
    const failure = guard(startUrl)
    if (failure) return failure
    const loading = Array.from(document.querySelectorAll('.search-loading, .feeds-loading, .filter-loading, [aria-busy="true"]')).some(visible)
    const ready = searchCards().filter(visible).length > 0 || visibleEmptySearch()
    const current = fingerprint()
    if (!loading && ready && current !== before) {
      if (candidate !== current) { candidate = current; stableSince = Date.now() }
      if (Date.now() - stableSince >= 450) { pendingRefresh = null; return null }
    } else { candidate = null }
    await pause()
  }
  return error('FILTER_RESULTS_UNCONFIRMED', 'Filter controls changed, but a stable refreshed result list has not been observed. Do not attribute the previous cards to the new filters.')
}

function findOption(key: FilterKey, value: string) {
  const candidates = groups().filter((group) => group.key === key)
  if (candidates.length !== 1) return null
  const options = candidates[0].options.filter((option) => option.value === value)
  return options.length === 1 && hitState(options[0].element) === 'reachable' ? options[0] : null
}

export const xiaohongshuFilterTools: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  async xhs_get_search_filters() {
    const failure = guard()
    if (failure) return failure
    const unavailable = await reveal(location.href)
    if (unavailable) return unavailable
    const diagnostics = groups().flatMap((group) => Array.from(new Set(group.options.map((option) => option.value)))
      .filter((value) => group.options.filter((option) => option.value === value).length > 1)
      .flatMap((value) => optionDiagnostics(group.key, value)))
    return result('ok', { groups: snapshot(), results_scope: 'visible_filter_controls', option_diagnostics: diagnostics })
  },

  async xhs_apply_search_filters(args) {
    const failure = guard()
    if (failure) return failure
    if (!args.filters || typeof args.filters !== 'object' || Array.isArray(args.filters)) {
      return error('INVALID_FILTERS', 'filters must be an object with at least one supported filter.')
    }
    const requested = Object.entries(args.filters)
    if (!requested.length || requested.some(([key, value]) => !Object.hasOwn(searchFilterValues, key)
      || !(searchFilterValues[key as FilterKey] as readonly unknown[]).includes(value))) {
      return error('INVALID_FILTERS', 'Use the documented filter keys and exact supported values.')
    }
    const startUrl = location.href
    const unavailable = await reveal(startUrl)
    if (unavailable) return unavailable
    // Validate every requested control before changing any selection.
    for (const [key, value] of requested) {
      if (!findOption(key as FilterKey, value as string)) {
        return {
          ...error('FILTER_UNAVAILABLE', `No unique visible option exists for ${key}: ${value}.`),
          data: { groups: snapshot(), option_diagnostics: optionDiagnostics(key as FilterKey, value as string) },
        }
      }
    }
    const applied: string[] = []
    const fail = (response: ToolResult) => ({
      ...response, data: { requested: args.filters, applied_keys: applied, groups: snapshot(), selection_verified: false },
    })
    let changed = false
    let beforeLastChange = fingerprint()
    for (const [key, value] of requested) {
      const failure = guard(startUrl)
      if (failure) return fail(failure)
      const option = findOption(key as FilterKey, value as string)
      if (!option) return fail(error('FILTER_UI_UNAVAILABLE', 'The filter panel changed or closed during selection.'))
      if (option.selected !== true) {
        beforeLastChange = fingerprint()
        pendingRefresh = { pageUrl: startUrl, before: beforeLastChange }
        changed = true
        option.element.click()
        const deadline = Date.now() + 1500
        while (Date.now() < deadline) {
          const interrupted = guard(startUrl)
          if (interrupted) return fail(interrupted)
          if (findOption(key as FilterKey, value as string)?.selected === true) break
          await pause()
        }
      }
      if (findOption(key as FilterKey, value as string)?.selected !== true) {
        return fail(error('FILTER_SELECTION_UNVERIFIED', 'The page did not confirm the requested selection. Read the controls before retrying.'))
      }
      applied.push(key)
    }
    let refresh: 'observed' | 'unconfirmed' | 'not_requested' = changed ? 'unconfirmed' : 'not_requested'
    if (changed || pendingRefresh?.pageUrl === startUrl) {
      const refreshed = await waitForFilterResults()
      if (refreshed && refreshed.error_code !== 'FILTER_RESULTS_UNCONFIRMED') return fail(refreshed)
      refresh = refreshed ? 'unconfirmed' : 'observed'
    }
    if (requested.some(([key, value]) => findOption(key as FilterKey, value as string)?.selected !== true)) {
      return fail(error('FILTER_SELECTION_UNVERIFIED', 'The final control state no longer confirms every requested filter.'))
    }
    return {
      ...result('ok', { requested: args.filters, groups: snapshot(), selection_verified: true, results_refresh: refresh }),
      message: refresh === 'unconfirmed' ? 'Filter selections are confirmed; result refresh is unconfirmed. Do not claim the existing cards satisfy the new filters.' : null,
    }
  },
}
