/**
 * FlowEdgeCustom — custom React Flow edge.
 * Regular edges: bezier with selection highlight.
 * Loop edges: red dashed with the redo label.
 *
 * Selection state (from React Flow's `selected` prop) is reflected via a
 * brighter color, thicker stroke, and a subtle glow so users get clear
 * feedback that the edge is selected and can be deleted (Backspace/Delete).
 */

import { memo } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react'

function FlowEdgeComponent({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps) {
  const isLoop = data?.isLoop === true
  const conditionLabel = data?.conditionLabel as string | undefined

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  if (isLoop) {
    return (
      <>
        <BaseEdge
          id={id}
          path={edgePath}
          style={{
            stroke: selected ? '#ff3333' : '#ff6b81',
            strokeWidth: selected ? 2.5 : 2,
            strokeDasharray: '6 4',
            ...(selected ? { filter: 'drop-shadow(0 0 3px rgba(255,107,129,0.5))' } : {}),
          }}
        />
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
            }}
            className={
              'rounded px-1.5 py-0.5 text-[9px] font-bold transition-colors ' +
              (selected
                ? 'bg-danger-100 text-danger-600 ring-2 ring-danger-300 dark:bg-danger-950/60'
                : 'bg-danger-50 text-danger-500 dark:bg-danger-950/40')
            }
          >
            ↻ 重做
          </div>
        </EdgeLabelRenderer>
      </>
    )
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: selected ? '#4f7cff' : '#a0a0b8',
          strokeWidth: selected ? 3 : 2,
          transition: 'stroke 0.15s, stroke-width 0.15s',
          ...(selected ? { filter: 'drop-shadow(0 0 3px rgba(79,124,255,0.4))' } : {}),
        }}
      />
      {conditionLabel && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'none',
            }}
            className={
              'rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors ' +
              (selected
                ? 'bg-primary-100 text-primary-600 dark:bg-primary-950/40'
                : 'bg-purple-50 text-purple-600 dark:bg-purple-950/30 dark:text-purple-400')
            }
          >
            ⎇ {conditionLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const FlowEdgeCustom = memo(FlowEdgeComponent)
