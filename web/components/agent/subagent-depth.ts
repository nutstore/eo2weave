/**
 * How many subagent transcripts may nest inside one another.
 *
 * A panel renders the tool calls of the child it shows, and a child that spawned
 * its own children renders another panel — so nesting depth is user-driven, while
 * the cost is not: every level fetches and builds another transcript, and a deep
 * chain re-renders the same messages once per level.
 *
 * Depth counts panels, not agents: the main conversation renders at 0, the first
 * expanded child at 1, and a panel deeper than the limit shows a note instead of
 * expanding further.
 */
export const MAX_SUBAGENT_DEPTH = 2
