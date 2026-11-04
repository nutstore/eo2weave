/**
 * Asset Upload Store — manages pending file uploads before they are sent.
 *
 * Flow:
 * 1. User selects/drops files → stored as PendingAsset objects
 * 2. UI shows preview bar with thumbnails and remove buttons
 * 3. For images: OCR runs automatically in background to extract text
 * 4. On send: files are written to OPFS assets/, converted to AssetMeta[],
 *    attached to the user message, then pending state is cleared.
 */

import { create } from 'zustand'
import { isOcrCompatibleImage, fileToBase64 } from '@/services/ocr.service'
import type { OcrStatus } from '@/services/ocr.service'

/** A file awaiting upload, held in browser memory. */
export interface PendingAsset {
  /** Unique ID for React keys */
  id: string
  /** Original file name */
  name: string
  /** File size in bytes */
  size: number
  /** MIME type (from File object) */
  mimeType: string
  /** The actual File/Blob data, held in memory until send */
  file: File
  /** Optional object URL for image preview (set lazily) */
  previewUrl?: string
  /** OCR recognition status */
  ocrStatus: OcrStatus
  /** OCR recognized text (empty string if not yet done or not an image) */
  ocrText?: string
  /** Base64-encoded image data for Vision API */
  ocrBase64?: string
  /** OCR error message */
  ocrError?: string
}

interface AssetStore {
  /** Files staged for upload with the next message */
  pendingAssets: PendingAsset[]
  deferredAssets: Record<string, PendingAsset[]>
  restoreAssets: (assets: PendingAsset[], conversationId?: string) => void
  restoreDeferredAssets: (conversationId: string) => void

  /** Add files from a FileList or File array (triggers OCR for images) */
  addFiles: (files: File[]) => void

  /** Remove a pending asset by ID */
  removeAsset: (id: string) => void

  /** Clear all pending assets (called after successful send) */
  clearAll: () => void

  /** Get a preview URL for an asset (creates one lazily for images) */
  getPreviewUrl: (id: string) => string | undefined

  /** Update OCR result for a specific asset (internal) */
  _updateOcrResult: (id: string, result: { status: OcrStatus; text?: string; base64?: string; error?: string }) => void

  /** Set base64 data for an image asset immediately (internal) */
  _setBase64: (id: string, base64: string) => void
}

let nextId = 0
function genId(): string {
  return `pending-${Date.now()}-${++nextId}`
}

/** Check if a MIME type is a previewable image */
function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

export const useAssetStore = create<AssetStore>((set, get) => ({
  pendingAssets: [],
  deferredAssets: {},

  restoreAssets: (assets, conversationId) => {
    if (conversationId) {
      set((state) => ({ deferredAssets: { ...state.deferredAssets, [conversationId]: [...(state.deferredAssets[conversationId] ?? []), ...assets] } }))
      return
    }
    const restored = assets.map((asset) => ({
      ...asset,
      previewUrl: isImageMime(asset.mimeType) ? URL.createObjectURL(asset.file) : undefined,
    }))
    set((state) => ({ pendingAssets: [...state.pendingAssets, ...restored] }))
  },

  restoreDeferredAssets: (conversationId) => {
    const assets = get().deferredAssets[conversationId]
    if (!assets?.length) return
    set((state) => {
      const deferredAssets = { ...state.deferredAssets }
      delete deferredAssets[conversationId]
      return { deferredAssets }
    })
    get().restoreAssets(assets)
  },

  addFiles: (files: File[]) => {
    const newAssets: PendingAsset[] = files.map((file) => {
      const asset: PendingAsset = {
        id: genId(),
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        file,
        ocrStatus: 'idle',
      }
      // Eagerly create preview URL for images
      if (isImageMime(asset.mimeType)) {
        asset.previewUrl = URL.createObjectURL(file)
        asset.ocrStatus = 'loading'
      }
      return asset
    })
    set((state) => ({
      pendingAssets: [...state.pendingAssets, ...newAssets],
    }))

    // For image assets: convert to base64 immediately (fast, ~ms) so Vision API
    // data is always available even if the user sends before OCR finishes.
    // Then trigger OCR text recognition in background.
    for (const asset of newAssets) {
      // Immediately convert image to base64 (fast, ~ms) so Vision API data
      // is available even if user sends before OCR finishes.
      if (isImageMime(asset.mimeType)) {
        fileToBase64(asset.file)
          .then((base64) => { get()._setBase64(asset.id, base64) })
          .catch(() => { /* best effort */ })
      }
      // OCR text recognition is intentionally NOT triggered here.
      //
      // Previously OCR ran eagerly on every image upload, regardless of the
      // target model's vision capability.  For vision-capable models (the
      // default), the model can OCR the image itself, so eager OCR was:
      //   1. Wasted CPU/tokens on a never-consumed signal
      //   2. Actively harmful — Tesseract's noisy output on non-text
      //      images (e.g. photos) would be injected as the model's only
      //      image description, drowning the real visual signal
      //
      // OCR is now deferred to message send time and only runs for
      // non-vision models.  See useConversationLogic.sendMessage().
      if (isOcrCompatibleImage(asset.mimeType)) {
        // Mark as idle (not processing) so the UI doesn't show a spinner.
        get()._updateOcrResult(asset.id, { status: 'idle' })
      }
    }
  },

  removeAsset: (id: string) => {
    set((state) => {
      const asset = state.pendingAssets.find((a) => a.id === id)
      if (asset?.previewUrl) {
        URL.revokeObjectURL(asset.previewUrl)
      }
      return {
        pendingAssets: state.pendingAssets.filter((a) => a.id !== id),
      }
    })
  },

  clearAll: () => {
    const { pendingAssets } = get()
    for (const asset of pendingAssets) {
      if (asset.previewUrl) {
        URL.revokeObjectURL(asset.previewUrl)
      }
    }
    set({ pendingAssets: [] })
  },

  getPreviewUrl: (id: string) => {
    return get().pendingAssets.find((a) => a.id === id)?.previewUrl
  },

  _updateOcrResult: (id: string, result: { status: OcrStatus; text?: string; base64?: string; error?: string }) => {
    set((state) => ({
      pendingAssets: state.pendingAssets.map((a) =>
        a.id === id
          ? {
              ...a,
              ocrStatus: result.status,
              ...(result.text !== undefined ? { ocrText: result.text } : {}),
              ...(result.base64 !== undefined ? { ocrBase64: result.base64 } : {}),
              ...(result.error !== undefined ? { ocrError: result.error } : {}),
            }
          : a
      ),
    }))
  },

  _setBase64: (id: string, base64: string) => {
    set((state) => ({
      pendingAssets: state.pendingAssets.map((a) =>
        a.id === id ? { ...a, ocrBase64: base64 } : a
      ),
    }))
  },
}))
