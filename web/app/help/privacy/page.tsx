import type { Metadata } from 'next'
import { PrivacyPage } from './PrivacyPage'

/**
 * Deployment-region locale switch — build-time inlined.
 *
 * The domestic (weave.eo2suite.cn) and international (weave.eo2suite.com)
 * sites are BUILT separately: the CN build sets NEXT_PUBLIC_DEPLOY_REGION=cn,
 * the international build sets it to `global`. next.config.mjs FAILS the
 * production build when the variable is missing or invalid, so every
 * deployment is guaranteed to carry an explicit region. Dev defaults to
 * English. The page stays statically prerenderable — no runtime hostname
 * sniffing.
 */
const IS_CN_BUILD = process.env.NEXT_PUBLIC_DEPLOY_REGION === 'cn'

const englishMetadata: Metadata = {
  title: 'Privacy Policy — EO2Weave',
  description: 'How the EO2Weave websites and browser extension process data, protect local files, and give you control over website tools.',
  alternates: {
    canonical: '/help/privacy/',
  },
  robots: { index: true, follow: true },
}

const chineseMetadata: Metadata = {
  title: '隐私政策 — 怡氧®AI',
  description: '了解怡氧®AI 网站和浏览器扩展如何处理数据、保护本地文件，以及如何让你管理网站工具授权。',
  alternates: {
    canonical: '/help/privacy/',
  },
  robots: { index: true, follow: true },
}

export const metadata: Metadata = IS_CN_BUILD ? chineseMetadata : englishMetadata

export default function PrivacyRoute() {
  return <PrivacyPage locale={IS_CN_BUILD ? 'zh' : 'en'} />
}
