import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { TextSelectionToolbar } from '../TextSelectionToolbar'

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn() },
}))

function Message({ onQuote }: { onQuote?: (lines: string[]) => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  return (
    <>
      <div ref={containerRef} data-testid="message">First line{'\n'}Second line</div>
      <TextSelectionToolbar containerRef={containerRef} onQuote={onQuote} />
    </>
  )
}

function selectMessage() {
  const range = document.createRange()
  range.selectNodeContents(screen.getByTestId('message'))
  range.getBoundingClientRect = () => new DOMRect(100, 100, 200, 40)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  fireEvent(document, new Event('selectionchange'))
}

function advanceTime(milliseconds: number) {
  act(() => vi.advanceTimersByTime(milliseconds))
}

const dismissActions = [
  ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
  ['scroll', () => fireEvent.scroll(window)],
  ['resize', () => fireEvent.resize(window)],
  ['outside pointerdown', () => fireEvent.pointerDown(document.body)],
] as const

describe('TextSelectionToolbar', () => {
  const writeText = vi.fn<(_: string) => Promise<void>>()

  beforeEach(() => {
    vi.useFakeTimers()
    writeText.mockReset().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  })

  afterEach(() => {
    cleanup()
    window.getSelection()?.removeAllRanges()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shows the menu and auto-copies the selection once it settles', async () => {
    render(<Message onQuote={vi.fn()} />)

    selectMessage()
    expect(screen.queryByRole('button', { name: 'common.copy' })).not.toBeInTheDocument()
    advanceTime(150)
    expect(screen.getByRole('button', { name: 'common.copy' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'common.quote' })).toBeInTheDocument()

    expect(writeText).not.toHaveBeenCalled()
    advanceTime(250)
    await act(async () => {})
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('First line\nSecond line')
    expect(toast.success).toHaveBeenCalledWith('common.copied', { duration: 1500 })
  })

  it('copies immediately when Copy is activated before the auto-copy debounce', async () => {
    render(<Message onQuote={vi.fn()} />)
    selectMessage()
    advanceTime(150)
    expect(writeText).not.toHaveBeenCalled()

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'common.copy' })))

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('First line\nSecond line')
    expect(screen.queryByRole('button', { name: 'common.copy' })).not.toBeInTheDocument()
    await act(async () => vi.advanceTimersByTime(1000))
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('cancels the pending auto-copy when the selection collapses', async () => {
    render(<Message onQuote={vi.fn()} />)
    selectMessage()
    advanceTime(100)

    window.getSelection()!.removeAllRanges()
    fireEvent(document, new Event('selectionchange'))
    advanceTime(1000)
    await act(async () => {})

    expect(writeText).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'common.copy' })).not.toBeInTheDocument()
  })

  it('preserves selection while aiming at Quote and clears it before invoking onQuote', () => {
    const onQuote = vi.fn(() => {
      expect(window.getSelection()?.isCollapsed).toBe(true)
    })
    render(<Message onQuote={onQuote} />)
    selectMessage()
    advanceTime(150)

    const quoteButton = screen.getByRole('button', { name: 'common.quote' })
    fireEvent.pointerDown(quoteButton)
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    fireEvent(quoteButton, mouseDown)
    expect(mouseDown.defaultPrevented).toBe(true)
    expect(window.getSelection()?.toString()).toBe('First line\nSecond line')
    fireEvent.click(quoteButton)

    expect(onQuote).toHaveBeenCalledTimes(1)
    expect(onQuote).toHaveBeenCalledWith(['First line', 'Second line'])
    expect(screen.queryByRole('button', { name: 'common.quote' })).not.toBeInTheDocument()
    advanceTime(1000)
    expect(writeText).not.toHaveBeenCalled()
  })

  it.each(dismissActions)('cancels the pending menu on %s while keeping auto-copy', async (_name, dismiss) => {
    render(<Message onQuote={vi.fn()} />)
    selectMessage()
    advanceTime(100)

    dismiss()
    advanceTime(1000)
    await act(async () => {})

    expect(screen.queryByRole('button', { name: 'common.copy' })).not.toBeInTheDocument()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('First line\nSecond line')
  })

  it.each(dismissActions)('dismisses the visible menu on %s while keeping auto-copy', async (_name, dismiss) => {
    render(<Message onQuote={vi.fn()} />)
    selectMessage()
    advanceTime(150)
    expect(screen.getByRole('button', { name: 'common.copy' })).toBeInTheDocument()

    dismiss()
    advanceTime(1000)
    await act(async () => {})

    expect(screen.queryByRole('button', { name: 'common.copy' })).not.toBeInTheDocument()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('First line\nSecond line')
  })
})
