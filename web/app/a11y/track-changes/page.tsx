'use client'

/**
 * A11y test harness — track-changes diff rendering (issue #109).
 *
 * A route-group-free page that mounts the REAL `LazyDiffViewer` with a
 * markdown diff containing fused track-changes rows, so Playwright +
 * axe-core can audit the actual component markup (semantic <del>/<ins>,
 * gutter cells, row surfaces) in both light and dark themes.
 *
 * Deliberately OUTSIDE `app/(app)/`: that layout is a storage-gated,
 * client-only shell (OPFS, service worker, workspace bootstrap) — driving
 * it to a rendered diff would need a real workspace with pending changes.
 * This harness mounts the same production component directly and inherits
 * the root layout (fonts, globals.css, <html lang>) — everything the diff
 * viewer renders is real; only the app shell around it is skipped.
 *
 * Theme: the app persists light/dark mode in localStorage under
 * `bfosa-theme` (zustand persist) and applies a `light`/`dark` class on
 * `document.documentElement` (`store/theme.store.ts` → `applyTheme`). The
 * theme store module is created at import time and hydrates synchronously
 * from localStorage, so the spec pre-seeds storage via an init script
 * BEFORE any app code runs; this page then just calls `initializeTheme()`,
 * exactly like `components/layout/WorkspaceLayout.tsx` does in the real
 * app. `?theme=` is only the signal for which value to pre-seed.
 */

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import LazyDiffViewer from '@/components/sync/LazyDiffViewer'
import { initializeTheme } from '@/store/theme.store'

// Same fixture as the jsdom suite (inlineDiff.test.tsx): one fused inline
// pair (brown→red) and one fused whole-line pair (removed→added entirely).
const ORIGINAL = 'The quick brown fox\nkept line\nremoved entirely'
const MODIFIED = 'The quick red fox\nkept line\nadded entirely'

export default function TrackChangesA11yHarnessPage() {
  // Test fixture — never ship to production. The Playwright suite runs
  // against `next dev`, so this only affects prod builds/deploys.
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    initializeTheme()
    setMounted(true)
  }, [])

  return (
    <main>
      <h1>Track-changes diff a11y harness</h1>
      {/*
        The viewer renders only after `mounted`, so the server HTML (empty
        main) matches the first client render.
      */}
      {mounted && (
        <div data-testid="a11y-diff-root">
          <LazyDiffViewer original={ORIGINAL} modified={MODIFIED} path="notes.md" />
        </div>
      )}
    </main>
  )
}
