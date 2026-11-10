'use client'

import { useEffect, useRef } from 'react'
import { ExperienceJmailMarkup } from './ExperienceJmailMarkup'
import { useExperienceBehavior } from './useExperienceBehavior'
import './manual-guide.css'
import './experience-demo.css'
import './experience.css'

/** Overseas experience page (Jmail demo). */
export function ExperienceGlobal() {
  const root = useRef<HTMLDivElement>(null)
  useExperienceBehavior(root, 'global')

  useEffect(() => {
    return () => {
      document.documentElement.classList.remove('manual-route')
    }
  }, [])

  return (
    <div ref={root}>
      <ExperienceJmailMarkup />
    </div>
  )
}
