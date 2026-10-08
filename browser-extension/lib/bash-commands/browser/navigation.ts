import type { BrowserTask } from './task'

export async function navigate(task: BrowserTask, command: string, url: string | undefined, waitUntil: string) {
  await task.send('Page.enable')
  await task.send('Page.setLifecycleEventsEnabled', { enabled: true })
  const { frameTree } = await task.send('Page.getFrameTree')
  const frame = frameTree.frame
  let sameDocument = false, committed = false, restored = false, loaderId: string | undefined
  const events: { name: string; loaderId: string }[] = []
  const listener = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (source.tabId !== task.tabId) return
    const p = params as any
    if (method === 'Page.navigatedWithinDocument' && p.frameId === frame.id) sameDocument = true
    if (method === 'Page.frameNavigated' && p.frame.id === frame.id) {
      committed = true; loaderId = p.frame.loaderId
      restored = p.type === 'BackForwardCacheRestore'
    }
    if (method === 'Page.lifecycleEvent' && p.frameId === frame.id && p.loaderId !== frame.loaderId) events.push(p)
  }
  chrome.debugger.onEvent.addListener(listener)
  try {
    if (command === 'goto') {
      const result = await task.send('Page.navigate', { url })
      if (result.errorText) throw new Error(result.errorText)
      loaderId = result.loaderId
    } else if (command === 'reload') await task.send('Page.reload')
    else {
      const history = await task.send('Page.getNavigationHistory')
      const entry = history.entries[history.currentIndex + (command === 'go-back' ? -1 : 1)]
      if (!entry) throw new Error('No history entry in that direction')
      await task.send('Page.navigateToHistoryEntry', { entryId: entry.id })
    }
    await task.poll(async () => {
      if (sameDocument || restored || (waitUntil === 'commit' && committed)) return true
      const name = waitUntil === 'domcontentloaded' ? 'DOMContentLoaded' : 'load'
      return events.some(event => event.name === name && (!loaderId || event.loaderId === loaderId)) ? true : undefined
    })
  } finally { chrome.debugger.onEvent.removeListener(listener) }
}
