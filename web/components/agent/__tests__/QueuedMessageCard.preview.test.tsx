/**
 * QueuedMessageCard — attachment preview.
 *
 * Bug: images attached to a message queued while the agent was busy rendered as
 * a static thumbnail with no way to open them. The chip must now open the
 * shared Lightbox (images) or delegate to the FilePreview drawer (other files).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AssetMeta } from '@/types/asset'
import { QueuedMessageCard } from '../QueuedMessageCard'

const readAssetBlob = vi.fn()

vi.mock('@/i18n', () => ({ useT: () => (key: string) => key }))

vi.mock('../asset-utils', () => ({
  readAssetBlob: (...args: unknown[]) => readAssetBlob(...args),
  downloadAssetBlob: vi.fn(async () => undefined),
}))

vi.mock('@/services/asset.service', () => ({
  writePendingAssetsToOPFS: vi.fn(async () => []),
}))

vi.mock('@/store/workspace.store', () => ({
  useWorkspaceStore: {
    getState: () => ({
      activeWorkspaceId: 'conv-1',
      switchWorkspace: vi.fn(async () => undefined),
    }),
  },
}))

function makeAsset(overrides: Partial<AssetMeta> = {}): AssetMeta {
  return {
    id: 'a1',
    name: 'photo.png',
    size: 2048,
    mimeType: 'image/png',
    direction: 'upload',
    createdAt: 1700000000000,
    ...overrides,
  }
}

const noop = () => undefined

function renderCard(props: Partial<React.ComponentProps<typeof QueuedMessageCard>> = {}) {
  return render(
    <QueuedMessageCard
      conversationId="conv-1"
      index={0}
      total={1}
      text="看下这张图"
      assets={[makeAsset()]}
      mentionAgents={[]}
      onUpdate={noop}
      onRemove={noop}
      onMoveUp={noop}
      onMoveDown={noop}
      {...props}
    />
  )
}

beforeEach(() => {
  readAssetBlob.mockReset()
  readAssetBlob.mockResolvedValue(new Blob(['fake-image'], { type: 'image/png' }))
})

describe('QueuedMessageCard attachment preview', () => {
  it('opens a lightbox when the queued image thumbnail is clicked', async () => {
    const user = userEvent.setup()
    renderCard()

    const chip = await screen.findByRole('button', { name: 'filePreview.preview: photo.png' })
    // Thumbnail is read from OPFS on mount.
    await waitFor(() => expect(chip.querySelector('img')).not.toBeNull())

    await user.click(chip)

    // The lightbox renders the same image full-screen; `shadow-2xl` is the
    // overlay image's marker class (the chip thumbnail is `object-cover`).
    const lightboxImg = await waitFor(() => {
      const el = document.querySelector<HTMLImageElement>('img.shadow-2xl')
      expect(el).not.toBeNull()
      return el as HTMLImageElement
    })
    expect(lightboxImg.getAttribute('src')).toBe('blob:mock-url')

    // Escape closes the overlay (regression guard for the shared Lightbox).
    await user.keyboard('{Escape}')
    await waitFor(() => expect(document.querySelector('img.shadow-2xl')).toBeNull())
  })

  it('routes non-image attachments to the shared FilePreview drawer', async () => {
    const user = userEvent.setup()
    const onPreviewAsset = vi.fn()
    readAssetBlob.mockResolvedValue(new Blob(['%PDF'], { type: 'application/pdf' }))

    renderCard({
      assets: [makeAsset({ id: 'a2', name: 'report.pdf', mimeType: 'application/pdf' })],
      onPreviewAsset,
    })

    await user.click(screen.getByRole('button', { name: 'filePreview.preview: report.pdf' }))

    await waitFor(() => expect(onPreviewAsset).toHaveBeenCalledTimes(1))
    expect(onPreviewAsset.mock.calls[0][0]).toBe('report.pdf')
    expect(onPreviewAsset.mock.calls[0][1]).toBeInstanceOf(Blob)
  })

  it('keeps text-only queued messages free of attachment controls', () => {
    renderCard({ assets: undefined })
    expect(screen.queryByRole('button', { name: /filePreview\.preview/ })).toBeNull()
    expect(screen.getByText('看下这张图')).toBeTruthy()
  })
})
