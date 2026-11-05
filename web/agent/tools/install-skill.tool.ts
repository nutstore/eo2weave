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
 * This tool does NOT ask the user before a FRESH install — that's the
 * agent's job via ask_user_question. UPDATING an already-installed skill,
 * however, is consent-gated IN CODE below: the executor asks via the same
 * question channel before any overwrite happens (#154 round 2).
 */

import type { ToolDefinition, ToolContext } from './tool-types'
import type { ToolPromptDoc } from './tool-types'
import { toolOkJson, toolErrorJson } from './tool-envelope'
import {
  fetchSkillStoreManifest,
  installSkillFromUrl,
  planSkillUpdate,
  scanInstalledDirNames,
} from '@/skills/skill-store'
import type { SkillStoreEntry } from '@/skills/skill-store'
import { skillUpdateNeedsConsent } from '@/skills/skill-version'
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
      'If the skill is already installed at an OLDER version, this tool asks the user to confirm the update itself (in code) — if the user declines, the installed copy is kept and no update happens.',
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
  context?: Pick<ToolContext, 'askUserQuestion' | 'abortSignal' | 'currentToolCallId'>,
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
    // Offline fallback (#154 round 6): when the store manifest is
    // unreachable, an already-installed skill is still usable locally —
    // only a fresh install genuinely needs the network. Restore the old
    // "already installed" fast path for that failure case so an offline
    // call for an installed skill does not regress to install_failed.
    let entry: SkillStoreEntry | null
    try {
      const manifest = await fetchSkillStoreManifest()
      entry = manifest.skills.find((s) => s.dirName === dirName) ?? null
    } catch (err) {
      const installed = await scanInstalledDirNames()
      if (!installed.has(dirName)) throw err
      return toolOkJson('install_skill', {
        dirName,
        alreadyInstalled: true,
        updated: false,
        message: `Skill "${dirName}" is already installed locally; the Skill Store could not be reached to check for updates, so the installed copy was kept. You can use it via read_skill now.`,
      })
    }
    if (entry === null) {
      return toolErrorJson(
        'install_skill',
        'not_found',
        `Skill "${dirName}" not found in the Skill Store. Use search_skills to find available skills.`,
      )
    }

    // Update-consent gate (#154 round 2): when the store would OVERWRITE an
    // already-installed skill, the call must not proceed on prompt
    // instructions alone — `install_skill` is policy-level `auto`, so the
    // gate is enforced here in code. `planSkillUpdate` compares versions
    // exactly like the install flow (a fresh install, a no-op, or a
    // newer-installed keep stays consent-free). The question rides the SAME
    // ask_user_question UI channel the install opt-in already uses.
    const plan = await planSkillUpdate(entry.dirName, entry.version)
    if (plan !== 'install' && skillUpdateNeedsConsent(plan)) {
      if (!context?.askUserQuestion) {
        // No UI channel (e.g. a subagent context) — the overwrite cannot be
        // consented to, so it must not happen.
        return toolErrorJson(
          'install_skill',
          'update_consent_required',
          `"${entry.name}" is already installed at an older version (v${entry.version} would overwrite it). Updating an installed skill requires explicit user confirmation, but no user-interaction channel is available in this context. Ask the main agent to have the user confirm, or skip the update.`,
        )
      }
      const answer = await context.askUserQuestion({
        question: `The skill "${entry.name}" is already installed and the Skill Store ships a newer version (would overwrite your installed copy). Install the update?`,
        type: 'yes_no',
        defaultAnswer: 'no',
        context: {
          preview: `Updating "${entry.name}" to store v${entry.version}`,
        },
        signal: context.abortSignal,
        toolCallId: context.currentToolCallId,
      })
      // `confirmed` is true for ANY submitted answer (ToolCallDisplay resolves
      // every click — Yes AND No — with confirmed:true), so consent must be
      // the answer text itself: only an explicit "yes" agrees to the
      // overwrite. Everything else (a "no" click, free text, an abort
      // resolving confirmed:false with the default answer) declines.
      const said = answer.answer.trim().toLowerCase()
      if (said !== 'yes' || !answer.confirmed) {
        return toolOkJson('install_skill', {
          dirName,
          name: entry.name,
          version: entry.version,
          updated: false,
          declined: true,
          message: `Update declined — the installed copy of "${entry.name}" was kept unchanged.`,
        })
      }
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

    // Partial member drops ride ANY successful outcome (#185 req. 3 /
    // review round N): checked BEFORE the per-outcome early returns below,
    // otherwise an updated/current/installed-newer result would report a
    // clean install while a member was silently omitted.
    if ((result.droppedMembers?.length ?? 0) > 0) {
      return toolOkJson('install_skill', {
        dirName,
        name: entry.name,
        version: entry.version,
        filesInstalled: result.count,
        outcome: result.outcome,
        missingMembers: result.droppedMembers ?? [],
        message: `Install finished (${result.outcome}), but ${result.droppedMembers?.join(', ')} ${result.droppedMembers?.length === 1 ? 'was' : 'were'} removed during the install and ${result.droppedMembers?.length === 1 ? 'was' : 'were'} NOT re-created.`,
      })
    }

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
        // The unknown-version fallback also lands here (decideSkillUpdateAction
        // keeps an unparseable installed version as "installed-newer"), so the
        // message must not claim a verified newer version.
        message: `Skill "${entry.name}" is already installed — the installed copy was kept (it is newer than the store version, or its version could not be compared with the store's). You can use it via read_skill now.`,
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
    '- `install_skill(dirName)` — Install a skill from the Skill Store. MUST get user consent via ask_user_question FIRST. Updating an ALREADY-INSTALLED older skill triggers an in-tool user confirmation; a declined update keeps the installed copy. After install, call read_skill immediately to use it.',
  ],
}
