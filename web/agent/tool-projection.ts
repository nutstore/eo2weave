import type { ToolDefinition } from '@/agent/tools/tool-types'

/** Visibility is independent of Plan/Act policy; the caller supplies allowed tools. */
export function projectTools(definitions: readonly ToolDefinition[]) {
  return {
    modelTools: [...definitions],
    codeTools: definitions.filter(def => def.function.name !== 'run_code'),
  }
}
