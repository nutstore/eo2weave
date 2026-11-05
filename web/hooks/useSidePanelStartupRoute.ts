import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import {
  handleWorkspaceAssistantOnReady,
  hasPendingSidePanelProjectRoute,
} from '@/agent/workspace-assistant-context'

/** Keep the launch screen visible until the hostname's route has committed. */
export function useSidePanelStartupRoute(storageReady: boolean): boolean {
  const router = useRouter()
  const pathname = usePathname()
  const launchPathname = useRef(pathname)
  const started = useRef(false)
  const [resolving, setResolving] = useState(hasPendingSidePanelProjectRoute)
  const [targetPath, setTargetPath] = useState<string | null>(null)

  useEffect(() => {
    if (!storageReady || started.current) return
    // StrictMode replays effects; the first lookup owns the one-shot launch.
    started.current = true
    void handleWorkspaceAssistantOnReady((path) => {
      setTargetPath(path)
      router.replace(path)
    }).finally(() => setResolving(false))
  }, [storageReady, router])

  useEffect(() => {
    // A different committed route can supersede the launch replacement.
    // Release the gate for that destination as well as the requested one.
    if (targetPath !== null && (pathname === targetPath || pathname !== launchPathname.current)) {
      setTargetPath(null)
    }
  }, [pathname, targetPath])

  return resolving || targetPath !== null
}
