/**
 * install_skill — install a skill from the Skill Store.
 *
 * Called by the agent AFTER the user confirms via ask_user_question.
 * The agent flow is:
 *   1. search_skills("code review") → finds cw-code-review-expert
 *   2. ask_user_question("找到代码审查技能，要安装吗？") → user says Yes
 *   3. install_skill("cw-code-review-expert") → installs → returns success
 *   4. read_skill("cw-code-review-expert") → loads and uses the skill
 *
 * This tool does NOT ask the user — that's the agent's job via ask_user_question.
 * The agent must get explicit user consent before calling this tool.
 */

import type { ToolDefinition } from './tool-types'
import type { ToolPromptDoc } from './tool-types'
import { toolOkJson, toolErrorJson } from './tool-envelope'
import {
  fetchSkillStoreManifest,
  installSkillFromUrl,
} from '@/skills/skill-store'
import { getSkillManager } from '@/skills/skill-manager'
import { useSkillsStore } from '@/store/skills.store'

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const installSkillDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'install_skill',
    description: [
      'Install a skill from the Skill Store by its dirName.',
      '',
      'IMPORTANT: You MUST get explicit user consent via ask_user_question BEFORE calling this tool.',
      'Do not install skills without asking the user first.',
      '',
      'After installation, the skill becomes available via read_skill on the next turn.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        dirName: {
          type: 'string',
          description: 'The skill dirName from search_skills results (e.g. "cw-weread", "cw-code-review-expert").',
        },
      },
      required: ['dirName'],
    },
  },
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function installSkillExecutor(
  args: Record<string, unknown>,
): Promise<string> {
  const dirName = typeof args.dirName === 'string' ? args.dirName : ''

  if (!dirName) {
    return toolErrorJson(
      'install_skill',
      'missing_param',
      'dirName is required. Use the dirName from search_skills results.',
    )
  }

  try {
    // Find the zipUrl from manifest
    const manifest = await fetchSkillStoreManifest()
    const entry = manifest.skills.find((s) => s.dirName === dirName)
    if (!entry) {
      return toolErrorJson(
        'install_skill',
        'not_found',
        `Skill "${dirName}" not found in the Skill Store. Use search_skills to find available skills.`,
      )
    }

    // Install — the version-aware install flow decides whether this is a
    // fresh install, an update of an older installed copy, or a no-op
    // (#154). An already-installed skill is NOT short-circuited here: the
    // store may ship a newer version, and only the install flow can tell.
    const result = await installSkillFromUrl(entry.zipUrl)

    // Refresh skill caches so the new skill is immediately available
    // — both the SkillManager (for read_skill) and the store (for UI).
    try {
      const manager = getSkillManager()
      // Ensure initialized first (read_skill does the same internally)
      await manager.initialize()
      // Re-scan OPFS user skills directory to pick up the newly installed files
      await manager.refreshUserSkills()
    } catch (e) {
      console.warn('[install_skill] Failed to refresh SkillManager:', e)
    }
    // Bump scan version so the system prompt picks up the new skill
    // on the next turn (or even the same turn if read_skill follows).
    useSkillsStore.getState().bumpSkillsScanVersion()

    if (result.outcome === 'updated') {
      return toolOkJson('install_skill', {
        dirName,
        name: entry.name,
        version: entry.version,
        filesInstalled: result.count,
        updated: true,
        message: `Skill "${entry.name}" updated to v${entry.version} (${result.count} files). You can now use it via read_skill("${entry.name}").`,
      })
    }
    if (result.outcome === 'current') {
      return toolOkJson('install_skill', {
        dirName,
        name: entry.name,
        version: entry.version,
        filesInstalled: result.count,
        alreadyInstalled: true,
        message: `Skill "${entry.name}" is already installed (v${entry.version}). You can use it via read_skill now.`,
      })
    }
    if (result.outcome === 'installed-newer') {
      return toolOkJson('install_skill', {
        dirName,
        name: entry.name,
        version: entry.version,
        filesInstalled: result.count,
        alreadyInstalled: true,
        message: `Skill "${entry.name}" is already installed and is newer than the store version — the installed copy was kept. You can use it via read_skill now.`,
      })
    }
    return toolOkJson('install_skill', {
      dirName,
      name: entry.name,
      version: entry.version,
      filesInstalled: result.count,
      message: `Skill "${entry.name}" installed successfully (${result.count} files). You can now use it via read_skill("${entry.name}").`,
    })
  } catch (err) {
    return toolErrorJson(
      'install_skill',
      'install_failed',
      err instanceof Error ? err.message : 'Failed to install skill',
    )
  }
}

// ---------------------------------------------------------------------------
// Prompt doc
// ---------------------------------------------------------------------------

export const installSkillPromptDoc: ToolPromptDoc = {
  category: 'skills',
  section: '### Skill Tools',
  lines: [
    '- `install_skill(dirName)` — Install a skill from the Skill Store. MUST get user consent via ask_user_question FIRST. After install, call read_skill immediately to use it.',
  ],
}
