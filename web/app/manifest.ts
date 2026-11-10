import type { MetadataRoute } from 'next'

/**
 * Deployment-region locale switch — build-time inlined (see app/layout.tsx).
 * CN build → 怡氧知知, international build → EO2Weave. Keep the PWA install
 * name in sync with the document title.
 */
const IS_CN_BUILD = process.env.NEXT_PUBLIC_DEPLOY_REGION === 'cn'

// The manifest is deterministic and can be cached by the Next runtime.
export const dynamic = 'force-static'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: IS_CN_BUILD ? '怡氧知知' : 'EO2Weave',
    short_name: IS_CN_BUILD ? '怡氧知知' : 'EO2Weave',
    description: IS_CN_BUILD
      ? '面向创作者的 AI 原生工作台：本地优先的文件、知识工作流与多智能体编排'
      : 'AI-native creator workspace with local-first files, knowledge workflows, and multi-agent orchestration',
    // Preserve the existing installed app's identity when its start URL changes.
    id: '/',
    start_url: '/projects',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0f172a',
    // Brand primary baseline (#4D9F98 = --primary-500 in globals.css); keep in
    // sync with the `viewport.themeColor` export in app/layout.tsx.
    theme_color: '#4D9F98',
    categories: ['utilities', 'developer', 'productivity'],
    icons: [
      // icon-192/icon-512 are required by Chrome's installability criteria
      // (beforeinstallprompt / address-bar install). Generated from the
      // 1024px brand logo; full-bleed artwork so they ship as purpose "any".
      // The 128px maskable entry covers Android adaptive-icon masking.
      { src: '/icons/icon-128.png', sizes: '128x128', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
    shortcuts: [
      {
        name: IS_CN_BUILD ? '新建会话' : 'New Session',
        short_name: IS_CN_BUILD ? '新建' : 'New',
        description: IS_CN_BUILD
          ? '开启一个新的创作工作台会话'
          : 'Start a new creator workspace session',
        url: '/projects?new=true',
      },
    ],
  }
}
