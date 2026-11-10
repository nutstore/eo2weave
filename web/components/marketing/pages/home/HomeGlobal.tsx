'use client'

import { useRef, type CSSProperties } from 'react'
import { HomeGlobalMarkup } from './HomeGlobalMarkup'
import { useHomeBehavior, type HomeDemoCopy } from './useHomeBehavior'
import { useExtensionMarkers } from '../../chrome/useExtensionMarkers'
import './home.css'

const copy: HomeDemoCopy = {
  sidebarPrompt: 'Summarize this site, find similar products, and open their websites.',
  workflowPrompt: "Organize last week's work",
  workflowConfirmation: 'Looks good. Send it.',
  detailTitle: 'Details coming soon',
  locale: 'en-US',
}

/** Overseas home page. */
export function HomeGlobal() {
  const root = useRef<HTMLDivElement>(null)
  useHomeBehavior(root, copy)
  useExtensionMarkers(root)
  return (
    <div ref={root} style={{ '--sidebar-placeholder': '"Ask EO2Weave…"' } as CSSProperties}>
      <HomeGlobalMarkup />
    </div>
  )
}
