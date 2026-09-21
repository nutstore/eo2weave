/**
 * Dynamic OG share image (1200×630) — Next.js file convention.
 *
 * The visual identity follows the build-time deploy region
 * (NEXT_PUBLIC_DEPLOY_REGION = cn | global), the same switch that drives
 * metadataByRegion in layout.tsx: the CN build gets the 怡氧知知 wordmark,

 * the international build gets EO2Weave. ImageResponse evaluates at build
 * time for static routes, so each regional build bakes in its own image.
 */

import { ImageResponse } from 'next/og'

export const runtime = 'nodejs'
export const alt = 'EO2Weave / 怡氧知知 — AI-native creator workspace'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OpengraphImage() {
  const isCN = process.env.NEXT_PUBLIC_DEPLOY_REGION === 'cn'

  const name = isCN ? '怡氧知知' : 'EO2Weave'
  const tagline = isCN
    ? '本地优先的文件 · 知识工作流 · 多智能体编排'
    : 'Local-first files · Knowledge workflows · Multi-agent orchestration'
  const badge = isCN ? 'AI 原生创作工作台' : 'AI-native creator workspace'

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #0F1B1A 0%, #16302D 60%, #1C3D39 100%)',
          fontFamily: 'sans-serif',
        }}
      >
        {/* brand mark: rounded square with weave glyph color */}
        <div
          style={{
            width: 128,
            height: 128,
            borderRadius: 32,
            background: '#4D9F98',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 48,
          }}
        >
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 16,
              border: '6px solid #0F1B1A',
              display: 'flex',
            }}
          />
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: isCN ? 96 : 104,
            fontWeight: 700,
            color: '#F5F7F7',
            letterSpacing: isCN ? '0.08em' : '-0.02em',
            marginBottom: 28,
          }}
        >
          {name}
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 36,
            color: '#4D9F98',
            marginBottom: 20,
          }}
        >
          {badge}
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 26,
            color: '#9DB8B5',
          }}
        >
          {tagline}
        </div>
        {/* bottom hairline brand strip */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 10,
            background: '#4D9F98',
            display: 'flex',
          }}
        />
      </div>
    ),
    size,
  )
}
