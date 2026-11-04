import { parseGitIgnore, type GitIgnoreRule } from '@/opfs/native-disk/gitignore-policy'
import type { VfsBackend } from '@/agent/tools/vfs-backend'

/** Read rules from the backend root through the supplied directory. */
export async function readBackendIgnoreRules(backend: VfsBackend, path: string): Promise<GitIgnoreRule[]> {
  const rules: GitIgnoreRule[] = []
  let directory = ''
  for (const segment of [...path.split('/').filter(Boolean), '']) {
    try {
      const file = await backend.readFile(directory ? `${directory}/.gitignore` : '.gitignore', { encoding: 'text' })
      if (typeof file.content === 'string') rules.push(...parseGitIgnore(file.content, directory))
    } catch { /* Optional ignore file. */ }
    if (segment) directory = directory ? `${directory}/${segment}` : segment
  }
  return rules
}

/** Extend the inherited discovery rules with this directory's .gitignore. */
export async function readHandleIgnoreRules(
  entries: readonly FileSystemHandle[],
  relativePath: string,
  inherited: GitIgnoreRule[],
  includeIgnored: boolean,
): Promise<GitIgnoreRule[]> {
  if (includeIgnored) return inherited
  const file = entries.find((entry) => entry.kind === 'file' && entry.name === '.gitignore') as FileSystemFileHandle | undefined
  if (!file) return inherited
  try {
    return [...inherited, ...parseGitIgnore(await (await file.getFile()).text(), relativePath)]
  } catch {
    return inherited
  }
}

/** Read ignore files above a selected directory. */
export async function readHandleAncestorRules(root: FileSystemDirectoryHandle, path: string): Promise<GitIgnoreRule[]> {
  let rules: GitIgnoreRule[] = []
  let directory = root
  let relativePath = ''
  for (const segment of path.split('/').filter(Boolean)) {
    try {
      const file = await directory.getFileHandle('.gitignore')
      rules = [...rules, ...parseGitIgnore(await (await file.getFile()).text(), relativePath)]
    } catch { /* Optional ignore file. */ }
    try {
      directory = await directory.getDirectoryHandle(segment)
    } catch {
      break
    }
    relativePath = relativePath ? `${relativePath}/${segment}` : segment
  }
  return rules
}

/** Read this directory's rules without buffering its entries. */
export async function readDirectoryIgnoreRules(directory: FileSystemDirectoryHandle, path: string, inherited: GitIgnoreRule[]): Promise<GitIgnoreRule[]> {
  try {
    const file = await directory.getFileHandle('.gitignore')
    return [...inherited, ...parseGitIgnore(await (await file.getFile()).text(), path)]
  } catch {
    return inherited
  }
}
