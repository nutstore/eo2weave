import { ProjectManager, type AgentManager } from '@/opfs'
import { useAgentsStore } from '@/store/agents.store'
import type { ToolContext } from './tool-types'
import type { VfsBackend } from './vfs-backend'
import { WorkspaceBackend } from './backends/workspace-backend'
import { AgentBackend } from './backends/agent-backend'
import { AssetsBackend } from './backends/assets-backend'
import { SkillsBackend } from './backends/skills-backend'
import { ProviderBackend, ProvidersRootBackend } from './backends/provider-backend'
import { isProtectedAgentCoreFile } from './agent-file-protection'

export { isProtectedAgentCoreFile } from './agent-file-protection'

export type VfsAction = 'read' | 'write' | 'delete' | 'list'

export interface WorkspaceTarget {
  kind: 'workspace'
  path: string
  backend: VfsBackend
}

export interface AgentTarget {
  kind: 'agent'
  path: string
  agentId: string
  projectId: string
  agentManager: AgentManager
  backend: VfsBackend
}

export interface AssetsTarget {
  kind: 'assets'
  path: string
  backend: VfsBackend
}

export interface SkillsTarget {
  kind: 'skills'
  path: string
  backend: VfsBackend
}

export interface ExternalTarget {
  kind: 'external'
  mountName: string
  path: string
  backend: VfsBackend
}

export type ResolvedVfsTarget = WorkspaceTarget | AgentTarget | AssetsTarget | SkillsTarget | ExternalTarget

interface ParsedPath {
  namespace: 'workspace' | 'agents' | 'assets' | 'skills' | 'external'
  path: string
  agentId?: string
}

let projectManagerPromise: Promise<ProjectManager> | null = null

export const AGENT_ID_FORMAT_HINT =
  'Allowed agentId chars: letters (including Chinese), numbers, "_" and "-". Disallowed: spaces and "/".'

const AGENT_ID_PATH_EXAMPLES =
  'Examples: vfs://agents/default/IDENTITY.md, vfs://agents/墨染/IDENTITY.md'

export function withVfsAgentIdHint(message: string): string {
  if (!message.includes('Invalid agent id in vfs path')) return message
  if (message.includes(AGENT_ID_PATH_EXAMPLES)) return message
  return `${message} ${AGENT_ID_PATH_EXAMPLES}`
}

function isValidAgentId(input: string): boolean {
  return /^[\p{L}\p{N}_-]+$/u.test(input)
}

function normalizeRelativePath(path: string, options?: { allowEmpty?: boolean }): string {
  const allowEmpty = options?.allowEmpty ?? false
  const normalized = path.replace(/\\/g, '/').trim()
  const withoutQuery = normalized.split('?')[0]
  const withoutMnt =
    withoutQuery.startsWith('/mnt/')
      ? withoutQuery.slice('/mnt/'.length)
      : withoutQuery === '/mnt'
        ? ''
        : withoutQuery
  const withoutLeading = withoutMnt.replace(/^\/+/, '')
  const parts = withoutLeading.split('/').filter(Boolean)

  if (parts.length === 0) {
    if (allowEmpty) return ''
    throw new Error('Path cannot be empty')
  }
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error('Path cannot include "." or ".."')
  }

  return parts.join('/')
}

function parseVfsPath(
  rawPath: string,
  options?: { allowEmptyPath?: boolean; allowAgentsNamespaceRoot?: boolean }
): ParsedPath {
  const allowEmptyPath = options?.allowEmptyPath ?? false
  const allowAgentsNamespaceRoot = options?.allowAgentsNamespaceRoot ?? false
  if (!rawPath.startsWith('vfs://')) {
    return {
      namespace: 'workspace',
      path: normalizeRelativePath(rawPath, { allowEmpty: allowEmptyPath }),
    }
  }

  const raw = rawPath.slice('vfs://'.length).split('?')[0]
  const parts = raw.split('/').filter(Boolean)
  const namespace = parts[0]

  if (namespace === 'workspace') {
    return {
      namespace: 'workspace',
      path: normalizeRelativePath(parts.slice(1).join('/'), { allowEmpty: allowEmptyPath }),
    }
  }

  if (namespace === 'agents' || namespace === 'agent') {
    const agentId = parts[1] || ''
    if (!agentId) {
      if (allowAgentsNamespaceRoot) {
        return {
          namespace: 'agents',
          agentId: '',
          path: '',
        }
      }
      throw new Error(`Invalid agent id in vfs path. ${AGENT_ID_FORMAT_HINT}`)
    }
    if (!isValidAgentId(agentId)) {
      throw new Error(`Invalid agent id in vfs path: "${agentId}". ${AGENT_ID_FORMAT_HINT}`)
    }
    return {
      namespace: 'agents',
      agentId,
      path: normalizeRelativePath(parts.slice(2).join('/'), { allowEmpty: allowEmptyPath }),
    }
  }

  if (namespace === 'assets' || namespace === 'asset') {
    return {
      namespace: 'assets',
      path: normalizeRelativePath(parts.slice(1).join('/'), { allowEmpty: allowEmptyPath }),
    }
  }

  if (namespace === 'skills' || namespace === 'skill') {
    return {
      namespace: 'skills',
      path: normalizeRelativePath(parts.slice(1).join('/'), { allowEmpty: allowEmptyPath }),
    }
  }

  if (namespace === 'external') {
    return {
      namespace: 'external',
      path: normalizeRelativePath(parts.slice(1).join('/'), { allowEmpty: allowEmptyPath }),
    }
  }

  throw new Error(`Unsupported vfs namespace: ${namespace || '(empty)'}`)
}

function resolveProjectId(context: ToolContext): string | null {
  // projectId is always provided by the agent loop. If missing, that's a caller bug.
  return context.projectId?.trim() || null
}

function resolveActorAgentId(context: ToolContext): string | null {
  if (context.currentAgentId && context.currentAgentId.trim()) {
    return context.currentAgentId
  }
  const fromStore = useAgentsStore.getState().activeAgentId
  if (fromStore && fromStore.trim()) return fromStore
  return 'default'
}

async function getProjectManager(): Promise<ProjectManager> {
  if (!projectManagerPromise) {
    projectManagerPromise = ProjectManager.create()
  }
  return projectManagerPromise
}

function canWriteAgentPath(actorAgentId: string | null, targetAgentId: string): boolean {
  if (!actorAgentId) return false
  if (actorAgentId === 'default') return true
  return actorAgentId === targetAgentId
}

export async function resolveVfsTarget(
  rawPath: string,
  context: ToolContext,
  action: VfsAction,
  options?: { allowEmptyPath?: boolean }
): Promise<ResolvedVfsTarget> {
  const parsed = parseVfsPath(rawPath, {
    ...options,
    allowAgentsNamespaceRoot: action === 'list' && (options?.allowEmptyPath ?? false),
  })

  if (parsed.namespace === 'assets') {
    return {
      kind: 'assets',
      path: parsed.path,
      backend: new AssetsBackend(context.workspaceId),
    }
  }

  if (parsed.namespace === 'skills') {
    return {
      kind: 'skills',
      path: parsed.path,
      backend: new SkillsBackend(),
    }
  }

  if (parsed.namespace === 'external') {
    const [mountName, ...parts] = parsed.path.split('/').filter(Boolean)
    if (!mountName) {
      if (action !== 'list') throw new Error('External root can only be listed')
      return { kind: 'external', mountName: '', path: '', backend: new ProvidersRootBackend() }
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(mountName)) throw new Error('Invalid external mount name')
    return { kind: 'external', mountName, path: parts.join('/'), backend: new ProviderBackend(mountName) }
  }

  if (parsed.namespace === 'workspace') {
    return {
      kind: 'workspace',
      path: parsed.path,
      backend: new WorkspaceBackend(
        context.workspaceId,
        context.directoryHandle,
        resolveProjectId(context),
        context.onWorkspacePathsChanged,
      ),
    }
  }

  if (context.isSubagent) {
    if (isProtectedAgentCoreFile(parsed.path)) {
      throw new Error(`PERMISSION_DENIED: subagents cannot access protected agent file "${parsed.path}"`)
    }
    // Listing an agent root enables search/glob traversal over protected files.
    if (action === 'list' && !parsed.path) {
      throw new Error('PERMISSION_DENIED: subagents cannot enumerate an agent root')
    }
  }

  // agents namespace
  const projectId = resolveProjectId(context)
  if (!projectId) {
    throw new Error('No active project for agent namespace path')
  }

  const projectManager = await getProjectManager()
  const project = await projectManager.getProject(projectId)
  if (!project) {
    throw new Error(`Project not found: ${projectId}`)
  }

  if (action !== 'read' && action !== 'list') {
    const actorAgentId = resolveActorAgentId(context)
    if (!canWriteAgentPath(actorAgentId, parsed.agentId!)) {
      throw new Error(`Forbidden: agent "${actorAgentId || 'unknown'}" cannot ${action} agent "${parsed.agentId}"`)
    }
  }

  const agentManager = project.agentManager
  return {
    kind: 'agent',
    path: parsed.path,
    agentId: parsed.agentId!,
    projectId,
    agentManager,
    backend: new AgentBackend(agentManager, parsed.agentId!),
  }
}

export function isVfsPath(path: string): boolean {
  return path.startsWith('vfs://')
}
