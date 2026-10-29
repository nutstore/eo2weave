/**
 * Per-tab navigation epoch for the page-action CSP fallback's
 * replacement-document guard (PR #110 fix: "Fallback accepts a
 * replacement document").
 *
 * A monotonic per-tab counter that advances on every CROSS-DOCUMENT
 * navigation commit (chrome.tabs.onUpdated with status='loading' —
 * fires before any script of the new document runs; pushState / hash
 * changes never fire it and never touch the epoch). The page-action
 * handler pins the epoch BEFORE its executeScript; the CSP fallback
 * branch re-checks it before dispatching the CDP evaluation. A mismatch
 * means the document that reported the compile failure was replaced —
 * the post-hoc loaderId capture can no longer be trusted to describe
 * the FAILED document (it would capture the replacement's identity and
 * bless the stale run), so the fallback is refused outright (fail
 * closed).
 *
 * Kept in a dependency-free lib module so the guard logic is unit
 * testable without loading the whole background service worker.
 */

const tabNavigationEpochs = new Map<number, number>()

/** Current navigation epoch for a tab (0 before the first commit event). */
export function tabNavigationEpoch(tabId: number): number {
  return tabNavigationEpochs.get(tabId) ?? 0
}

/** Advance the epoch (also the test seam for the listener). */
export function bumpTabNavigationEpoch(tabId: number): number {
  const next = (tabNavigationEpochs.get(tabId) ?? 0) + 1
  tabNavigationEpochs.set(tabId, next)
  return next
}

/** Test hook: clear all epoch bookkeeping. */
export function resetTabNavigationEpochsForTest(): void {
  tabNavigationEpochs.clear()
}

/** Drop a dead tab's epoch entry (bounded map; safe to call repeatedly). */
export function forgetTabNavigationEpoch(tabId: number): void {
  tabNavigationEpochs.delete(tabId)
}

/** True when the pinned epoch no longer matches the tab's current one. */
export function navigationEpochChanged(tabId: number, pinnedEpoch: number): boolean {
  return tabNavigationEpoch(tabId) !== pinnedEpoch
}

/**
 * Install the chrome.tabs listener feeding the epoch counters. Idempotent
 * within one service-worker lifetime. (Listeners fire for every tab;
 * status='loading' precedes any script execution of the new document, so
 * the epoch always advances before a replacement document can act.)
 */
let installed = false
export function installTabNavigationEpochListener(tabs = chrome.tabs): void {
  if (installed) return
  installed = true
  tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
      bumpTabNavigationEpoch(tabId)
    }
  })
}
