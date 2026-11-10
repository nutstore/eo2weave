'use client'

import { useRef, type CSSProperties } from 'react'
import { HomeCnMarkup } from './HomeCnMarkup'
import { useHomeBehavior, type HomeDemoCopy } from './useHomeBehavior'
import { useExtensionMarkers } from '../../chrome/useExtensionMarkers'
import './home.css'

const copy: HomeDemoCopy = {
  sidebarPrompt: '总结当前网站，并找出类似产品，打开相关网站。',
  workflowPrompt: '整理上周工作',
  workflowConfirmation: '没问题，发送吧',
  detailTitle: '详情页即将上线',
  locale: 'zh-CN',
}

/** Domestic home page. */
export function HomeCn() {
  const root = useRef<HTMLDivElement>(null)
  useHomeBehavior(root, copy)
  useExtensionMarkers(root)
  return (
    <div ref={root} style={{ '--sidebar-placeholder': '"问问怡氧知知…"' } as CSSProperties}>
      <HomeCnMarkup />
    </div>
  )
}
