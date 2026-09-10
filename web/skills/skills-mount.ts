/**
 * Skills Mount Coordinator
 *
 * Coordinates mounting the global .skills directory into Pyodide as /mnt_skills.
 *
 * This module is called from the Python bridge/worker initialization
 * to ensure builtin skill files are accessible at /mnt_skills/builtin/...
 *
 * OPFS layout:
 *   opfs-root/.skills/builtin/<skill>/...
 *
 * Pyodide mount:
 *   /mnt_skills/ ↔ opfs-root/.skills/
 */

/** Mount point for skills in Pyodide */
export const SKILLS_MOUNT_POINT = '/mnt_skills'

/**
 * Get the OPFS directory handle for .skills root.
 * Creates it if it doesn't exist.
 */
export async function getSkillsDirectoryHandle(): Promise<FileSystemDirectoryHandle> {
  const opfsRoot = await navigator.storage.getDirectory()
  return opfsRoot.getDirectoryHandle('.skills', { create: true })
}

/**
 * Health check: verify that .skills/builtin exists and has content.
 */
export async function isSkillsDirHealthy(): Promise<boolean> {
  try {
    const skillsRoot = await getSkillsDirectoryHandle()
    const builtinDir = await skillsRoot.getDirectoryHandle('builtin')
    // At least one entry is enough — check via iterator length probe.
    const iterator = builtinDir.values()
    const probe = await iterator.next()
    return !probe.done
  } catch {
    return false
  }
}
