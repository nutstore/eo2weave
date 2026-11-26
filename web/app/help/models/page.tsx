import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ModelsPage } from '@/app/help/models/ModelsPage'

/**
 * Domestic-only route — build-time inlined.
 *
 * The algorithm registration notice exists only to satisfy domestic disclosure
 * requirements, so the international build must not serve it at all. Gating at
 * build time (rather than shipping an English translation) keeps overseas
 * content untouched.
 */
const IS_CN_BUILD = process.env.NEXT_PUBLIC_DEPLOY_REGION === 'cn'

const chineseMetadata: Metadata = {
  title: '第三方大模型及算法备案信息说明 — 怡氧®AI',
  description: '怡氧®AI 接入的第三方大模型及其算法备案信息。',
  alternates: {
    canonical: '/help/models',
  },
  openGraph: {
    type: 'website',
    url: '/help/models',
    title: '第三方大模型及算法备案信息说明 — 怡氧®AI',
    description: '怡氧®AI 接入的第三方大模型及其算法备案信息。',
  },
  robots: { index: true, follow: true },
}

// The notification is domestic-only: never advertise it through metadata the
// international build could serve on its 404 response.
export const metadata: Metadata = IS_CN_BUILD
  ? chineseMetadata
  : { title: 'Not Found', robots: { index: false, follow: false } }

export default function ModelsRoute() {
  if (!IS_CN_BUILD) notFound()
  return <ModelsPage locale="zh" />
}
