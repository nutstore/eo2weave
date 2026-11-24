/**
 * Tool Renderer types and interfaces.
 * Each tool can register a custom renderer with Summary (collapsed) and Detail (expanded) views.
 */

import type { ReactNode } from 'react'

/** Context passed to every tool renderer — pre-parsed args and result */
export interface ToolRenderCtx {
  /** Raw tool call */
  toolName: string
  /** Tool call id — lets a renderer correlate children (e.g. agent steps). */
  toolCallId?: string
  /** Owning conversation, for renderers that drill into per-agent detail. */
  conversationId?: string
  /** Layout depth, so a transcript nested in a transcript stops deepening. */
  depth?: number
  /** Parsed arguments (may be partial during streaming) */
  args: Record<string, unknown>
  /** Raw args string (for copy / fallback) */
  rawArgs: string
  /** Parsed result envelope `{ ok, version, data?, error? }` or null */
  result: Record<string, unknown> | null
  /** Raw result string */
  rawResult: string | undefined
  /** Tool is still executing (no result yet) */
  isExecuting: boolean
  /** Tool args are still streaming in */
  isStreaming: boolean
  /** Result indicates an error */
  isError: boolean
}

/** A renderer for a specific tool */
export interface ToolRenderer {
  /** Exact tool name to match */
  name: string
  /** Icon element (overrides default Wrench) */
  icon?: ReactNode
  /** Collapsed summary — renders inside the card header button */
  Summary: (ctx: ToolRenderCtx) => ReactNode
  /**
   * Optional strip rendered below the header while the card is collapsed, for
   * state a user must see without expanding (live children, step status).
   * Skipped when the card is open so it never duplicates Detail.
   */
  Aside?: (ctx: ToolRenderCtx) => ReactNode
  /** Expanded detail — renders below the header when open */
  Detail: (ctx: ToolRenderCtx) => ReactNode
}
