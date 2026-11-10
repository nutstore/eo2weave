'use client'

import { useRouter } from 'next/navigation'
import { useCallback, type MouseEvent } from 'react'

/** Open the store normally, then show the experience guide in the current tab. */
export function useStoreInstall() {
  const router = useRouter()
  return useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    window.setTimeout(() => router.push('/experience?from=store'), 0)
  }, [router])
}
