import { AssetsBackend } from '@/agent/tools/backends/assets-backend'

/** Project-owned assets survive deletion of the originating conversation. */
export async function getMCPResultAssets(projectId: string): Promise<AssetsBackend> {
  const root = await navigator.storage.getDirectory()
  const projects = await root.getDirectoryHandle('projects', { create: true })
  const project = await projects.getDirectoryHandle(projectId, { create: true })
  const assets = await project.getDirectoryHandle('assets', { create: true })
  const tasks = await assets.getDirectoryHandle('mcp-tasks', { create: true })
  return AssetsBackend.fromDirectory(tasks)
}
