/**
 * TrackChangesLine Component
 *
 * Renders ONE fused modified line (issue #96): the fragment stream from
 * `computeInlineFragments` is rendered in a single content flow — removed
 * fragments as struck-through `<del>` spans, added fragments as highlighted
 * `<ins>` spans, unchanged fragments as plain text. Wraps naturally with
 * long lines (no line pairing, no fixed row heights).
 *
 * Visual spec (issue #96 DESIGN FINAL, approved mockup 2026-10-28):
 * - Row: `~` gutter marker, neutral `#1c2128` tint (dark) — inline
 *   highlights carry the information, no full-line green/red
 * - Deleted span: bg #f8514940, color #ffc0bd, line-through 1.5px #f85149cc
 * - Added span: bg #2ea04355, color #7ee787, font-weight 600
 */

import React from 'react'
import type { InlineFragment } from './inlineDiff'

interface TrackChangesLineProps {
  fragments: InlineFragment[]
  /** New (surviving) line number shown in the gutter */
  newLineNo: number
  /** Gutter marker (defaults to `~`) */
  marker?: string
  /** Called when the gutter line number is clicked (comment targeting) */
  onLineNoClick?: (event: React.MouseEvent) => void
  /** Whether the line number cell is clickable */
  clickable?: boolean
}

const GUTTER_CELL =
  'w-12 shrink-0 select-none text-right pr-3 font-mono text-[13px] leading-[20px]'

function FragmentSpan({ fragment }: { fragment: InlineFragment }) {
  if (fragment.type === 'removed') {
    return (
      <span
        style={{
          backgroundColor: '#f8514940',
          color: '#ffc0bd',
          textDecorationLine: 'line-through',
          textDecorationColor: '#f85149cc',
          textDecorationThickness: '1.5px',
          borderRadius: '3px',
        }}
      >
        {fragment.value}
      </span>
    )
  }
  if (fragment.type === 'added') {
    return (
      <span
        style={{
          backgroundColor: '#2ea04355',
          color: '#7ee787',
          fontWeight: 600,
          borderRadius: '3px',
        }}
      >
        {fragment.value}
      </span>
    )
  }
  return <span>{fragment.value}</span>
}

const TrackChangesLine: React.FC<TrackChangesLineProps> = ({
  fragments,
  newLineNo,
  marker = '~',
  onLineNoClick,
  clickable = false,
}) => {
  return (
    <div className="flex bg-[#1c2128]">
      {/* Old line number cell — fused row shows the NEW number only */}
      <span className={`${GUTTER_CELL} text-neutral-500`} />
      <span
        className={`${GUTTER_CELL} text-neutral-400 ${clickable ? 'cursor-pointer hover:bg-neutral-700/80' : ''}`}
        onClick={onLineNoClick}
      >
        {newLineNo}
      </span>
      <span className="w-5 shrink-0 select-none text-center font-mono text-[13px] leading-[20px] text-neutral-400">
        {marker}
      </span>
      <span className="whitespace-pre-wrap break-all font-mono text-[13px] leading-[20px]">
        {fragments.map((fragment, i) => (
          <FragmentSpan key={i} fragment={fragment} />
        ))}
      </span>
    </div>
  )
}

export default TrackChangesLine
