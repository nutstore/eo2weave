import { afterEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { createPackageSearch } from '../package-search'

function setup() {
  const win = new Window()
  const doc = win.document as unknown as Document
  doc.body.innerHTML = '<input type="search"><button type="button"></button><p role="status"></p><div id="rows"></div>'
  const input = doc.querySelector('input')!
  const clear = doc.querySelector('button')!
  const status = doc.querySelector('p')!
  const host = doc.querySelector('#rows')!
  const format = vi.fn((matched: number, total: number, unknown = 0) => unknown
    ? `${matched}/${total}, incomplete: ${unknown}`
    : matched ? `${matched}/${total}` : `No results (0/${total})`)
  const search = createPackageSearch(input, clear, status, format)
  return {
    input, clear, status, host, search, format,
    row(fields: string[], toolsKnown = true) {
      const row = doc.createElement('div')
      search.update(row, fields, toolsKnown)
      host.append(row)
      return row
    },
    async query(value: string) {
      input.value = value
      input.dispatchEvent(new win.Event('input') as unknown as Event)
      await Promise.resolve()
    },
    async escape() {
      input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }) as unknown as Event)
      await Promise.resolve()
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('package search controller', () => {
  it('matches normalized package fields and tool names while preserving row identity', async () => {
    const h = setup()
    const builtin = h.row(['builtin.alpha', 'Garden helper', 'run', 'hidden_export'])
    const registry = h.row(['registry.alpha', 'Remote package', 'remote_export'])
    const mine = h.row(['mine.notes', 'Personal garden', 'write'])
    await h.query('  ALPHA  ')
    expect([builtin.hidden, registry.hidden, mine.hidden]).toEqual([false, false, true])
    expect(h.status.textContent).toBe('2/3')
    await h.query('GARDEN')
    expect([builtin.hidden, registry.hidden, mine.hidden]).toEqual([false, true, false])
    await h.query('hidden_export')
    expect([builtin.hidden, registry.hidden, mine.hidden]).toEqual([false, true, true])
    expect([...h.host.children]).toEqual([builtin, registry, mine])
    expect(builtin.dataset.packageSearchRow).toBe('')
  })

  it('shows no-results feedback and clears the query with the button or Escape', async () => {
    const h = setup()
    const row = h.row(['alpha'])
    await Promise.resolve()
    expect(h.clear.hidden).toBe(true)
    expect(h.status.hidden).toBe(false)
    expect(h.status.textContent).toBe('')
    await h.query('missing')
    expect(row.hidden).toBe(true)
    expect(h.clear.hidden).toBe(false)
    expect(h.status.hidden).toBe(false)
    expect(h.status.textContent).toBe('No results (0/1)')
    h.clear.click()
    await Promise.resolve()
    expect(h.input.value).toBe('')
    expect(row.hidden).toBe(false)
    expect(h.clear.hidden).toBe(true)
    expect(h.status.hidden).toBe(false)
    expect(h.status.textContent).toBe('')
    expect(h.input.ownerDocument.activeElement).toBe(h.input)
    await h.query('missing')
    await h.escape()
    expect(h.input.value).toBe('')
    expect(row.hidden).toBe(false)
  })

  it('applies the current query to arriving rows and preview updates', async () => {
    const h = setup()
    await h.query('late_tool')
    const row = h.row(['registry.alpha', 'Remote package'])
    expect(row.hidden).toBe(true)
    await Promise.resolve()
    h.search.update(row, ['registry.alpha', 'Remote package', 'late_tool'])
    expect(row.hidden).toBe(false)
    await Promise.resolve()
    expect(h.status.textContent).toBe('1/1')
    expect(h.input.value).toBe('late_tool')
  })

  it('reports incomplete results until unknown tool metadata is verified', async () => {
    const h = setup()
    const row = h.row(['registry.alpha'], false)
    await h.query('missing_tool')
    expect(row.hidden).toBe(true)
    expect(h.status.textContent).toBe('0/1, incomplete: 1')
    h.search.update(row, ['registry.alpha', 'other_tool'])
    await Promise.resolve()
    expect(h.status.textContent).toBe('No results (0/1)')
  })

  it('coalesces result counts and discards replaced rows while retaining the query', async () => {
    const h = setup()
    h.row(['old.alpha'])
    await h.query('alpha')
    h.format.mockClear()
    h.host.replaceChildren()
    const alpha = h.row(['new.alpha'])
    const beta = h.row(['new.beta'])
    expect(alpha.hidden).toBe(false)
    expect(beta.hidden).toBe(true)
    await Promise.resolve()
    expect(h.format).toHaveBeenCalledTimes(1)
    expect(h.status.textContent).toBe('1/2')
    expect(h.input.value).toBe('alpha')
    h.host.replaceChildren()
    await h.query('alpha')
    expect(h.status.textContent).toBe('No results (0/0)')
  })
})
