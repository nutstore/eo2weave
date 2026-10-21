/**
 * Skill Tools - read_skill and read_skill_resource tools
 *
 * These tools allow the LLM to load skill content and resources on-demand
 * instead of injecting all skills into the system prompt.
 */

import { readProviderSkillFile, listProviderSkillResources } from './provider-skills'
import type { ToolDefinition, ToolExecutor, ToolContext, ToolPromptDoc } from '@/agent/tools/tool-types'
import { toolOkJson, toolErrorJson } from '@/agent/tools/tool-envelope'
import { formatResourceList } from './skill-resources'
import { getSkillManager } from './skill-manager'
import {
  listSkillResourcesFromOPFS,
  readSkillResourceFromOPFS,
  readSkillMdFromOPFS,
} from './skills-platform-adapter'
import {
  readProjectSkillMdFromNativeFs,
  listProjectSkillResourcesFromNativeFs,
  readProjectSkillResourceFromNativeFs,
} from './project-skill-live-reader'

/**
 * Read SKILL.md from OPFS for a user skill.
 * User skills live at `.skills/user/<skill-dir>/SKILL.md`.
 * Returns the raw text content, or null if not found.
 */
async function readUserSkillMdFromOPFS(skillDirName: string): Promise<string | null> {
  try {
    const opfsRoot = await navigator.storage.getDirectory()
    const skillsDir = await opfsRoot.getDirectoryHandle('.skills')
    const userDir = await skillsDir.getDirectoryHandle('user')
    const skillDir = await userDir.getDirectoryHandle(skillDirName)
    const fileHandle = await skillDir.getFileHandle('SKILL.md')
    const file = await fileHandle.getFile()
    return await file.text()
  } catch {
    return null
  }
}

/**
 * List resource files for a user skill from OPFS.
 */
async function listUserSkillResourcesFromOPFS(
  skillDirName: string
): Promise<Array<{ resourcePath: string; resourceType: string; size: number }>> {
  const resources: Array<{ resourcePath: string; resourceType: string; size: number }> = []
  const ignored = new Set(['SKILL.md'])
  try {
    const opfsRoot = await navigator.storage.getDirectory()
    const skillsDir = await opfsRoot.getDirectoryHandle('.skills')
    const userDir = await skillsDir.getDirectoryHandle('user')
    const skillDir = await userDir.getDirectoryHandle(skillDirName)

    const scanRecursive = async (
      dir: FileSystemDirectoryHandle,
      prefix: string
    ): Promise<void> => {
      for await (const [name, handle] of dir.entries()) {
        const relPath = prefix ? `${prefix}/${name}` : name
        if (handle.kind === 'directory') {
          await scanRecursive(handle as FileSystemDirectoryHandle, relPath)
        } else {
          if (ignored.has(name)) continue
          let size = 0
          try {
            const file = await (handle as FileSystemFileHandle).getFile()
            size = file.size
          } catch { /* skip */ }
          const topDir = relPath.split('/')[0]
          const type = topDir === 'references' ? 'reference' : topDir === 'scripts' ? 'script' : 'asset'
          resources.push({ resourcePath: relPath, resourceType: type, size })
        }
      }
    }

    await scanRecursive(skillDir, '')
  } catch {
    // directory not found
  }
  return resources
}

/**
 * Read a specific resource file for a user skill from OPFS.
 */
async function readUserSkillResourceFromOPFS(
  skillDirName: string,
  resourcePath: string
): Promise<{ content: string; resourceType: string; size: number } | null> {
  try {
    const opfsRoot = await navigator.storage.getDirectory()
    const skillsDir = await opfsRoot.getDirectoryHandle('.skills')
    const userDir = await skillsDir.getDirectoryHandle('user')
    const skillDir = await userDir.getDirectoryHandle(skillDirName)

    // Navigate to the file via path segments
    const parts = resourcePath.split('/').filter(Boolean)
    const fileName = parts.pop()!
    let dir = skillDir
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part)
    }
    const fileHandle = await dir.getFileHandle(fileName)
    const file = await fileHandle.getFile()
    const content = await file.text()
    const topDir = resourcePath.split('/')[0]
    const type = topDir === 'references' ? 'reference' : topDir === 'scripts' ? 'script' : 'asset'
    return { content, resourceType: type, size: file.size }
  } catch {
    return null
  }
}

//=============================================================================
// read_skill Tool
//=============================================================================

/**
 * Static tool definition for read_skill
 */
export const readSkillDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_skill',
    description:
      "Load the full content of a skill by its name. Use this when you need detailed instructions for a task that matches a skill's description. Only load skills listed in <available_skills>.",
    parameters: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: 'The name of the skill to load (e.g., "code-review", "debugging")',
        },
      },
      required: ['skill_name'],
    },
  },
}

/**
 * Executor for read_skill tool
 * Returns full skill content including instruction, examples, and resource list.
 *
 * For builtin skills: resource list is scanned from OPFS directory.
 * For project/user skills: resource list comes from SQLite storage.
 */
export const readSkillExecutor: ToolExecutor = async (
  args: Record<string, unknown>,
  _context: ToolContext
): Promise<string> => {
  const { skill_name } = args as { skill_name: string }
  const manager = getSkillManager()
  await manager.initialize()
  await manager.refreshProviderSkills()

  // Case-insensitive lookup
  const skillName = skill_name.trim()
  const skill = manager.getSkillByName(skillName)

  if (!skill) {
    const availableSkills = manager.getEnabledSkillNames()
    return toolErrorJson('read_skill', 'skill_not_found', `Skill '${skill_name}' not found. Available skills: ${availableSkills.join(', ')}`)
  }

  // Get associated resources — read directly from OPFS/native FS for
  // builtin/user/project skills (real-time), fallback to cache for project skills.
  const isBuiltin = skill.source === 'builtin'
  const isUser = skill.source === 'user'
  const isProject = skill.source === 'project'
  let resources: Array<{ resourcePath: string; resourceType: string; size: number; id?: string; skillId?: string; content?: string; contentType?: string; createdAt?: number }> = []

  // For builtin skills: read SKILL.md directly from OPFS to get latest content
  // (SQLite only stores metadata for fast lookup; instruction/examples/templates come from files)
  let liveInstruction = skill.instruction
  let liveExamples = skill.examples
  let liveTemplates = skill.templates

  // For user skills: the skill directory name is the part after 'user:'
  const userDirName = isUser ? skill.id.replace(/^user:/, '') : ''

  if (skill.source === 'provider') {
    try {
      const { parseSkillMd } = await import('./skill-parser')
      const parsed = parseSkillMd(await readProviderSkillFile(skill, 'SKILL.md'), 'provider')
      if (!parsed.skill) throw new Error('Invalid SKILL.md')
      liveInstruction = parsed.skill.instruction
      liveExamples = parsed.skill.examples
      liveTemplates = parsed.skill.templates
      resources = await listProviderSkillResources(skill)
    } catch (error) {
      return toolErrorJson('read_skill', 'provider_unavailable', String(error))
    }
  } else if (isBuiltin) {
    // Builtin skills: scan OPFS directory for resource files
    resources = await listSkillResourcesFromOPFS(skill.name)

    // Read and parse SKILL.md directly from OPFS (always up-to-date)
    const skillMdContent = await readSkillMdFromOPFS(skill.name)
    if (skillMdContent) {
      const { parseSkillMd } = await import('./skill-parser')
      const parsed = parseSkillMd(skillMdContent, 'builtin')
      if (parsed.skill) {
        liveInstruction = parsed.skill.instruction
        liveExamples = parsed.skill.examples
        liveTemplates = parsed.skill.templates
      }
    }
  } else if (isUser) {
    // User skills: scan OPFS `.skills/user/<dirName>/` for resource files
    resources = await listUserSkillResourcesFromOPFS(userDirName)

    // Read and parse SKILL.md directly from OPFS
    const skillMdContent = await readUserSkillMdFromOPFS(userDirName)
    if (skillMdContent) {
      const { parseSkillMd } = await import('./skill-parser')
      const parsed = parseSkillMd(skillMdContent, 'user')
      if (parsed.skill) {
        liveInstruction = parsed.skill.instruction
        liveExamples = parsed.skill.examples
        liveTemplates = parsed.skill.templates
      }
    }
  } else if (isProject) {
    // Project skills: read SKILL.md and resources directly from native FS
    // (real-time, bypassing the in-memory cache that may be stale after
    // external file edits that didn't trigger a re-scan).
    //
    // The in-memory cache (`scanProjectSkills`) is only refreshed when
    // `skillsScanVersion` bumps. Files edited externally (outside of the
    // app's SkillFileEditor / file-tree refresh) bypass that bump, so the
    // cache serves stale instruction + stale resource list. Reading from
    // native FS here mirrors what builtin/user skills already do with OPFS.
    const liveMd = await readProjectSkillMdFromNativeFs(skill.id, _context)
    if (liveMd) {
      const { parseSkillMd } = await import('./skill-parser')
      const parsed = parseSkillMd(liveMd, 'project')
      if (parsed.skill) {
        liveInstruction = parsed.skill.instruction
        liveExamples = parsed.skill.examples
        liveTemplates = parsed.skill.templates
      }
      // Live resource list from native FS. If native FS read returns
      // nothing AND the cached list is non-empty, the handle may be revoked
      // — fall back to cache so the skill remains usable.
      const liveResources = await listProjectSkillResourcesFromNativeFs(skill.id, _context)
      if (liveResources.length > 0) {
        resources = liveResources
      } else {
        const cached = await manager.getSkillResources(skill.id)
        resources = cached.length > 0 ? cached : liveResources
      }
    } else {
      // SKILL.md not readable from native FS (handle revoked, path changed,
      // project not active in this tab, etc.) — fall back to cache.
      resources = await manager.getSkillResources(skill.id)
    }
  } else {
    // Unknown source — use SQLite storage
    resources = await manager.getSkillResources(skill.id)
  }

  // Format output using live content
  let output = `# ${skill.name}\n\n**Version:** ${skill.version}\n**Author:** ${skill.author || 'Unknown'}\n**Category:** ${skill.category}\n**Tags:** ${skill.tags.join(', ') || 'None'}\n\n---\n\n${liveInstruction}\n`

  if (liveExamples) {
    try {
      const examples = JSON.parse(liveExamples)
      if (Array.isArray(examples) && examples.length > 0) {
        output += `\n## Examples\n\n`
        examples.forEach((ex: unknown, i: number) => {
          output += `### Example ${i + 1}\n\`\`\`\n${JSON.stringify(ex, null, 2)}\n\`\`\`\n\n`
        })
      }
    } catch {
      // If examples is not valid JSON, include as-is
      output += `\n## Examples\n\n${liveExamples}\n`
    }
  }

  if (liveTemplates) {
    try {
      const templates = JSON.parse(liveTemplates)
      if (Array.isArray(templates) && templates.length > 0) {
        output += `\n## Templates\n\n`
        templates.forEach((tmpl: unknown, i: number) => {
          output += `### Template ${i + 1}\n\`\`\`\n${JSON.stringify(tmpl, null, 2)}\n\`\`\`\n\n`
        })
      }
    } catch {
      // If templates is not valid JSON, include as-is
      output += `\n## Templates\n\n${liveTemplates}\n`
    }
  }

  // Append resource list
  if (resources.length > 0) {
    output += formatResourceList(resources as any)
  }

  // Append /mnt_skills path hint for Python execution
  if (isBuiltin) {
    output += `\n\n**Python execution path:** \`/mnt_skills/builtin/${skill.name}/\``
  } else if (isUser) {
    output += `\n\n**Python execution path:** \`/mnt_skills/user/${userDirName}/\``
  }

  if (skill.providerLocation) {
    output += `\n\n**Resource root:** vfs://external/${skill.providerLocation.mountName}/${skill.providerLocation.directory}/`
  }

  output += `\n---\n*Skill: ${skill.name}*`

  return toolOkJson('read_skill', output)
}

//=============================================================================
// read_skill_resource Tool
//=============================================================================

/**
 * Static tool definition for read_skill_resource
 * The skill_name and resource_path are validated at runtime
 */
export const readSkillResourceDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_skill_resource',
    description:
      'Read a specific resource file from a skill (reference, script, or asset).\n\nAvailable resources are listed when you call read_skill.',
    parameters: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: 'The name of the skill that owns this resource',
        },
        resource_path: {
          type: 'string',
          description:
            'The path to the resource (e.g., "references/api-docs.md", "scripts/analyze.py")',
        },
      },
      required: ['skill_name', 'resource_path'],
    },
  },
}

/**
 * Executor for read_skill_resource tool
 * Returns the content of a specific resource file.
 *
 * For builtin skills: reads directly from OPFS (no SQLite involved).
 * For project/user skills: reads from SQLite storage.
 */
export const readSkillResourceExecutor: ToolExecutor = async (
  args: Record<string, unknown>,
  _context: ToolContext
): Promise<string> => {
  const { skill_name, resource_path } = args as { skill_name: string; resource_path: string }
  const manager = getSkillManager()
  await manager.initialize()
  await manager.refreshProviderSkills()

  // Case-insensitive skill lookup
  const skillName = skill_name.trim()
  const skill = manager.getSkillByName(skillName)

  if (!skill) {
    return toolErrorJson('read_skill_resource', 'skill_not_found', `Skill '${skill_name}' not found. Please check the skill name and try again.`)
  }

  if (skill.source === 'provider') {
    try {
      const content = await readProviderSkillFile(skill, resource_path)
      return toolOkJson('read_skill_resource', `# ${skill.id}/${resource_path}\n\n${content}`)
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        const available = await listProviderSkillResources(skill).catch(() => [])
        const availablePaths = available.map((r) => `  - ${r.resourcePath}`).join('\n')
        return toolErrorJson(
          'read_skill_resource',
          'resource_not_found',
          `Resource '${resource_path}' not found in skill '${skill_name}'.\n\nAvailable resources in this skill:\n${availablePaths || '  (none)'}`
        )
      }
      return toolErrorJson('read_skill_resource', 'resource_unavailable', String(error))
    }
  }

  // For builtin skills: read directly from OPFS
  if (skill.source === 'builtin') {
    const resource = await readSkillResourceFromOPFS(skill.name, resource_path)

    if (!resource) {
      const available = await listSkillResourcesFromOPFS(skill.name)
      const availablePaths = available.map((r) => `  - ${r.resourcePath}`).join('\n')
      return toolErrorJson(
        'read_skill_resource',
        'resource_not_found',
        `Resource '${resource_path}' not found in skill '${skill_name}'.\n\nAvailable resources in this skill:\n${availablePaths || '  (none)'}`
      )
    }

    const typeLabel = resource.resourceType.charAt(0).toUpperCase() + resource.resourceType.slice(1)
    const output = `# ${skill.id}/${resource.resourcePath}\n\n**Type:** ${typeLabel}\n**Size:** ${resource.size} bytes\n\n---\n\n${resource.content}`

    return toolOkJson('read_skill_resource', output)
  }

  // For user skills: read directly from OPFS `.skills/user/<dirName>/`
  if (skill.source === 'user') {
    const userDirName = skill.id.replace(/^user:/, '')
    const resource = await readUserSkillResourceFromOPFS(userDirName, resource_path)

    if (!resource) {
      const available = await listUserSkillResourcesFromOPFS(userDirName)
      const availablePaths = available.map((r) => `  - ${r.resourcePath}`).join('\n')
      return toolErrorJson(
        'read_skill_resource',
        'resource_not_found',
        `Resource '${resource_path}' not found in skill '${skill_name}'.\n\nAvailable resources in this skill:\n${availablePaths || '  (none)'}`
      )
    }

    const typeLabel = resource.resourceType.charAt(0).toUpperCase() + resource.resourceType.slice(1)
    const output = `# ${skill.id}/${resource_path}\n\n**Type:** ${typeLabel}\n**Size:** ${resource.size} bytes\n\n---\n\n${resource.content}`

    return toolOkJson('read_skill_resource', output)
  }

  // For project skills: read directly from native FS (real-time).
  // The in-memory cache may be stale if files were edited externally without
  // triggering a re-scan. Falls back to cache if the native handle is unavailable.
  if (skill.source === 'project') {
    const resource = await readProjectSkillResourceFromNativeFs(skill.id, resource_path, _context)

    if (resource) {
      const typeLabel = resource.resourceType.charAt(0).toUpperCase() + resource.resourceType.slice(1)
      const output = `# ${skill.id}/${resource_path}\n\n**Type:** ${typeLabel}\n**Content-Type:** ${resource.contentType}\n**Size:** ${resource.size} bytes\n\n---\n\n${resource.content}`
      return toolOkJson('read_skill_resource', output)
    }

    // Live read failed (handle revoked, file removed, etc.) — fall back to cache.
    const cached = await manager.getSkillResources(skill.id)
    const cachedResource = cached.find((r) => r.resourcePath === resource_path)
    if (cachedResource) {
      const typeLabel = cachedResource.resourceType.charAt(0).toUpperCase() + cachedResource.resourceType.slice(1)
      const output = `# ${cachedResource.skillId}/${cachedResource.resourcePath}\n\n**Type:** ${typeLabel}\n**Content-Type:** ${cachedResource.contentType}\n**Size:** ${cachedResource.size} bytes\n\n---\n\n${cachedResource.content}`
      return toolOkJson('read_skill_resource', output)
    }

    // Not in cache either — report available resources (live + cache)
    const liveAvailable = await listProjectSkillResourcesFromNativeFs(skill.id, _context)
    const availablePaths = (liveAvailable.length > 0 ? liveAvailable : cached)
      .map((r) => `  - ${r.resourcePath}`).join('\n')
    return toolErrorJson(
      'read_skill_resource',
      'resource_not_found',
      `Resource '${resource_path}' not found in skill '${skill_name}'.\n\nAvailable resources in this skill:\n${availablePaths || '  (none)'}`
    )
  }

  // Fallback for unknown sources: use SQLite storage
  const available = await manager.getSkillResources(skill.id)
  const resource = available.find((r) => r.resourcePath === resource_path)

  if (!resource) {
    const availablePaths = available.map((r) => `  - ${r.resourcePath}`).join('\n')
    return toolErrorJson(
      'read_skill_resource',
      'resource_not_found',
      `Resource '${resource_path}' not found in skill '${skill_name}'.\n\nAvailable resources in this skill:\n${availablePaths || '  (none)'}`
    )
  }

  // Format output with content type information
  const typeLabel = resource.resourceType.charAt(0).toUpperCase() + resource.resourceType.slice(1)
  const output = `# ${resource.skillId}/${resource.resourcePath}\n\n**Type:** ${typeLabel}\n**Content-Type:** ${resource.contentType}\n**Size:** ${resource.size} bytes\n\n---\n\n${resource.content}`

  return toolOkJson('read_skill_resource', output)
}

export const skillPromptDoc: ToolPromptDoc = {
  category: 'skills',
  section: '### Skill Tools',
  lines: [
    '- `read_skill(skill_name)` - Load the full content of a skill by its name. Only load skills listed in <available_skills>.',
    '- `read_skill_resource(skill_name, resource_path)` - Read a specific resource file from a skill (reference, script, or asset)',
  ],
}
