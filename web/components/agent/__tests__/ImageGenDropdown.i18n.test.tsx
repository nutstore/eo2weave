import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ImageGenDropdown } from '../ImageGenDropdown'
import { useI18nStore } from '@/i18n/store'

/**
 * ImageGenDropdown — i18n wiring
 *
 * The popover used to hardcode Chinese copy (model-search placeholder, aspect-
 * ratio label, the "no matching model" message), leaking into every locale. Renders the
 * dropdown against the real translation table and fails if a key is missing.
 */

vi.mock('@earendil-works/pi-ai', () => ({
  getImageModels: () => [{ id: 'openai/gpt-5-image', name: 'GPT Image' }],
}))

vi.mock('@/agent/providers/model-store', () => ({
  getCachedModels: () => [{ id: 'openai/gpt-5-image' }],
  onModelsUpdated: () => () => {},
}))

vi.mock('@/store/settings.store', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      providerType: 'openai',
      imageGenModel: 'openai/gpt-5-image',
      setImageGenModel: vi.fn(),
      imageGenAspectRatio: '16:9',
      setImageGenAspectRatio: vi.fn(),
    }),
}))

vi.mock('@creatorweave/ui', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BrandButton: ({
    children,
    iconButton: _iconButton,
    variant: _variant,
    ...rest
  }: { children: ReactNode; iconButton?: boolean; variant?: string }) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
}))

const LOCALES = [
  { locale: 'en-US', search: 'Search models...', ratio: 'Aspect Ratio', model: 'Image model' },
  { locale: 'zh-CN', search: '搜索模型...', ratio: '宽高比', model: '图像模型' },
  { locale: 'ja-JP', search: 'モデルを検索...', ratio: 'アスペクト比', model: '画像モデル' },
  { locale: 'ko-KR', search: '모델 검색...', ratio: '가로세로 비율', model: '이미지 모델' },
] as const

describe('ImageGenDropdown i18n', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it.each(LOCALES)('renders localized copy for $locale', ({ locale, search, ratio, model }) => {
    useI18nStore.setState({ locale })

    render(<ImageGenDropdown compact />)

    expect(screen.getByPlaceholderText(search)).toBeTruthy()
    expect(screen.getByText(ratio)).toBeTruthy()
    // The icon-only trigger needs a meaningful accessible name.
    expect(screen.getByRole('button', { name: new RegExp(model) })).toBeTruthy()
    // No key should fall back to its raw identifier.
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
