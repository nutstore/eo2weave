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
 *
 * The row surface is a fixed dark tint in BOTH themes (the deleted/added
 * span colors above are tuned for it), so unchanged text needs an
 * explicitly light foreground — inheriting `--foreground` (#171717 in
 * light mode) would be nearly invisible. `text-neutral-100` is a
 * theme-token class that resolves to a light value in light mode
 * (#F3F4F6) and in dark mode (#E8ECEF), giving >13:1 contrast against
 * the row surface in either theme.
 */

import React from 'react'
import { MessageSquare } from 'lucide-react'
import type { InlineFragment } from '@/components/sync/inlineDiff'

interface TrackChangesLineProps {
  fragments: InlineFragment[]
  /** New (surviving) line number shown in the gutter */
  newLineNo: number
  /** Original line number of the removed side (used for old-side markers) */
  oldLineNo?: number
  /** Gutter marker (defaults to `~`) */
  marker?: string
  /** Called when the gutter line number is clicked (comment targeting) */
  onLineNoClick?: (event: React.MouseEvent) => void
  /** Called when the ORIGINAL-side gutter cell is clicked */
  onOldLineNoClick?: (event: React.MouseEvent) => void
  /** Whether the line number cell is clickable */
  clickable?: boolean
  /**
   * Whether this row is the selected comment target.
   *
   * The row paints its own opaque background, so the caller's selection
   * fill would be hidden behind it — the selection styling is applied
   * here instead.
   */
  selected?: boolean
  /** Whether the ORIGINAL side of this row carries a comment */
  oldSideCommented?: boolean
  /** Whether the MODIFIED side of this row carries a comment */
  newSideCommented?: boolean
}

const GUTTER_CELL =
  'w-12 shrink-0 select-none text-right pr-3 font-mono text-[13px] leading-[20px]'

/** Test hook: marks the track-changes row container */
export const TRACK_CHANGES_LINE_TESTID = 'track-changes-line'

function FragmentSpan({ fragment }: { fragment: InlineFragment }) {
  if (fragment.type === 'removed') {
    return (
      <span
        data-testid="track-changes-removed"
        className="bg-red-50 text-red-700 line-through decoration-red-500/80 [text-decoration-thickness:1.5px] rounded-[3px] dark:bg-[#f8514940] dark:text-[#ffc0bd] dark:decoration-[#f85149cc]"
      >
        {fragment.value}
      </span>
    )
  }
  if (fragment.type === 'added') {
    return (
      <span
        data-testid="track-changes-added"
        className="bg-green-50 text-green-700 font-semibold rounded-[3px] dark:bg-[#2ea04355] dark:text-[#7ee787]"
      >
        {fragment.value}
      </span>
    )
  }
  // Unchanged text sits on the dark row surface in both themes — it needs
  // its own light foreground rather than the inherited theme foreground.
  return (
    <span data-testid="track-changes-equal" className="text-neutral-700 dark:text-neutral-100">
      {fragment.value}
    </span>
  )
}

const TrackChangesLine: React.FC<TrackChangesLineProps> = ({
  fragments,
  newLineNo,
  oldLineNo,
  marker = '~',
  onLineNoClick,
  onOldLineNoClick,
  clickable = false,
  selected = false,
  oldSideCommented = false,
  newSideCommented = false,
}) => {
  return (
    <div
      className="relative flex bg-neutral-100 dark:bg-[#1c2128]"
      data-testid={TRACK_CHANGES_LINE_TESTID}
      data-selected={selected ? 'true' : 'false'}
    >
      {/*
        The row paints an opaque dark surface, which would hide a
        selection fill applied by the caller. The selection is therefore
        rendered here as a translucent overlay ON TOP of that surface, so
        the row keeps its contrast and still reads as selected. The
        content cells below are `relative` and therefore paint above it.
      */}
      {selected && (
        <span
          aria-hidden="true"
          data-testid="track-changes-selection"
          className="pointer-events-none absolute inset-0 bg-blue-400/25 ring-1 ring-inset ring-blue-300 dark:bg-blue-500/25 dark:ring-blue-700"
        />
      )}
      {/* Original line number cell — shows the OLD line number and any
          original-side comment marker, aligned with the other gutter cells */}
      <span
        className={`relative ${GUTTER_CELL} ${clickable ? 'cursor-pointer hover:bg-neutral-700/80' : ''}`}
        onClick={onOldLineNoClick}
        data-testid="track-changes-old-line-no"
      >
        {oldLineNo ?? ''}
        {oldSideCommented && (
          <MessageSquare
            data-testid="track-changes-old-comment"
            className="ml-1 inline h-2.5 w-2.5 text-amber-500 dark:text-amber-400"
          />
        )}
      </span>
      <span
        className={`relative ${GUTTER_CELL} text-neutral-400 ${clickable ? 'cursor-pointer hover:bg-neutral-700/80' : ''}`}
        onClick={onLineNoClick}
        data-testid="track-changes-new-line-no"
      >
        {newLineNo}
        {newSideCommented && (
          <MessageSquare
            data-testid="track-changes-new-comment"
            className="ml-1 inline h-2.5 w-2.5 text-amber-500 dark:text-amber-400"
          />
        )}
      </span>
      <span className="relative w-5 shrink-0 select-none text-center font-mono text-[13px] leading-[20px] text-neutral-400">
        {marker}
      </span>
      <span className="relative whitespace-pre-wrap break-all font-mono text-[13px] leading-[20px]">
        {fragments.map((fragment, i) => (
          <FragmentSpan key={i} fragment={fragment} />
        ))}
      </span>
    </div>
  )
}

export default TrackChangesLine
