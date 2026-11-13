/**
 * Tests for the inline iteration-limit stepper shown in the
 * iteration-limit hint bar (AssistantTurnBubble).
 *
 * The stepper lets the user raise/lower the max-iterations limit right where
 * the run stopped, without visiting the Settings page. It writes through the
 * same `setMaxIterations` setter the Settings page slider uses, so the next
 * "continue" automatically picks up the new value.
 *
 * Mocking note: the settings-store mock is a real zustand store (created
 * inside the hoisted vi.mock factory) so setter calls re-render subscribers —
 * the display value must update after a step/commit, which a plain mock
 * function would freeze.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantTurnBubble } from '../AssistantTurnBubble'
import { ConversationActionContext } from '../ConversationActionContext'
import type { Turn } from '../group-messages'

// ─── Reactive settings-store mock ─────────────────────────────

/** Holder written by the hoisted mock factory, read by the tests */
const settingsStoreHolder = vi.hoisted(() => ({
  current: null as null | {
    getState: () => { maxIterations: number }
    setState: (partial: { maxIterations: number }) => void
  },
}))

vi.mock('@/store/settings.store', async () => {
  const { create } = await import('zustand')
  const useSettingsStore = create<{
    maxIterations: number
    setMaxIterations: (value: number) => void
  }>()((set) => ({
    maxIterations: 20,
    setMaxIterations: (value) =>
      set({
        // Same clamp as the real setter
        maxIterations: value === 0 ? 0 : Math.max(1, Math.min(100, Math.round(value))),
      }),
  }))
  settingsStoreHolder.current = useSettingsStore
  return { useSettingsStore }
})

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}))

// ─── Fixtures ─────────────────────────────────────────────────────

function makeTurn(): Extract<Turn, { type: 'assistant' }> {
  return {
    type: 'assistant',
    messages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Partial work done',
        timestamp: 100,
      },
    ],
    timestamp: 100,
    totalUsage: null,
  }
}

const mockSendMessage = vi.fn()

function renderBubble() {
  return render(
    <ConversationActionContext.Provider
      value={{ setInput: vi.fn(), insertQuote: vi.fn(), sendMessage: mockSendMessage }}
    >
      <AssistantTurnBubble
        turn={makeTurn()}
        toolResults={new Map()}
        isProcessing={false}
        iterationLimitReached={20}
      />
    </ConversationActionContext.Provider>,
  )
}

// ─── Helpers ──────────────────────────────────────────────────

const valueButton = () => screen.getByRole('button', { name: 'settings.maxIterations' })
const unlimitedButton = () => screen.getByRole('button', { name: 'settings.maxIterationsUnlimited' })
const getStoreValue = () => settingsStoreHolder.current!.getState().maxIterations
const setStoreValue = (maxIterations: number) => settingsStoreHolder.current!.setState({ maxIterations })

beforeEach(() => {
  setStoreValue(20)
  mockSendMessage.mockClear()
})

describe('AssistantTurnBubble iteration-limit stepper', () => {
  it('shows the current limit next to the continue button', () => {
    renderBubble()
    expect(valueButton()).toHaveTextContent('20')
    expect(screen.getByRole('button', { name: 'conversation.iterationLimit.continue' })).toBeInTheDocument()
  })

  it('increments the limit by 5 with the + button', async () => {
    const user = userEvent.setup()
    renderBubble()
    await user.click(screen.getByRole('button', { name: 'conversation.iterationLimit.increase' }))
    // Store (same clamp as the real setter) now holds the raised value
    expect(getStoreValue()).toBe(25)
    expect(valueButton()).toHaveTextContent('25')
  })

  it('decrements the limit by 5 with the − button', async () => {
    const user = userEvent.setup()
    renderBubble()
    await user.click(screen.getByRole('button', { name: 'conversation.iterationLimit.decrease' }))
    expect(getStoreValue()).toBe(15)
    expect(valueButton()).toHaveTextContent('15')
  })

  it('disables − at the lower bound and + at the upper bound', () => {
    setStoreValue(1)
    const { unmount } = renderBubble()
    expect(screen.getByRole('button', { name: 'conversation.iterationLimit.decrease' })).toBeDisabled()
    unmount()

    setStoreValue(100)
    renderBubble()
    expect(screen.getByRole('button', { name: 'conversation.iterationLimit.increase' })).toBeDisabled()
  })

  it('toggles to unlimited (∞) and restores the previous finite value', async () => {
    const user = userEvent.setup()
    renderBubble()
    expect(unlimitedButton()).toHaveAttribute('aria-pressed', 'false')

    // On → 0 (unlimited); display flips to ∞, −/+ disabled
    await user.click(unlimitedButton())
    expect(getStoreValue()).toBe(0)
    expect(valueButton()).toHaveTextContent('∞')
    expect(unlimitedButton()).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'conversation.iterationLimit.decrease' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'conversation.iterationLimit.increase' })).toBeDisabled()

    // Off → restores the last finite value
    await user.click(unlimitedButton())
    expect(getStoreValue()).toBe(20)
    expect(valueButton()).toHaveTextContent('20')
  })

  it('commits a typed value on Enter and shows the new value', async () => {
    const user = userEvent.setup()
    renderBubble()
    await user.click(valueButton())

    const input = screen.getByLabelText('settings.maxIterations')
    await user.clear(input)
    await user.type(input, '50')
    await user.keyboard('{Enter}')

    expect(getStoreValue()).toBe(50)
    expect(valueButton()).toHaveTextContent('50')
  })

  it('clamps an out-of-range typed value via the setter', async () => {
    const user = userEvent.setup()
    renderBubble()
    await user.click(valueButton())

    const input = screen.getByLabelText('settings.maxIterations')
    await user.clear(input)
    await user.type(input, '9999')
    await user.keyboard('{Enter}')

    // The store clamp (mirroring settings.store) bounds the value
    expect(getStoreValue()).toBe(100)
    expect(valueButton()).toHaveTextContent('100')
  })

  it('discards garbage input instead of writing it to the store', async () => {
    const user = userEvent.setup()
    renderBubble()
    await user.click(valueButton())

    const input = screen.getByLabelText('settings.maxIterations')
    await user.clear(input)
    await user.type(input, 'abc')
    await user.keyboard('{Enter}')

    // Store untouched, back to display mode with the original value
    expect(getStoreValue()).toBe(20)
    expect(valueButton()).toHaveTextContent('20')
  })

  it('continues by sending a message (which reads the freshly raised limit)', async () => {
    const user = userEvent.setup()
    renderBubble()
    // Raise the limit first...
    await user.click(screen.getByRole('button', { name: 'conversation.iterationLimit.increase' }))
    // ...then continue
    await user.click(screen.getByRole('button', { name: 'conversation.iterationLimit.continue' }))
    expect(mockSendMessage).toHaveBeenCalledWith('继续', { consumePendingAssets: false })
    expect(getStoreValue()).toBe(25)
  })
})
