/**
 * Route path constants and builders — the single source of truth for
 * in-app navigation targets.
 *
 * Replaces the orphaned `web/router.ts` (which had zero importers) and the
 * hardcoded path template strings that were scattered across components.
 *
 * URL shapes (App Router):
 *   /projects                                     — project home
 *   /projects/:projectId                          — bare project (layout picks workspace)
 *   /projects/:projectId/workspaces/:workspaceId  — canonical workspace URL
 *   /chats                                        — standalone chats home
 *   /chats/:chatId                                — standalone chat (kind='direct' conversation)
 *   /docs[/:language[/:category[/:page]]]         — documentation
 *   /preview?path=...                             — standalone file preview
 *
 * NOTE: the legacy singular form `/projects/:projectId/workspace` is kept
 * alive only as an HTTP redirect in next.config.mjs for old bookmarks; all
 * internal navigation must use `projectWorkspacePath()` (bare or canonical).
 *
 * NOTE: sw.ts intentionally does NOT import from this module — the service
 * worker bundle is dependency-free by design (transpiled without bundler).
 */

/** Route path patterns (informational — matching is owned by the App Router). */
export const ROUTE_PATHS = {
  projectsHome: '/projects',
  projectWorkspace: '/projects/:projectId',
  projectWorkspaceWithId: '/projects/:projectId/workspaces/:workspaceId',
  chatsHome: '/chats',
  chat: '/chats/:chatId',
  filePreview: '/preview',
  docs: '/docs',
  docsLanguage: '/docs/:language',
  docsCategory: '/docs/:language/:category',
  docsPage: '/docs/:language/:category/:page',
} as const

/** Project home. */
export function projectsPath(): string {
  return '/projects'
}

/** Standalone chats home (/chats) — kind='direct' conversations live here. */
export function chatsPath(): string {
  return '/chats'
}

/** Canonical standalone chat URL. */
export function chatPath(chatId: string): string {
  return `/chats/${encodeURIComponent(chatId)}`
}

/**
 * Build a project workspace path.
 * - No workspaceId → bare project URL (workspace resolved from state)
 * - workspaceId    → canonical `/projects/:id/workspaces/:workspaceId`
 */
export function projectWorkspacePath(projectId: string, workspaceId?: string): string {
  const base = `/projects/${encodeURIComponent(projectId)}`
  if (workspaceId) {
    return `${base}/workspaces/${encodeURIComponent(workspaceId)}`
  }
  return base
}

/** Build a docs path from optional segments. */
export function docsPath(language?: string, category?: string, page?: string): string {
  const parts = ['docs', language, category, page].filter(Boolean)
  return '/' + parts.join('/')
}
