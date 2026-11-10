'use client'

import { useEffect, useState } from 'react'
import { getExperienceSite, type ExperienceSite } from '../../content'
import { ExperienceCn } from './ExperienceCn'
import { ExperienceGlobal } from './ExperienceGlobal'

/**
 * Picks the demo without reading `searchParams` on the server: a dynamic read
 * would turn a prerendered page into a per-request render. `?site=` stays a
 * client-side preview switch, same as the static pages it replaces.
 */
export function ExperiencePage({ region }: { region: 'cn' | 'global' }) {
  const [site, setSite] = useState<ExperienceSite>(() => getExperienceSite(undefined, region))

  useEffect(() => {
    setSite(getExperienceSite(new URLSearchParams(window.location.search).get('site') ?? undefined, region))
  }, [region])

  return site === 'douban' ? <ExperienceCn /> : <ExperienceGlobal />
}
