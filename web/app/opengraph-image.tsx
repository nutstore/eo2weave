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

/** Path data lifted verbatim from public/favicon.svg (viewBox 0 0 128 128). */
const LOGO_PATH =
  'M85.22 21.5C82.19 25.26 76.62 27.15 80.04 33.5C78.19 34.93 73.81 34.11 71.5 34.11C65.76 34.11 60.05 34.17 55.18 37.34C52.36 39.18 49.2 42.78 48.17 45.99C46.01 52.69 48.29 60.04 43.93 66.12C37.35 75.31 21.27 74.04 17.14 63.1C15.27 58.17 15.83 52.75 15.82 47.5C15.82 42.49 14.88 36.37 16.09 31.5C20.73 12.77 38.87 15.83 54.17 15.82C62.61 15.82 79.9 13.51 85.22 21.5ZM97.5 42.99C96.68 42.49 95.87 42 95.05 41.5C93.4 33.97 86.39 34.77 84.93 30.5C85.62 27.08 90.45 26.49 92.71 24.21C94.39 22.52 94.33 19.78 96.1 18.26C96.94 17.54 98.77 17.51 99.66 18.19C101.5 19.58 101.71 22.69 103.38 24.42C105.13 26.24 108.03 26.39 109.66 28.18C110.35 28.94 110.36 30.54 109.89 31.42C108.69 33.71 104.24 34.45 102.39 36.56C100.46 38.76 100.78 42.04 97.5 42.99ZM88.83 42.01C92.64 50.68 97.62 49.41 104.5 45.74C114.19 51.39 112.18 64.92 112.18 74.5C112.18 89.53 115 107.5 96.5 111.92C92.59 112.85 87.84 112.17 83.83 112.18C80.17 112.18 74.17 113.31 70.83 111.83C70.91 109.21 77.03 105.44 77.83 101.68C78.82 96.96 78.25 91.63 78.24 86.83C78.22 76.7 80.6 62.57 70.59 56.25C68.55 54.95 65.63 53.26 63.17 53.07C60.82 52.88 57.93 53.56 55.84 52.5C55.51 50.62 56.06 49.23 56.82 47.67C60.85 39.37 72.48 41.77 80.17 41.77C82.87 41.77 86.25 41.25 88.83 42.01ZM16.5 71.87C20.68 74.1 22.96 78.83 27.92 79.86C37.9 81.95 50.27 78.09 59.83 81.07C69.15 83.99 73.48 95.56 68.77 103.93C63.94 112.51 54.86 112.18 46.17 112.18C32.45 112.18 19.97 112.46 16.08 96.5C15.35 93.5 15.82 89.91 15.82 86.83C15.82 84.11 15.05 73.39 16.5 71.87Z'
const LOGO_COLOR = '#42aea3'

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
        {/* Real weave logo — inline SVG from public/favicon.svg */}
        <svg
          width="180"
          height="180"
          viewBox="0 0 128 128"
          style={{ marginBottom: 44 }}
        >
          <path
            d={LOGO_PATH}
            fill={LOGO_COLOR}
            fillRule="evenodd"
            stroke={LOGO_COLOR}
            strokeWidth="0.25"
            strokeLinejoin="round"
          />
        </svg>
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
