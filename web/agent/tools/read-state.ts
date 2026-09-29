import type { ToolContext } from './tool-types'
import type { ResolvedVfsTarget } from './vfs-resolver'

export function ensureReadFileState(context: ToolContext): NonNullable<ToolContext['readFileState']> {
  if (!context.readFileState) {
    context.readFileState = new Map()
  }
  return context.readFileState
}

export function getReadStateKey(target: ResolvedVfsTarget): string {
  if (target.kind === 'workspace') {
    return `workspace:${target.path}`
  }
  if (target.kind === 'agent') {
    return `agent:${target.projectId}:${target.agentId}:${target.path}`
  }
  if (target.kind === 'skills') {
    return `skills:${target.path}`
  }
  if (target.kind === 'webmcp') {
    return `webmcp:${target.path}`
  }
  // assets
  return `assets:${target.path}`
}
