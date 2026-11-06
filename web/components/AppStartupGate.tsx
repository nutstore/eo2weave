'use client'

import { Suspense, createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'

const StartupReadyContext = createContext<(() => void) | null>(null)

export function AppStartupGate({ ready, loadingScreen, children }: {
  ready: boolean
  loadingScreen: ReactNode
  children: ReactNode
}) {
  const pathname = usePathname()
  const [finished, setFinished] = useState(false)
  const finish = useCallback(() => setFinished(true), [])
  const waitsForView = pathname === '/' || pathname === '/projects' || pathname.startsWith('/projects/')

  useEffect(() => {
    if (ready && !waitsForView) finish()
  }, [ready, waitsForView, finish])

  // Readiness can change during later navigation; startup completes only once.
  const pending = !finished
  return (
    <StartupReadyContext.Provider value={finish}>
      {pending && <div key="startup">{loadingScreen}</div>}
      {/* Route/module suspension must not hide the startup screen above it. */}
      <Suspense key="app" fallback={null}>
        {(ready || finished) && <div hidden={pending}>{children}</div>}
      </Suspense>
    </StartupReadyContext.Provider>
  )
}

/** Release the initial startup screen after the destination view is ready. */
export function useStartupReady(ready: boolean): void {
  const finish = useContext(StartupReadyContext)
  useEffect(() => {
    if (ready) finish?.()
  }, [ready, finish])
}
