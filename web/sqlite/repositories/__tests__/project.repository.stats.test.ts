import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectRepository } from '@/sqlite/repositories/project.repository'

// `findProjectStats` backs both the project cards' "N conversations" label and
// the WebMCP `list_projects` tool. Standalone chats keep a hidden host
// workspace row (the schema has NOT NULL project_id) while every project-scoped
// listing filters them out via `findWorkspacesByProject`, so an unfiltered
// count made the two disagree — a project hosting one project conversation and
// one standalone chat reported 2 conversations and listed 1 (#268).
//
// The filter has to live inside the aggregate join, not a WHERE clause: a
// project that hosts ONLY standalone chats must still appear with a zero count.
// `IS NOT` is null-safe in SQLite, so workspaces with no conversation row stay
// counted, which is what findWorkspacesByProject does too.

const queryAll = vi.hoisted(() => vi.fn(async (_sql: string, _params?: unknown[]) => [] as unknown))

vi.mock('@/sqlite/sqlite-database', () => ({
  getSQLiteDB: () => ({ queryAll }),
  generateId: (prefix: string) => `${prefix}-test`,
}))
vi.mock('@/security/secret-key-scope', () => ({
  getProjectSecretStoragePrefix: (projectId: string) => `proj:${projectId}:`,
}))

const statsSql = (): string => {
  const call = queryAll.mock.calls.find(([sql]) => String(sql).includes('workspace_count'))
  expect(call).toBeDefined()
  return String(call![0])
}

describe('ProjectRepository.findProjectStats — standalone-chat hosts excluded', () => {
  beforeEach(() => {
    queryAll.mockClear()
    queryAll.mockResolvedValue([])
  })

  it('joins conversations and filters kind=direct inside the aggregates', async () => {
    await new ProjectRepository().findProjectStats()

    const sql = statsSql()
    expect(sql).toContain('LEFT JOIN conversations c ON c.id = w.id')
    // Both the count and the last-access timestamp ignore standalone chats —
    // a direct chat opening must not drive the project's "last accessed".
    expect(sql).toContain("COUNT(CASE WHEN c.kind IS NOT 'direct' THEN w.id END) AS workspace_count")
    expect(sql).toContain(
      "MAX(CASE WHEN c.kind IS NOT 'direct' THEN w.last_accessed_at END) AS last_workspace_access_at"
    )
    // Null-safe form: a workspace without a conversation row (legacy/orphan)
    // stays counted, matching findWorkspacesByProject.
    expect(sql).not.toContain("c.kind = 'direct'")
    expect(sql).not.toContain("c.kind != 'direct'")
  })

  it('keeps the kind filter out of a WHERE clause so zero-count projects survive', async () => {
    await new ProjectRepository().findProjectStats()

    expect(statsSql()).not.toMatch(/WHERE[\s\S]*conversations/i)
  })

  it('maps empty aggregates to 0 / undefined instead of NaN', async () => {
    queryAll.mockResolvedValue([
      { project_id: 'p-direct-only', workspace_count: 0, last_workspace_access_at: null },
      { project_id: 'p-null-count', workspace_count: null, last_workspace_access_at: null },
    ])

    const stats = await new ProjectRepository().findProjectStats()

    expect(stats).toEqual([
      { projectId: 'p-direct-only', workspaceCount: 0, lastWorkspaceAccessAt: undefined },
      { projectId: 'p-null-count', workspaceCount: 0, lastWorkspaceAccessAt: undefined },
    ])
  })
})
