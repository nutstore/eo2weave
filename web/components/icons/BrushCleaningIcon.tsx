import { memo } from 'react'

/**
 * BrushCleaning icon — a broom.
 *
 * lucide-react 0.460/0.468 pinned in this repo does not yet ship
 * `BrushCleaning` (added upstream in 0.469). This inlines the official
 * lucide SVG paths verbatim so the icon is pixel-identical to a native
 * lucide icon. Once lucide-react is upgraded past 0.469, this component
 * can be replaced by `import { BrushCleaning } from 'lucide-react'`.
 */
export const BrushCleaningIcon = memo(function BrushCleaningIcon({
  className,
}: {
  className?: string
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="m16 22-1-4" />
      <path d="M19 14a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2h-3a1 1 0 0 1-1-1V4a2 2 0 0 0-4 0v5a1 1 0 0 1-1 1H6a2 2 0 0 0-2 2v1a1 1 0 0 0 1 1" />
      <path d="M19 14H5l-1.973 6.767A1 1 0 0 0 4 22h16a1 1 0 0 0 .973-1.233z" />
      <path d="m8 22 1-4" />
    </svg>
  )
})
