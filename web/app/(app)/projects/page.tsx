'use client'

import dynamic from 'next/dynamic'
import { WorkspaceEntry } from '@/components/project/WorkspaceEntry'

// ProjectHome is browser-only: it pulls in stores, OPFS/SQLite helpers and
// (transitively) monaco-dependent modules. Keep it out of the server bundle
// with dynamic(ssr:false) — same pattern as the legacy ClientAppShell.
const ProjectHomeView = dynamic(() => import('@/components/project/ProjectHomeView'), {
  ssr: false,
})

export default function ProjectsPage() {
  return <><WorkspaceEntry /><ProjectHomeView /></>
}
