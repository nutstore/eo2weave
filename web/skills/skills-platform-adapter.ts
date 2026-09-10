/**
 * Skills Platform Adapter - OPFS Implementation
 *
 * Implements @creatorweave/skills-system's PlatformAdapter
 * using OPFS (Origin Private File System) as the backing store.
 *
 * Layout:
 *   opfs-root/.skills/
 *     builtin/
 *       <skill-name>/SKILL.md
 *       <skill-name>/scripts/...
 *       <skill-name>/references/...
 *       <skill-name>/assets/...
 *     manifest.json
 */

import type {
  PlatformAdapter,
  BuiltinSkillsManifest,
} from '@creatorweave/skills-system'
import { BUILTIN_SKILLS_PACKAGE, BUNDLED_SKILL_FILES, BUNDLED_SKILL_BINARY_FILES } from './builtin-packages-registry'

const SKILLS_ROOT = '.skills'
// Manifest path is relative to the adapter root (opfs-root/.skills/),
// NOT to OPFS root, so no SKILLS_ROOT prefix needed.
const MANIFEST_PATH = 'manifest.json'

/**
 * Get or create the .skills directory handle in OPFS root.
 */
async function getSkillsRoot(): Promise<FileSystemDirectoryHandle> {
  const opfsRoot = await navigator.storage.getDirectory()
  return opfsRoot.getDirectoryHandle(SKILLS_ROOT, { create: true })
}

/**
 * Resolve a relative path (e.g. "builtin/socratic/scripts/x.py") to
 * a sequence of directory handles + final file handle.
 */
async function resolveFilePath(
  relativePath: string,
  create: boolean = false
): Promise<{ dir: FileSystemDirectoryHandle; fileName: string }> {
  const parts = relativePath.split('/')
  const fileName = parts.pop()!
  let dir = await getSkillsRoot()

  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create })
  }

  return { dir, fileName }
}

/**
 * OPFS-backed PlatformAdapter for the skills system.
 */
export const opfsSkillsAdapter: PlatformAdapter = {
  async readFile(path: string): Promise<string> {
    const { dir, fileName } = await resolveFilePath(path)
    const handle = await dir.getFileHandle(fileName)
    const file = await handle.getFile()
    return file.text()
  },

  async writeFile(path: string, content: string | ArrayBuffer): Promise<void> {
    const { dir, fileName } = await resolveFilePath(path, true)
    const handle = await dir.getFileHandle(fileName, { create: true })
    const writable = await handle.createWritable()
    await writable.write(content)
    await writable.close()
  },

  async exists(path: string): Promise<boolean> {
    try {
      const { dir, fileName } = await resolveFilePath(path)
      await dir.getFileHandle(fileName)
      return true
    } catch {
      return false
    }
  },

  async readdir(path: string): Promise<string[]> {
    try {
      const skillsRoot = await getSkillsRoot()
      let dir = skillsRoot
      for (const part of path.split('/')) {
        if (part) dir = await dir.getDirectoryHandle(part)
      }
      const entries: string[] = []
      for await (const [name] of dir.entries()) {
        entries.push(name)
      }
      return entries
    } catch {
      return []
    }
  },

  async remove(path: string): Promise<void> {
    const { dir, fileName } = await resolveFilePath(path)
    // Try file first, then directory
    try {
      await dir.removeEntry(fileName)
      return
    } catch {
      // ignore: not a plain file, fall through to recursive directory removal
    }
    try {
      await dir.removeEntry(fileName, { recursive: true })
    } catch {
      // ignore: entry already gone, best-effort removal
    }
  },

  async readLocalManifest(): Promise<BuiltinSkillsManifest | null> {
    try {
      const text = await this.readFile(MANIFEST_PATH)
      return JSON.parse(text) as BuiltinSkillsManifest
    } catch {
      return null
    }
  },

  async writeLocalManifest(manifest: BuiltinSkillsManifest): Promise<void> {
    await this.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
  },

  getBundledManifest(): BuiltinSkillsManifest {
    return BUILTIN_SKILLS_PACKAGE
  },

  async readBundledFile(skillName: string, filePath: string): Promise<string> {
    // Bundled files are imported as raw strings through webpack's asset/source rule.
    // The registry module handles the actual imports.
    const key = `${skillName}/${filePath}`
    const bundled = BUNDLED_SKILL_FILES[key]
    if (bundled !== undefined) {
      return bundled
    }
    throw new Error(`Bundled file not found: ${key}`)
  },

  /**
   * Read a bundled binary file and return it as ArrayBuffer.
   * For .b64 files, automatically resolves by appending .b64 suffix.
   */
  async readBundledBinaryFile(skillName: string, filePath: string): Promise<ArrayBuffer> {
    // Try exact key first, then with .b64 suffix
    const exactKey = `${skillName}/${filePath}`
    const b64Key = `${skillName}/${filePath}.b64`
    const base64Content = BUNDLED_SKILL_BINARY_FILES[exactKey] ?? BUNDLED_SKILL_BINARY_FILES[b64Key]
    if (base64Content === undefined) {
      throw new Error(`Bundled binary file not found: ${exactKey}`)
    }
    // Decode base64 to ArrayBuffer
    const binaryString = atob(base64Content)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    return bytes.buffer
  },

  /**
   * Check if a bundled file is binary (stored in BUNDLED_SKILL_BINARY_FILES).
   */
  isBundledBinaryFile(skillName: string, filePath: string): boolean {
    const exactKey = `${skillName}/${filePath}`
    const b64Key = `${skillName}/${filePath}.b64`
    return exactKey in BUNDLED_SKILL_BINARY_FILES || b64Key in BUNDLED_SKILL_BINARY_FILES
  },

  getAppVersion(): string {
    return BUILTIN_SKILLS_PACKAGE.appVersion
  },
}

// ============================================================================
// Direct OPFS Resource Access (for read_skill_resource tool)
//
// Reads resources directly from OPFS instead of SQLite.
// OPFS is the authoritative data source — materialize() ensures files exist.
// ============================================================================

/** Lightweight resource metadata (no content, for listing) */
export interface SkillResourceMeta {
  resourcePath: string
  resourceType: 'reference' | 'script' | 'asset'
  size: number
}

/** Full resource with content */
export interface SkillResourceData extends SkillResourceMeta {
  content: string
}

/** Known directories that map to resource types */
const RESOURCE_DIR_MAP: Record<string, 'reference' | 'script' | 'asset'> = {
  references: 'reference',
  scripts: 'script',
}

/**
 * Determine resource type from the top-level directory name.
 * "references/" → reference, "scripts/" → script, anything else → asset.
 */
function getResourceTypeFromPath(relativePath: string): 'reference' | 'script' | 'asset' {
  const topDir = relativePath.split('/')[0]
  return RESOURCE_DIR_MAP[topDir] ?? 'asset'
}

/**
 * Recursively list all files under a directory, returning relative paths.
 */
async function listFilesRecursive(
  dir: FileSystemDirectoryHandle,
  prefix: string = ''
): Promise<string[]> {
  const results: string[] = []
  for await (const [name, handle] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name
    if (handle.kind === 'directory') {
      results.push(...await listFilesRecursive(handle as FileSystemDirectoryHandle, path))
    } else {
      results.push(path)
    }
  }
  return results
}

/**
 * Read the SKILL.md file for a builtin skill directly from OPFS.
 * Returns the raw text content, or null if not found.
 *
 * This is used by read_skill to always get the latest instruction content,
 * bypassing the SQLite cache which may be stale.
 *
 * @param skillName - Skill name (e.g. "cw-word-editor")
 * @returns Raw SKILL.md text content, or null
 */
export async function readSkillMdFromOPFS(
  skillName: string
): Promise<string | null> {
  const fullPath = `builtin/${skillName}/SKILL.md`
  try {
    const { dir, fileName } = await resolveFilePath(fullPath)
    const fileHandle = await dir.getFileHandle(fileName)
    const file = await fileHandle.getFile()
    return await file.text()
  } catch {
    return null
  }
}

/**
 * List all resource files for a builtin skill from OPFS.
 * Returns metadata (path, type, size) without reading file content.
 *
 * @param skillName - Skill name (e.g. "cw-word-editor")
 * @returns Array of resource metadata
 */
export async function listSkillResourcesFromOPFS(
  skillName: string
): Promise<SkillResourceMeta[]> {
  const skillDirPath = `builtin/${skillName}`
  const resources: SkillResourceMeta[] = []

  try {
    const { dir, fileName } = await resolveFilePath(skillDirPath)
    const skillDirHandle = await dir.getDirectoryHandle(fileName)

    const allFiles = await listFilesRecursive(skillDirHandle)

    for (const filePath of allFiles) {
      // Skip SKILL.md — it's the skill instruction, not a resource
      if (filePath === 'SKILL.md') continue
      // Skip hidden files
      if (filePath.startsWith('.')) continue

      // Get file size
      let size = 0
      try {
        const { dir: fileDir, fileName: fileBase } = await resolveFilePath(`${skillDirPath}/${filePath}`)
        const fileHandle = await fileDir.getFileHandle(fileBase)
        const file = await fileHandle.getFile()
        size = file.size
      } catch {
        // Size lookup failed, still include with 0
      }

      resources.push({
        resourcePath: filePath,
        resourceType: getResourceTypeFromPath(filePath),
        size,
      })
    }
  } catch {
    // Skill directory not found in OPFS
  }

  return resources
}

/**
 * Read a specific resource file for a builtin skill from OPFS.
 * Falls back to bundled registry if file not found in OPFS.
 *
 * @param skillName - Skill name (e.g. "cw-word-editor")
 * @param resourcePath - Relative path (e.g. "scripts/writeback.py")
 * @returns Resource data with content
 */
export async function readSkillResourceFromOPFS(
  skillName: string,
  resourcePath: string
): Promise<SkillResourceData | null> {
  const fullPath = `builtin/${skillName}/${resourcePath}`

  // Try OPFS first
  try {
    const { dir, fileName } = await resolveFilePath(fullPath)
    const fileHandle = await dir.getFileHandle(fileName)
    const file = await fileHandle.getFile()

    // Check if binary — read as ArrayBuffer, encode to base64
    const ext = resourcePath.split('.').pop()?.toLowerCase() ?? ''
    const textExtensions = new Set([
      'md', 'txt', 'py', 'js', 'ts', 'json', 'yaml', 'yml', 'xml', 'html',
      'css', 'scss', 'less', 'sh', 'bash', 'sql', 'toml', 'ini', 'csv',
      'svg', 'rst', 'tex', 'c', 'cpp', 'h', 'java', 'rb', 'go', 'rs',
    ])

    if (textExtensions.has(ext)) {
      const content = await file.text()
      return {
        resourcePath,
        resourceType: getResourceTypeFromPath(resourcePath),
        size: file.size,
        content,
      }
    } else {
      // Binary file — encode as base64 for transport
      const buffer = await file.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      let binary = ''
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i])
      }
      const content = btoa(binary)
      return {
        resourcePath,
        resourceType: getResourceTypeFromPath(resourcePath),
        size: file.size,
        content: `[binary:${ext}:base64] ${content.substring(0, 100)}...(${file.size} bytes)`,
      }
    }
  } catch {
    // Not in OPFS, fall through to bundled registry
  }

  // Fallback: try bundled registry
  try {
    const key = `${skillName}/${resourcePath}`
    const b64Key = `${skillName}/${resourcePath}.b64`

    // Text file
    if (key in BUNDLED_SKILL_FILES) {
      return {
        resourcePath,
        resourceType: getResourceTypeFromPath(resourcePath),
        size: new TextEncoder().encode(BUNDLED_SKILL_FILES[key]).length,
        content: BUNDLED_SKILL_FILES[key],
      }
    }

    // Binary file
    if (b64Key in BUNDLED_SKILL_BINARY_FILES || key in BUNDLED_SKILL_BINARY_FILES) {
      const base64 = BUNDLED_SKILL_BINARY_FILES[b64Key] ?? BUNDLED_SKILL_BINARY_FILES[key]
      return {
        resourcePath,
        resourceType: getResourceTypeFromPath(resourcePath),
        size: atob(base64).length,
        content: `[binary:base64] (${atob(base64).length} bytes)`,
      }
    }
  } catch {
    // Bundled registry fallback failed
  }

  return null
}
