import { beforeEach, describe, expect, it } from 'vitest'
import { useAssetStore } from '@/store/asset.store'

describe('conversation attachment drafts', () => {
  beforeEach(() => useAssetStore.setState({ pendingAssets: [], deferredAssets: {}, activeConversationId: null }))

  it('keeps each conversation’s staged and recovered attachments separate', () => {
    const store = useAssetStore.getState()
    store.switchConversation('a')
    store.addFiles([new File(['a'], 'a.txt')])
    store.switchConversation('b')
    store.addFiles([new File(['b'], 'b.txt')])
    const failed = { id: 'failed', name: 'failed.txt', size: 1, mimeType: 'text/plain', file: new File(['x'], 'failed.txt'), ocrStatus: 'idle' as const }
    store.restoreAssets([failed], 'a')
    store.switchConversation('a')
    expect(useAssetStore.getState().pendingAssets.map((asset) => asset.name)).toEqual(['a.txt', 'failed.txt'])
    store.switchConversation('b')
    expect(useAssetStore.getState().pendingAssets.map((asset) => asset.name)).toEqual(['b.txt'])
  })
  it('moves welcome attachments to the first conversation', () => {
    const store = useAssetStore.getState()
    store.addFiles([new File(['hello'], 'welcome.txt')])
    store.switchConversation('new')
    expect(useAssetStore.getState().pendingAssets.map((asset) => asset.name)).toEqual(['welcome.txt'])
  })

  it('clears a deleted active conversation without restoring its files on unmount', () => {
    const store = useAssetStore.getState()
    store.switchConversation('deleted')
    store.addFiles([new File(['secret'], 'deleted.txt')])
    store.discardDeferredAssets('deleted')
    expect(useAssetStore.getState().activeConversationId).toBeNull()
    expect(useAssetStore.getState().pendingAssets).toEqual([])
    expect(useAssetStore.getState().deferredAssets.deleted).toBeUndefined()
  })

})
