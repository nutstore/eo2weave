'use client'

import { useEffect, useRef } from 'react'
import { ExperienceDoubanMarkup } from './ExperienceDoubanMarkup'
import { useExperienceBehavior } from './useExperienceBehavior'
import './manual-guide.css'
import './experience-demo.css'
import './experience.css'

/** Domestic experience page (Douban demo). */
export function ExperienceCn() {
  const root = useRef<HTMLDivElement>(null)
  useExperienceBehavior(root, 'cn')

  useEffect(() => {
    return () => {
      document.documentElement.classList.remove('manual-route')
    }
  }, [])

  return (
    <div ref={root}>
      <ExperienceDoubanMarkup />
    </div>
  )
}
