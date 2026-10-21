/**
 * Builtin Skills Package Registry
 *
 * Registers all builtin skill packages and their files.
 * This is the build-time manifest + file content source.
 *
 * When adding a new builtin skill:
 * 1. Create a directory under web/skills/builtin-packages/<skill-name>/
 * 2. Add its SKILL.md and resources
 * 3. Import the files here and register them
 * 4. Update the manifest below
 */

import type { BuiltinSkillsManifest } from '@creatorweave/skills-system'
import { APP_VERSION } from '../app-build'

// ============================================================================
// Shared file map — the single source of truth for bundled skill file content.
// Populated by registerSkill() / registerFile() calls at module load time.
// Exported so that skills-platform-adapter can read from it without circular deps.
// ============================================================================

export const BUNDLED_SKILL_FILES: Record<string, string> = {}

/**
 * Binary files stored as base64 strings.
 * Key format: "skill-name/path.b64" (the .b64 suffix indicates base64 encoding).
 * At materialize time, .b64 files are decoded and written without the .b64 suffix.
 */
export const BUNDLED_SKILL_BINARY_FILES: Record<string, string> = {}

// ============================================================================
// App Version (update on each release that changes builtin skills)
// ============================================================================

// ============================================================================
// Skill File Registration
// ============================================================================

/**
 * Register a single text file for a builtin skill.
 */
function registerFile(skillName: string, relativePath: string, content: string): void {
  BUNDLED_SKILL_FILES[`${skillName}/${relativePath}`] = content
}

/**
 * Register a single binary file for a builtin skill (stored as base64).
 * The path should end with .b64 to indicate base64 encoding.
 * At materialize time, the .b64 suffix is stripped and content is decoded.
 */
function registerBinaryFile(skillName: string, relativePath: string, base64Content: string): void {
  BUNDLED_SKILL_BINARY_FILES[`${skillName}/${relativePath}`] = base64Content
}

/**
 * Register all files for a builtin skill at once.
 * Supports both text files and binary files (base64).
 */
function registerSkill(
  skillName: string,
  files: Array<{ path: string; content: string; binary?: boolean }>
): void {
  for (const { path, content, binary } of files) {
    if (binary) {
      registerBinaryFile(skillName, path, content)
    } else {
      registerFile(skillName, path, content)
    }
  }
}

// ============================================================================
// cw-brainstorm — Socratic brainstorming mode
// ============================================================================

// Import skill files through webpack's asset/source rule (inline as strings at build time)
// Directory name (socratic-brainstorm) is just the filesystem location;
// the skill identity is set by registerSkill('cw-brainstorm', ...).
import brainstormSkillMd from './builtin-packages/socratic-brainstorm/SKILL.md?raw'

registerSkill('cw-brainstorm', [
  { path: 'SKILL.md', content: brainstormSkillMd },
])

// ============================================================================
// cw-skill-creator — Create, evaluate, and improve workspace skills
// ============================================================================

import skillCreatorSkillMd from './builtin-packages/skill-creator/SKILL.md?raw'
import skillCreatorUtils from './builtin-packages/skill-creator/scripts/utils.py?raw'
import skillCreatorValidate from './builtin-packages/skill-creator/scripts/quick_validate.py?raw'
import skillCreatorAggregate from './builtin-packages/skill-creator/scripts/aggregate_benchmark.py?raw'
import skillCreatorReport from './builtin-packages/skill-creator/scripts/generate_report.py?raw'
import skillCreatorPackage from './builtin-packages/skill-creator/scripts/package_skill.py?raw'
import skillCreatorGrader from './builtin-packages/skill-creator/agents/grader.md?raw'
import skillCreatorComparator from './builtin-packages/skill-creator/agents/comparator.md?raw'
import skillCreatorAnalyzer from './builtin-packages/skill-creator/agents/analyzer.md?raw'
import skillCreatorSchemas from './builtin-packages/skill-creator/references/schemas.md?raw'
import skillCreatorGenReview from './builtin-packages/skill-creator/eval-viewer/generate_review.py?raw'
import skillCreatorViewerHtml from './builtin-packages/skill-creator/eval-viewer/viewer.html?raw'

registerSkill('cw-skill-creator', [
  { path: 'SKILL.md', content: skillCreatorSkillMd },
  // scripts/
  { path: 'scripts/utils.py', content: skillCreatorUtils },
  { path: 'scripts/quick_validate.py', content: skillCreatorValidate },
  { path: 'scripts/aggregate_benchmark.py', content: skillCreatorAggregate },
  { path: 'scripts/generate_report.py', content: skillCreatorReport },
  { path: 'scripts/package_skill.py', content: skillCreatorPackage },
  // agents/
  { path: 'agents/grader.md', content: skillCreatorGrader },
  { path: 'agents/comparator.md', content: skillCreatorComparator },
  { path: 'agents/analyzer.md', content: skillCreatorAnalyzer },
  // references/
  { path: 'references/schemas.md', content: skillCreatorSchemas },
  // eval-viewer/
  { path: 'eval-viewer/generate_review.py', content: skillCreatorGenReview },
  { path: 'eval-viewer/viewer.html', content: skillCreatorViewerHtml },
])

// ============================================================================
// Manifest — the single source of truth for what's bundled
// ============================================================================

async function computeHash(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Decode a base64 string to Uint8Array.
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

/**
 * Build the manifest dynamically from registered files.
 * Called once at startup.
 */
export async function buildBundledManifest(): Promise<BuiltinSkillsManifest> {
  const skills: BuiltinSkillsManifest['skills'] = []

  // Group files by skill name (from both text and binary maps)
  const skillNames = new Set<string>()
  for (const key of Object.keys(BUNDLED_SKILL_FILES)) {
    const slashIdx = key.indexOf('/')
    if (slashIdx > 0) {
      skillNames.add(key.substring(0, slashIdx))
    }
  }
  for (const key of Object.keys(BUNDLED_SKILL_BINARY_FILES)) {
    const slashIdx = key.indexOf('/')
    if (slashIdx > 0) {
      skillNames.add(key.substring(0, slashIdx))
    }
  }

  for (const skillName of skillNames) {
    const prefix = `${skillName}/`
    const files: BuiltinSkillsManifest['skills'][0]['files'] = []

    // Text files
    for (const [key, content] of Object.entries(BUNDLED_SKILL_FILES)) {
      if (!key.startsWith(prefix)) continue
      const path = key.substring(prefix.length)
      files.push({
        path,
        hash: await computeHash(content),
        size: new TextEncoder().encode(content).length,
      })
    }

    // Binary files — strip .b64 suffix for the manifest path
    for (const [key, content] of Object.entries(BUNDLED_SKILL_BINARY_FILES)) {
      if (!key.startsWith(prefix)) continue
      const rawPath = key.substring(prefix.length)
      // .b64 suffix is an encoding hint; the actual file path strips it
      const path = rawPath.endsWith('.b64') ? rawPath.slice(0, -4) : rawPath
      // Decode base64 to get actual binary size
      const binaryData = base64ToUint8Array(content)
      files.push({
        path,
        hash: await computeHash(content), // hash the base64 string for consistency
        size: binaryData.length,
      })
    }

    // Extract metadata from SKILL.md frontmatter (simple parse)
    const skillMd = BUNDLED_SKILL_FILES[`${skillName}/SKILL.md`] || ''
    const versionMatch = skillMd.match(/version:\s*["']?([^"'\n]+)/)
    // description may be quoted or unquoted in YAML
    const descMatch =
      skillMd.match(/description:\s*["']([^"']+)["']/) ||
      skillMd.match(/description:\s*(.+)/)

    skills.push({
      name: skillName,
      version: versionMatch?.[1] || '1.0.0',
      description: descMatch?.[1]?.trim() || '',
      files,
      generatedAt: new Date().toISOString(),
    })
  }

  return {
    schemaVersion: 1,
    appVersion: APP_VERSION,
    skills,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Lazy-initialized manifest — built once, cached.
 */
let cachedManifest: BuiltinSkillsManifest | null = null

/**
 * Get the bundled manifest (cached).
 */
export function getBundledManifestSync(): BuiltinSkillsManifest {
  if (!cachedManifest) {
    // Synchronous fallback — should call buildBundledManifest() during init
    throw new Error('Bundled manifest not yet built. Call buildBundledManifest() first.')
  }
  return cachedManifest
}

/**
 * Initialize the registry — call once at app startup.
 */
export async function initializeRegistry(): Promise<BuiltinSkillsManifest> {
  cachedManifest = await buildBundledManifest()

  // Update the shared mutable manifest object so that consumers
  // (skills-platform-adapter via getBundledManifest) see the real data.
  Object.assign(BUILTIN_SKILLS_PACKAGE, cachedManifest)

  console.log(
    `[Skills Registry] Initialized with ${cachedManifest.skills.length} builtin skills`
  )
  return cachedManifest
}

/**
 * The manifest object used by the adapter.
 * This is replaced by the actual built manifest after initializeRegistry().
 */
export const BUILTIN_SKILLS_PACKAGE: BuiltinSkillsManifest = {
  schemaVersion: 1,
  appVersion: '0.0.0',
  skills: [],
  generatedAt: '',
}
