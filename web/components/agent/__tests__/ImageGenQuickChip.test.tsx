/**
 * ImageGenQuickChip behavior tests — image-generation PRD v1.2+, R2.1.
 *
 * Contract under test (decided 2026-09-10: "strict hide"):
 *   1. Shares the generate_image availability gate (isImageGenAvailable) —
 *      when the provider cannot generate images the chip renders NOTHING.
 *   2. Click pre-fills the example prompt via onPrefill; never generates.
 *   3. Dismiss persists through workspace preferences (close and remember).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ImageGenQuickChip } from '../ImageGenQuickChip'

const { isImageGenAvailableMock, onModelsUpdatedMock, setImageGenChipDismissedMock } = vi.hoisted(() => ({
  isImageGenAvailableMock: vi.fn((): boolean => true),
  onModelsUpdatedMock: vi.fn(() => () => {}),
  setImageGenChipDismissedMock: vi.fn(),
}))

vi.mock('@/agent/tools/image-gen.tool', () => ({
  isImageGenAvailable: isImageGenAvailableMock,
}))

vi.mock('@/agent/providers/model-store', () => ({
  onModelsUpdated: onModelsUpdatedMock,
}))

vi.mock('@/store/settings.store', () => ({
  useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ imageGenModel: 'test/image-model', providerType: 'openrouter' }),
}))

vi.mock('@/store/workspace-preferences.store', () => ({
  useWorkspacePreferencesStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ imageGenChipDismissed: false, setImageGenChipDismissed: setImageGenChipDismissedMock }),
}))

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
}))

describe('ImageGenQuickChip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders and pre-fills the example prompt on click (never generates directly)', () => {
    isImageGenAvailableMock.mockReturnValue(true)
    const onPrefill = vi.fn()
    render(<ImageGenQuickChip onPrefill={onPrefill} />)

    const trigger = screen.getByRole('button', { name: 'conversation.imageGen.quickChip.label' })
    fireEvent.click(trigger)

    expect(onPrefill).toHaveBeenCalledTimes(1)
    expect(onPrefill).toHaveBeenCalledWith('conversation.imageGen.quickChip.examplePrompt')
    // Dismiss untouched.
    expect(setImageGenChipDismissedMock).not.toHaveBeenCalled()
  })

  it('renders NOTHING when isImageGenAvailable() is false (strict-hide gate)', () => {
    isImageGenAvailableMock.mockReturnValue(false)
    const onPrefill = vi.fn()
    const { container } = render(<ImageGenQuickChip onPrefill={onPrefill} />)

    expect(container).toBeEmptyDOMElement()
    // No stray buttons — nothing clickable that the product cannot honor.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('dismiss click persists via setImageGenChipDismissed(true)', () => {
    isImageGenAvailableMock.mockReturnValue(true)
    render(<ImageGenQuickChip onPrefill={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'conversation.imageGen.quickChip.dismissLabel' }))

    expect(setImageGenChipDismissedMock).toHaveBeenCalledWith(true)
  })
})
