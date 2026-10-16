import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolResult } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-page'

const origin = 'https://www.xiaohongshu.com'
const oldNoteId = '69e78d620000000021012b9b'
const newNoteId = '6abcd0b5000000001b01d831'
const stateWindow = window as Window & { __INITIAL_STATE__?: unknown }
let tools: typeof import('../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-filters').xiaohongshuFilterTools

const fixtures = [
  ['sort_by', '排序依据', ['综合', '最新', '最多点赞', '最多评论', '最多收藏']],
  ['note_type', '笔记类型', ['不限', '视频', '图文']],
  ['publish_time', '发布时间', ['不限', '一天内', '一周内', '半年内']],
  ['search_scope', '搜索范围', ['不限', '已看过', '未看过', '已关注']],
  ['location', '位置距离', ['不限', '同城', '附近']],
] as const

function setPage(path = '/search_result?keyword=test') {
  const url = new URL(path, origin)
  vi.stubGlobal('location', {
    href: url.href, origin: url.origin, hostname: url.hostname,
    pathname: url.pathname, search: url.search, assign: vi.fn(),
  })
}

function panelMarkup() {
  return fixtures.map(([key, label, options]) => `<div class="filters" data-group="${key}">
    <span>${label}</span>${options.map((option, index) => `<div class="tags" ${index === 0 ? 'aria-selected="true"' : ''}>${option}</div>`).join('')}
  </div>`).join('')
}

function renderFilters() {
  document.body.innerHTML = `<div class="filter">筛选</div><div class="filter-panel">${panelMarkup()}</div><div id="results"></div>`
  renderCard(oldNoteId, 'Old result')
}

function renderCard(id: string, title: string) {
  document.querySelector('#results')!.innerHTML = `<section class="note-item"><a href="${origin}/explore/${id}?xsec_token=example-token&xsec_source=pc_search">Cover</a><span class="title">${title}</span></section>`
}

function option(key: string, value: string): HTMLElement {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-group="${key}"] .tags`))
    .find((element) => element.innerText === value)!
}

function selectOnClick(key: string, value: string, afterClick?: () => void) {
  const target = option(key, value)
  const handler = vi.fn(() => {
    for (const sibling of target.parentElement!.querySelectorAll('.tags')) sibling.setAttribute('aria-selected', 'false')
    target.setAttribute('aria-selected', 'true')
    afterClick?.()
  })
  target.addEventListener('click', handler)
  return handler
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return await tools[name](args) as ToolResult
}

async function settle<T>(pending: Promise<T>, duration = 10000): Promise<T> {
  await vi.advanceTimersByTimeAsync(duration)
  return pending
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-30T08:00:00Z'))
  delete stateWindow.__INITIAL_STATE__
  setPage()
  // happy-dom has no layout; visibility still follows each element's CSS.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const index = Math.max(0, Array.from(document.querySelectorAll('.tags')).indexOf(this))
    return new DOMRect(10 + (index % 10) * 80, 10 + Math.floor(index / 10) * 40, 70, 28)
  })
  vi.spyOn(document, 'elementFromPoint').mockImplementation((x, y) => {
    return Array.from(document.querySelectorAll<HTMLElement>('.tags')).reverse().find((element) => {
      const rect = element.getBoundingClientRect()
      return x > rect.left && x < rect.right && y > rect.top && y < rect.bottom
    }) ?? null
  })
  renderFilters()
  tools = (await import('../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-filters')).xiaohongshuFilterTools
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete stateWindow.__INITIAL_STATE__
  document.body.innerHTML = ''
})

describe('Xiaohongshu search filter controls', () => {
  it('chooses the control actually hit by the page rather than the first overlapping DOM match', async () => {
    const target = option('sort_by', '最新')
    const shadow = target.cloneNode(true) as HTMLElement
    target.before(shadow)
    const rect = new DOMRect(100, 500, 80, 30)
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect)
    vi.spyOn(shadow, 'getBoundingClientRect').mockReturnValue(rect)
    const baselineHit = vi.mocked(document.elementFromPoint).getMockImplementation()!
    vi.mocked(document.elementFromPoint).mockImplementation((x, y) => y >= 500 && y <= 530 && x >= 100 && x <= 180 ? target : baselineHit(x, y))
    const wrongClick = vi.spyOn(shadow, 'click')
    const actualClick = vi.fn(() => {
      option('sort_by', '综合').setAttribute('aria-selected', 'false')
      target.setAttribute('aria-selected', 'true')
      renderCard(newNoteId, 'Filtered result')
    })
    target.addEventListener('click', actualClick)

    const response = await settle(call('xhs_apply_search_filters', { filters: { sort_by: '最新' } }))
    expect(response.data).toMatchObject({ selection_verified: true, results_refresh: 'observed' })
    expect(actualClick).toHaveBeenCalledOnce()
    expect(wrongClick).not.toHaveBeenCalled()
  })

  it('ignores offscreen copies when reading the selected value and clicking a filter', async () => {
    for (const value of ['综合', '最新']) {
      const target = option('sort_by', value)
      const copy = target.cloneNode(true) as HTMLElement
      target.after(copy)
      vi.spyOn(copy, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 2000, 70, 28))
    }
    const state = await call('xhs_get_search_filters')
    expect(state.data?.groups).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'sort_by', selected_value: '综合' })]))
    const handler = selectOnClick('sort_by', '最新', () => renderCard(newNoteId, 'New result'))
    const response = await settle(call('xhs_apply_search_filters', { filters: { sort_by: '最新' } }))
    expect(response.data?.selection_verified).toBe(true)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('excludes copies hidden by an opacity-zero ancestor', async () => {
    const target = option('sort_by', '最新')
    target.insertAdjacentHTML('afterend', '<div style="opacity:0"><div class="tags">最新</div></div>')
    const handler = selectOnClick('sort_by', '最新', () => renderCard(newNoteId, 'New result'))
    const response = await settle(call('xhs_apply_search_filters', { filters: { sort_by: '最新' } }))
    expect(response.data?.selection_verified).toBe(true)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('excludes copies completely clipped by an overflow container', async () => {
    const target = option('sort_by', '最新')
    const wrapper = document.createElement('div')
    wrapper.style.overflow = 'hidden'
    const copy = target.cloneNode(true) as HTMLElement
    wrapper.append(copy)
    target.after(wrapper)
    vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 500, 0, 0))
    vi.spyOn(copy, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 500, 70, 28))
    const handler = selectOnClick('sort_by', '最新', () => renderCard(newNoteId, 'New result'))
    const response = await settle(call('xhs_apply_search_filters', { filters: { sort_by: '最新' } }))
    expect(response.data?.selection_verified).toBe(true)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('recognizes one reachable group when another same-title group is offscreen', async () => {
    const original = document.querySelector('[data-group="sort_by"]')!
    const copy = original.cloneNode(true) as HTMLElement
    original.after(copy)
    for (const control of copy.querySelectorAll<HTMLElement>('.tags')) {
      vi.spyOn(control, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 2000, 70, 28))
    }
    const handler = selectOnClick('sort_by', '最新', () => renderCard(newNoteId, 'New result'))
    const response = await settle(call('xhs_apply_search_filters', { filters: { sort_by: '最新' } }))
    expect(response.data?.selection_verified).toBe(true)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('still rejects two independently reachable controls and reports geometry and parent styles', async () => {
    const target = option('sort_by', '最新')
    target.insertAdjacentHTML('afterend', '<div class="tags duplicate-copy">最新</div>')
    const clicked = vi.spyOn(HTMLElement.prototype, 'click')
    const state = await call('xhs_get_search_filters')
    expect(state.data?.option_diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      canonical_control_count: 2,
      controls: [expect.objectContaining({ hit_test: 'reachable', rect: expect.objectContaining({ width: 70 }), parent_chain: expect.any(Array) }),
        expect.objectContaining({ hit_test: 'reachable', classes: 'tags duplicate-copy' })],
    })]))
    const response = await call('xhs_apply_search_filters', { filters: { sort_by: '最新' } })
    expect(response.error_code).toBe('FILTER_UNAVAILABLE')
    expect(clicked).not.toHaveBeenCalled()
  })

  it('does not click a sole control covered by an unrelated overlay', async () => {
    const overlay = document.createElement('div')
    document.body.append(overlay)
    vi.mocked(document.elementFromPoint).mockReturnValue(overlay)
    const clicked = vi.spyOn(HTMLElement.prototype, 'click')
    const response = await call('xhs_apply_search_filters', { filters: { sort_by: '最新' } })
    expect(response.error_code).toBe('FILTER_UNAVAILABLE')
    expect(response.data?.option_diagnostics).toEqual([expect.objectContaining({ controls: [expect.objectContaining({ hit_test: 'blocked_or_clipped' })] })])
    expect(clicked).not.toHaveBeenCalled()
  })

  it('does not assume a click target when hit testing is unavailable', async () => {
    const originalHit = document.elementFromPoint
    ;(document as unknown as { elementFromPoint?: typeof originalHit }).elementFromPoint = undefined
    try {
      const clicked = vi.spyOn(HTMLElement.prototype, 'click')
      const response = await call('xhs_apply_search_filters', { filters: { sort_by: '最新' } })
      expect(response.error_code).toBe('FILTER_UNAVAILABLE')
      expect(response.data?.option_diagnostics).toEqual([expect.objectContaining({ controls: [expect.objectContaining({ hit_test: 'unavailable' })] })])
      expect(clicked).not.toHaveBeenCalled()
    } finally { document.elementFromPoint = originalHit }
  })

  it('returns a wrapper and same-value nested labels as a single selected option', async () => {
    for (const tag of Array.from(document.querySelectorAll<HTMLElement>('.filters > .tags'))) {
      const value = tag.innerText
      const selected = tag.getAttribute('aria-selected')
      tag.innerHTML = `<span class="tags" ${selected ? `aria-selected="${selected}"` : ''}>${value}</span>`
    }
    const response = await call('xhs_get_search_filters')
    expect(response.data?.groups).toEqual(fixtures.map(([key, label, options]) => ({
      key, label, selected_value: options[0],
      options: options.map((value, index) => ({ value, selected: index === 0 ? true : null })),
    })))
  })

  it('applies latest and image-text through canonical wrappers and observes refreshed cards', async () => {
    for (const [key, value] of [['sort_by', '最新'], ['note_type', '图文']]) {
      const wrapper = option(key, value)
      wrapper.innerHTML = `<div class="tags"><span class="tags">${value}</span></div>`
      wrapper.addEventListener('click', () => {
        for (const tag of wrapper.parentElement!.querySelectorAll('.tags')) tag.setAttribute('aria-selected', 'false')
        wrapper.setAttribute('aria-selected', 'true')
        for (const tag of wrapper.querySelectorAll('.tags')) tag.setAttribute('aria-selected', 'true')
        renderCard(key === 'sort_by' ? newNoteId : '6ac727db000000000a026c74', 'Filtered result')
      })
    }
    const clicked = vi.spyOn(HTMLElement.prototype, 'click')
    const response = await settle(call('xhs_apply_search_filters', { filters: { sort_by: '最新', note_type: '图文' } }))
    expect(response.status).toBe('ok')
    expect(response.data).toMatchObject({ selection_verified: true, results_refresh: 'observed' })
    expect(clicked).toHaveBeenCalledTimes(2)
    expect(response.data?.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'sort_by', selected_value: '最新' }),
      expect.objectContaining({ key: 'note_type', selected_value: '图文' }),
    ]))
  })

  it('reads a selected marker on the nested label without inventing a wrapper state', async () => {
    const wrapper = option('sort_by', '综合')
    wrapper.removeAttribute('aria-selected')
    wrapper.innerHTML = '<span class="tags active">综合</span>'
    const response = await call('xhs_get_search_filters')
    expect(response.data?.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'sort_by', selected_value: '综合' }),
    ]))
  })

  it('preserves unknown selection when wrapper and label evidence conflict', async () => {
    const wrapper = option('sort_by', '综合')
    wrapper.innerHTML = '<span class="tags" aria-selected="false">综合</span>'
    const response = await call('xhs_get_search_filters')
    expect(response.data?.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'sort_by', selected_value: null, options: expect.arrayContaining([{ value: '综合', selected: null }]) }),
    ]))
  })

  it('keeps independent same-value controls ambiguous and provides structural diagnostics', async () => {
    const target = option('sort_by', '最新')
    target.insertAdjacentHTML('afterend', '<span class="tags">最新</span>')
    const clicked = vi.spyOn(HTMLElement.prototype, 'click')
    const response = await call('xhs_apply_search_filters', { filters: { sort_by: '最新' } })
    expect(response.error_code).toBe('FILTER_UNAVAILABLE')
    expect(response.data?.option_diagnostics).toEqual([expect.objectContaining({ canonical_control_count: 2 })])
    expect(clicked).not.toHaveBeenCalled()
  })

  it('ignores nested labels inside a hidden wrapper', async () => {
    const target = option('sort_by', '最新')
    target.insertAdjacentHTML('afterend', '<div class="tags" style="display:none"><span class="tags">最新</span></div>')
    const handler = selectOnClick('sort_by', '最新')
    const response = await settle(call('xhs_apply_search_filters', { filters: { sort_by: '最新' } }))
    expect(response.data?.selection_verified).toBe(true)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('clicks a unique explicit option control inside a same-label wrapper', async () => {
    const target = option('sort_by', '最新')
    target.innerHTML = '<button class="tags" role="option">最新</button>'
    const button = target.querySelector('button')!
    const clicked = vi.fn(() => {
      option('sort_by', '综合').setAttribute('aria-selected', 'false')
      button.setAttribute('aria-selected', 'true')
      renderCard(newNoteId, 'New result')
    })
    button.addEventListener('click', clicked)
    const response = await settle(call('xhs_apply_search_filters', { filters: { sort_by: '最新' } }))
    expect(response.data?.selection_verified).toBe(true)
    expect(clicked).toHaveBeenCalledOnce()
  })

  it('discovers all five labeled groups without treating unmarked options as selected or unselected', async () => {
    option('sort_by', '综合').removeAttribute('aria-selected')
    option('note_type', '视频').setAttribute('aria-selected', 'false')
    const response = await call('xhs_get_search_filters')

    expect(response.status).toBe('ok')
    expect(response.data?.groups).toHaveLength(5)
    expect(response.data?.groups).toEqual(expect.arrayContaining(fixtures.map(([key, label]) => expect.objectContaining({ key, label }))))
    expect(response.data?.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'sort_by', selected_value: null, options: expect.arrayContaining([{ value: '最新', selected: null }]) }),
      expect.objectContaining({ key: 'note_type', selected_value: '不限', options: expect.arrayContaining([{ value: '视频', selected: false }]) }),
    ]))
  })

  it('reveals the panel through the site hover handler without clicking the filter button', async () => {
    const panel = document.querySelector<HTMLElement>('.filter-panel')!
    panel.style.display = 'none'
    const trigger = document.querySelector<HTMLElement>('.filter')!
    const clicked = vi.fn()
    const hovered = vi.fn(() => { panel.style.display = 'block' })
    trigger.addEventListener('click', clicked)
    trigger.addEventListener('mouseenter', hovered)

    const response = await call('xhs_get_search_filters')

    expect(response.status).toBe('ok')
    expect(hovered).toHaveBeenCalledOnce()
    expect(clicked).not.toHaveBeenCalled()
  })

  it.each([undefined, null, [], {}, { bogus: '最新' }, { sort_by: '最热门' }, { sort_by: '最新', note_type: 3 }])(
    'rejects invalid filter arguments before hovering or changing any control: %j', async (filters) => {
      const click = vi.spyOn(HTMLElement.prototype, 'click')
      const dispatch = vi.spyOn(document.querySelector('.filter')!, 'dispatchEvent')
      const response = await call('xhs_apply_search_filters', { filters })

      expect(response.error_code).toBe('INVALID_FILTERS')
      expect(click).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
    },
  )

  it('prevalidates all requested controls before applying an earlier valid selection', async () => {
    const clicked = selectOnClick('sort_by', '最新')
    option('location', '附近').remove()

    const response = await call('xhs_apply_search_filters', { filters: { sort_by: '最新', location: '附近' } })

    expect(response.error_code).toBe('FILTER_UNAVAILABLE')
    expect(clicked).not.toHaveBeenCalled()
    expect(option('sort_by', '综合').getAttribute('aria-selected')).toBe('true')
  })

  it('rejects duplicate visible groups instead of guessing which matching control to click', async () => {
    const group = document.querySelector('[data-group="sort_by"]')!
    group.parentElement!.append(group.cloneNode(true))
    const clicked = vi.spyOn(HTMLElement.prototype, 'click')

    const response = await call('xhs_apply_search_filters', { filters: { sort_by: '最新' } })

    expect(response.error_code).toBe('FILTER_UNAVAILABLE')
    expect(clicked).not.toHaveBeenCalled()
  })

  it('ignores hidden duplicate options and never matches text outside its labeled filter group', async () => {
    const target = option('sort_by', '最新')
    const hidden = target.cloneNode(true) as HTMLElement
    hidden.style.display = 'none'
    target.parentElement!.append(hidden)
    document.body.insertAdjacentHTML('beforeend', '<button class="tags">最新</button>')
    const outside = vi.spyOn(document.querySelector('button.tags') as HTMLElement, 'click')
    const clicked = selectOnClick('sort_by', '最新')

    const response = await settle(call('xhs_apply_search_filters', { filters: { sort_by: '最新' } }))

    expect(response.data?.selection_verified).toBe(true)
    expect(clicked).toHaveBeenCalledOnce()
    expect(outside).not.toHaveBeenCalled()
  })

  it('requires a selected marker after clicking before reporting a confirmed filter', async () => {
    const clicked = vi.spyOn(option('sort_by', '最新'), 'click')

    const response = await settle(call('xhs_apply_search_filters', { filters: { sort_by: '最新' } }))

    expect(clicked).toHaveBeenCalledOnce()
    expect(response.error_code).toBe('FILTER_SELECTION_UNVERIFIED')
    expect(response.data?.selection_verified).toBe(false)
  })

  it('keeps an unchanged card list unconfirmed even when the requested control is selected', async () => {
    selectOnClick('sort_by', '最新')

    const response = await settle(call('xhs_apply_search_filters', { filters: { sort_by: '最新' } }))

    expect(response.data).toMatchObject({ selection_verified: true, results_refresh: 'unconfirmed' })
  })

  it('blocks the integrated reader from returning old cards until filtered results refresh', async () => {
    selectOnClick('sort_by', '最新')
    await settle(call('xhs_apply_search_filters', { filters: { sort_by: '最新' } }))
    const integrated = (await import('../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-tools')).xiaohongshuToolImplementations
    const stale = await settle(integrated.xhs_list_search_results({ limit: 3 }) as Promise<ToolResult>)
    expect(stale.error_code).toBe('FILTER_RESULTS_UNCONFIRMED')
    expect(stale.data).toBeNull()

    renderCard(newNoteId, 'New result')
    const fresh = await settle(integrated.xhs_list_search_results({ limit: 3 }) as Promise<ToolResult>)
    expect(fresh.status).toBe('ok')
    expect(fresh.data?.items).toEqual([expect.objectContaining({ note_url: expect.stringContaining(newNoteId) })])
  })

  it('does not request a new refresh when every requested option is already selected', async () => {
    const clicked = vi.spyOn(HTMLElement.prototype, 'click')

    const response = await call('xhs_apply_search_filters', { filters: { sort_by: '综合', note_type: '不限' } })

    expect(response.data).toMatchObject({ selection_verified: true, results_refresh: 'not_requested' })
    expect(clicked).not.toHaveBeenCalled()
  })

  it('reports a result change only after new cards are stable, not during an intermediate empty list', async () => {
    selectOnClick('sort_by', '最新', () => {
      setTimeout(() => { document.querySelector('#results')!.innerHTML = '' }, 100)
      setTimeout(() => renderCard(newNoteId, 'New result'), 600)
    })
    let finished = false
    const pending = call('xhs_apply_search_filters', { filters: { sort_by: '最新' } }).then((response) => { finished = true; return response })

    await vi.advanceTimersByTimeAsync(300)
    expect(finished).toBe(false)
    const response = await settle(pending)

    expect(response.data).toMatchObject({ selection_verified: true, results_refresh: 'observed' })
  })

  it('stops if navigation interrupts result refresh instead of associating new-page cards with the filters', async () => {
    selectOnClick('sort_by', '最新', () => { setTimeout(() => setPage('/search_result?keyword=another'), 150) })

    const response = await settle(call('xhs_apply_search_filters', { filters: { sort_by: '最新' } }))

    expect(response.error_code).toBe('PAGE_CHANGED')
  })

  it('reports login required without clicking when the page exposes a login QR code', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="login-container"><img class="qrcode-img" src="data:image/png;base64,AA=="></div>')
    const clicked = vi.spyOn(HTMLElement.prototype, 'click')

    expect((await call('xhs_get_search_filters')).error_code).toBe('LOGIN_REQUIRED')
    expect((await call('xhs_apply_search_filters', { filters: { sort_by: '最新' } })).error_code).toBe('LOGIN_REQUIRED')
    expect(clicked).not.toHaveBeenCalled()
  })
})
