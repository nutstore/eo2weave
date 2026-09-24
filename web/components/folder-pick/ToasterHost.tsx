'use client'

import { Toaster } from 'sonner'

/**
 * Minimal toast host for the standalone folder-pick tab. The main app's
 * Toaster lives in AppBootstrap's post-storage tree, which still mounts on
 * this route — but if storage init ever fails, this keeps toasts alive.
 */
export default function ToasterHost() {
  return <Toaster position="bottom-right" />
}
