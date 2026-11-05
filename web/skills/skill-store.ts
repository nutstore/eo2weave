// ============================================================
// skill-store.ts — Skill Store 发现页数据源 + URL 导入
//
// 提供两个核心能力：
// 1. fetchSkillStoreManifest() — 拉取 /skills/manifest.json
// 2. installSkillFromUrl() — 从 URL 下载 ZIP → 走现有 ZIP 导入管道
// 3. 缓存 + 错误处理 + 进度上报
// ============================================================

import {
  previewUserSkillZip,
  importUserSkillZipPrelocked,
  withSkillImportSerialization,
  isNotFoundError,
  isOpfsUnavailableError,
  userSkillDirExists,
  ZIP_IMPORT_LIMITS,
  type ZipSkillPreview,
  type ZipSkillEntry,
} from './user-skills-scanner'
import { useSkillsStore } from '@/store/skills.store'
import { formatBytes } from '@/lib/utils'
import { t as translateStatic } from '@creatorweave/i18n'
import { useI18nStore } from '@/i18n/store'
import {
  decideSkillUpdateAction,
  parseSkillMdVersion,
  type SkillUpdateAction,
} from '@/skills/skill-version'

// ---------- Types ----------

export interface SkillStoreEntry {
  id: string
  name: string
  dirName: string
  description: string
  /**
   * Optional localized descriptions keyed by locale (e.g. `zh-CN`),
   * sourced from `description.<locale>` frontmatter keys (#140). The base
   * `description` stays the agent-facing trigger text; this map only
   * localizes the store UI. Absent when a skill ships no translations.
   */
  description_i18n?: Record<string, string>
  category: string
  tags: string[]
  version: string
  zipUrl: string
  fileCount?: number
  /** 本地是否已安装（按 dirName 判断） */
  installed?: boolean
}

/**
 * Locales the Skill Store UI ships localized descriptions for. UI language
 * tags use the `xx-YY` form matching `Locale` from @creatorweave/i18n;
 * manifest keys mirror these exactly (see description_i18n).
 */
export const SKILL_STORE_UI_LOCALES = ['en-US', 'zh-CN', 'ja-JP', 'ko-KR'] as const

/**
 * Pick the description to display/search for `locale`: the translation from
 * `description_i18n` when one exists, otherwise the English base description
 * (#139 review: store ignores translated descriptions). Falls back to the
 * exact-locale key, then its language prefix (`ja-JP` → `ja`), then base.
 */
export function selectLocalizedDescription(
  entry: Pick<SkillStoreEntry, 'description' | 'description_i18n'>,
  locale: string,
): string {
  const i18n = entry.description_i18n
  if (i18n && locale !== 'en-US') {
    const localized =
      i18n[locale] ??
      (locale.includes('-') ? i18n[locale.split('-')[0]!] : undefined)
    if (localized) return localized
  }
  return entry.description
}

export interface SkillStoreManifest {
  version: string
  generated: string
  count: number
  skills: SkillStoreEntry[]
}

export interface InstallProgress {
  phase: 'fetching' | 'previewing' | 'importing' | 'done' | 'error'
  message: string
  bytesLoaded?: number
  bytesTotal?: number
}

/**
 * What an install actually did with the skill on disk (#154). Callers use
 * this to branch (e.g. offer an update) instead of parsing the human-readable
 * progress message.
 */
export type InstallOutcome =
  /** The skill was not installed before — a fresh install. */
  | 'installed'
  /** An older installed copy was overwritten with the store's newer one. */
  | 'updated'
  /** The installed copy already matches the store — kept as is. */
  | 'current'
  /** The installed copy is newer than the store — kept, never downgraded. */
  | 'installed-newer'
  /**
   * A member present when the install started was uninstalled mid-download
   * and the locked re-check dropped it from the write (#185 req. 3) — never
   * reported as a plain success or "current".
   */
  | 'member-deleted'

// ---------- Config ----------

const MANIFEST_URL = '/skills/manifest.json'

/** in-memory manifest cache (per session, 5 min) */
let manifestCache: { data: SkillStoreManifest; ts: number } | null = null
const CACHE_TTL_MS = 5 * 60 * 1000

// ---------- Manifest ----------

/**
 * Fetch the skill store manifest. Uses in-memory cache to avoid re-fetching.
 * Throws on network/HTTP error so callers can show user-friendly UI.
 *
 * @param opts.force      Bypass the in-memory cache.
 * @param opts.signal     Optional abort signal (e.g. a page-level timeout
 *                        so a stalled request cannot hang the caller).
 */
export async function fetchSkillStoreManifest(opts?: {
  force?: boolean
  signal?: AbortSignal
}): Promise<SkillStoreManifest> {
  if (!opts?.force && manifestCache && Date.now() - manifestCache.ts < CACHE_TTL_MS) {
    return manifestCache.data
  }

  const resp = await fetch(MANIFEST_URL, {
    credentials: 'omit',
    cache: opts?.force ? 'no-cache' : 'default',
    signal: opts?.signal,
  })
  if (resp.status === 404) {
    throw new Error(
      'manifest 未找到。Dev 模式需要先跑 `pnpm run pack:skills` 生成 dist/skills/manifest.json。生产环境 manifest 由 Vercel/EdgeOne 构建时自动部署到 /skills/manifest.json。',
    )
  }
  if (!resp.ok) {
    throw new Error(`Failed to fetch manifest: HTTP ${resp.status}`)
  }
  const data = (await resp.json()) as SkillStoreManifest

  manifestCache = { data, ts: Date.now() }
  return data
}

/**
 * Refresh manifest cache (call when user clicks "refresh" button).
 */
export function invalidateSkillStoreCache(): void {
  manifestCache = null
}

/**
 * Mark entries with `installed: true` if dirName already exists locally.
 * Runs synchronously against the current skills store state.
 */
export function annotateInstalled(
  entries: SkillStoreEntry[],
  installedDirNames: Set<string>,
): SkillStoreEntry[] {
  return entries.map((e) => ({ ...e, installed: installedDirNames.has(e.dirName) }))
}

/**
 * Extract all installed user skill dirNames by directly scanning OPFS.
 * Bypasses store state to avoid race conditions where the store hasn't yet
 * refreshed after a fresh install. Falls back to the store cache only when
 * OPFS is genuinely unavailable (`.skills/user/` absent, no File System
 * Access support) — a transient OPFS error propagates instead of silently
 * degrading to a possibly-stale cached list (issue #185), which would make
 * installed skills look missing or vice versa.
 */
export async function scanInstalledDirNames(): Promise<Set<string>> {
  try {
    const root = await navigator.storage.getDirectory()
    const skillsDir = await (root as any).getDirectoryHandle('.skills', { create: false })
    const userDir = await skillsDir.getDirectoryHandle('user', { create: false })
    const names: string[] = []
    for await (const entry of (userDir as any).values()) {
      if (entry.kind === 'directory') names.push(entry.name)
    }
    return new Set(names)
  } catch (e) {
    // A browser without File System Access support throws TypeError from
    // getDirectory() — same documented fallback as a missing directory
    // (#185): nothing is installed per OPFS, query the store cache.
    if (!isNotFoundError(e) && !isOpfsUnavailableError(e)) throw e
    // `.skills/user/` doesn't exist yet — nothing installed per OPFS. The
    // store cache may still hold legacy SQLite-era entries, so fall back to
    // it. Store ids are `user:<dirName>` while callers compare against bare
    // directory names — strip the prefix so membership checks still match
    // when OPFS is unavailable (#154 round 8).
    const state = useSkillsStore.getState()
    return new Set(
      state.skills
        .filter((s) => s.source === 'user')
        .map((s) => s.id.replace(/^user:/, '')),
    )
  }
}

/** Synchronous store-based lookup (legacy). Use scanInstalledDirNames() instead. */
export function getInstalledDirNames(): Set<string> {
  const state = useSkillsStore.getState()
  return new Set(
    state.skills
      .filter((s) => s.source === 'user')
      .map((s) => s.id),
  )
}

// ---------- URL install ----------

/**
 * Install a skill from a URL. Flow:
 *   fetch(url) → blob → File → previewUserSkillZip → version-aware import
 * Reports progress via optional callback.
 *
 * Returns `{ count, manifest, outcome }` (#154): `count` is the number of
 * files written and `outcome` is what the flow actually did to the installed
 * copy — 'installed' (fresh), 'updated' (older copy overwritten), 'current'
 * (matching copy kept) or 'installed-newer' (newer local copy kept, never
 * downgraded). Throws on error.
 *
 * Robustness:
 *   - The download (headers + body stream) is bounded by DOWNLOAD_TIMEOUT_MS
 *     so a stalled connection can't leave the caller in "installing"
 *     forever — on expiry the fetch is aborted and an error is thrown.
 *   - If the ZIP import fails mid-write, any partially written skill
 *     directory is removed so the skill never looks "installed" while
 *     being unusable.
 *
 * Progress messages are localized through the i18n package (the current UI
 * locale is read from the i18n store), so every caller shows translated
 * text without passing a translator in.
 */
export const DOWNLOAD_TIMEOUT_MS = 60_000

/**
 * Max bytes read from an installed SKILL.md when looking for its version.
 * The frontmatter lives in the first few hundred bytes, so a small cap is
 * enough — and it keeps a locally grown SKILL.md from being buffered whole
 * just to read one line.
 */
const INSTALLED_VERSION_READ_LIMIT = 64 * 1024

/**
 * Result of looking up the installed copy of a skill's version.
 *
 * `null` means "not installed or no parseable version" (unknown version).
 * `error` means the read itself failed — an operational OPFS problem the
 * caller must surface instead of silently degrading to the conservative
 * install path.
 */
type InstalledVersionResult =
  | { version: string | null; error?: undefined }
  | { version?: undefined; error: Error }

/**
 * Read the installed SKILL.md's `version:` for a user skill directory.
 *
 * Only an ABSENT skill (or a SKILL.md without a parseable version) yields an
 * unknown version. An OPFS read failure is surfaced to the caller: silently
 * returning null would make the update flow fall back to `ifAbsent` and
 * report "Already installed" while the copy on disk stays stale.
 */
/**
 * Find the SKILL.md file handle in an installed skill directory,
 * case-insensitively: the import pipeline accepts archives shipping
 * `skill.md` (the ZIP preview matches SKILL.md case-insensitively), so an
 * exact-case lookup would miss it and make the version read as unknown —
 * silently degrading the update decision to `ifAbsent` (#154).
 */
async function findInstalledSkillMdHandle(
  skillDir: FileSystemDirectoryHandle,
): Promise<FileSystemFileHandle> {
  try {
    return await skillDir.getFileHandle('SKILL.md')
  } catch (e) {
    if (!isNotFoundError(e)) throw e
  }
  for await (const [name, entry] of skillDir.entries()) {
    if (entry.kind === 'file' && /^skill\.md$/i.test(name)) {
      return entry as FileSystemFileHandle
    }
  }
  throw new Error(`NotFoundError: no SKILL.md in "${skillDir.name}"`)
}

/**
 * Read the installed SKILL.md's `version:` for a user skill directory.
 *
 * Only an ABSENT skill (or a SKILL.md without a parseable version) yields an
 * unknown version. An OPFS read failure is surfaced to the caller: silently
 * returning null would make the update flow fall back to `ifAbsent` and
 * report "Already installed" while the copy on disk stays stale.
 */
async function readInstalledSkillVersion(
  dirName: string,
): Promise<InstalledVersionResult> {
  try {
    const root = await navigator.storage.getDirectory()
    const skillsDir = await root.getDirectoryHandle('.skills', { create: false })
    const userDir = await skillsDir.getDirectoryHandle('user', { create: false })
    const skillDir = await userDir.getDirectoryHandle(dirName, { create: false })
    const file = await (await findInstalledSkillMdHandle(skillDir)).getFile()
    // Read only the head of the file: the frontmatter is at the top, and an
    // oversized local file must not be buffered whole just to find a version.
    const head = await file.slice(0, INSTALLED_VERSION_READ_LIMIT).text()
    return { version: parseSkillMdVersion(head) }
  } catch (e) {
    // "Not installed" (or no SKILL.md) is an expected unknown-version case;
    // anything else is a read failure the caller must see.
    if (isNotFoundError(e)) return { version: null }
    return {
      error:
        e instanceof Error
          ? e
          : new Error(`Failed to read the installed skill "${dirName}": ${String(e)}`),
    }
  }
}

/**
 * Look up a ZIP entry path case-insensitively. `exact` first (the common
 * case), then a scan for a key differing only in case — the preview accepts
 * case-variant SKILL.md names (`skill.md`), so an exact-case-only lookup
 * would miss the version and silently degrade to `ifAbsent` (#154).
 */
function lookupRawEntry(
  raw: Record<string, Uint8Array>,
  exact: string,
): Uint8Array | undefined {
  const hit = raw[exact]
  if (hit) return hit
  const lower = exact.toLowerCase()
  for (const key of Object.keys(raw)) {
    if (key.toLowerCase() === lower) return raw[key]
  }
  return undefined
}

/** Find this skill's SKILL.md text inside the previewed store ZIP. */
function extractStoreSkillMd(
  preview: ZipSkillPreview,
  skill: ZipSkillEntry,
): string | null {
  const mdPath = `${skill._commonRoot}SKILL.md`
  const data =
    lookupRawEntry(preview._raw, mdPath) ??
    lookupRawEntry(preview._raw, `${skill.dirName}/SKILL.md`)
  return data ? new TextDecoder().decode(data) : null
}

/**
 * Restrict a preview to ONE member skill so a per-member import writes only
 * that member's files: bundle-wide writes would overwrite members the
 * per-member decision decided to keep (#154 round 2). The raw archive is
 * filtered to the member's files (entries under `root` or `dirName/`);
 * everything else drops out.
 */
function slicePreview(preview: ZipSkillPreview, skill: ZipSkillEntry): ZipSkillPreview {
  const root = skill._commonRoot
  const prefix = `${skill.dirName}/`
  // A root-level member (empty `_commonRoot`) would otherwise match EVERY
  // archive path via `startsWith('')` and absorb its siblings' files —
  // including nested skills' SKILL.md — into the root member's import.
  // A member whose directory CONTAINS another member (e.g. `pkg/` with a
  // `pkg/nested-skill/SKILL.md` inside) must likewise not copy the nested
  // member's files — EXCEPT that the nested member's own files also live
  // under the containing parent's root, so the exclusion skips any member
  // that contains THIS one (its root is a prefix of ours) (#154 round 8).
  const members = preview.isBundle ? preview.skills ?? [] : []
  const claimedByContainer = (otherPrefix: string): boolean =>
    skill._commonRoot.startsWith(otherPrefix)
  const otherPrefixes = members
    .filter((m) => m !== skill && m._commonRoot && !claimedByContainer(m._commonRoot))
    .map((m) => m._commonRoot)
  const otherDirPrefixes = members
    .filter(
      (m) =>
        m !== skill &&
        m._commonRoot === '' &&
        !claimedByContainer(`${m.dirName}/`),
    )
    .map((m) => `${m.dirName}/`)
  const claimedByOther = (path: string): boolean =>
    otherPrefixes.some((p) => path.startsWith(p)) ||
    otherDirPrefixes.some((p) => path.startsWith(p))
  const raw: Record<string, Uint8Array> = {}
  for (const [path, data] of Object.entries(preview._raw)) {
    if (claimedByOther(path)) continue
    if (path.startsWith(root) || path.startsWith(prefix)) raw[path] = data
  }
  return { isBundle: false, skill, _raw: raw }
}

/** Localized progress/outcome message for the current UI locale. */
function tr(key: string, params?: Record<string, string | number>): string {
  return translateStatic(useI18nStore.getState().locale, key, params)
}

/**
 * What an install surface should do with a store skill that may already be
 * installed (#154).
 *
 * - `install` — the skill is not installed (or has no parseable version).
 * - `update` / `current` / `installed-newer` — the version-aware decisions
 *   of `decideSkillUpdateAction`.
 */
export type SkillUpdatePlan = SkillUpdateAction | 'install'

/**
 * Decide what to do with a store skill BEFORE downloading it: compare the
 * store's version with the installed copy's version, exactly like
 * `installSkillFromUrl` does, but without the download.
 *
 * Install surfaces use this to offer the version-aware update path for an
 * already-installed skill instead of skipping the install outright (#154).
 *
 * @param dirName      Directory name of the skill in the store.
 * @param storeVersion Version declared by the store manifest entry.
 */
export async function planSkillUpdate(
  dirName: string,
  storeVersion: string | undefined,
): Promise<SkillUpdatePlan> {
  const installed = await readInstalledSkillVersion(dirName)
  if (installed.error) throw installed.error
  if (installed.version === null) return 'install'
  if (!storeVersion) return 'current'
  return decideSkillUpdateAction(storeVersion, installed.version)
}

export async function installSkillFromUrl(
  zipUrl: string,
  onProgress?: (p: InstallProgress) => void,
): Promise<{
  count: number
  manifest: SkillStoreEntry
  outcome: InstallOutcome
  /** Members dropped by the locked absence re-check (#185 req. 3). */
  droppedMembers?: string[]
}> {
  const report = (p: Omit<InstallProgress, 'bytesLoaded' | 'bytesTotal'>) =>
    onProgress?.(p)

  report({ phase: 'fetching', message: tr('skills.discover.progressPreparing') })

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  // Presence snapshot BEFORE the download (uninstall-resurrect guard, #154
  // review): the ZIP's dirNames are unknown until it is downloaded and
  // previewed, so this snapshot lists the OPFS user-skill dirNames at call
  // time and the locked section compares it against a second check under
  // the import lock. A member present at call time but gone inside the
  // lock was uninstalled mid-download and must NOT be resurrected; a
  // member absent in both snapshots is a plain fresh install and stays.
  const presentAtCall = await scanInstalledDirNames()
  let resp: Response
  try {
    resp = await fetch(zipUrl, { credentials: 'omit', signal: controller.signal })
    if (!resp.ok) {
      throw new Error(`Download failed: HTTP ${resp.status}`)
    }
    if (!resp.body) {
      throw new Error('Download failed: empty response')
    }

    const contentLength = Number(resp.headers.get('content-length') ?? 0)
    // Decompression-bomb guard: reject oversized downloads up front
    // (before anything is buffered) when the server declares its size.
    if (contentLength > ZIP_IMPORT_LIMITS.MAX_TOTAL_SIZE) {
      throw new Error(
        `Skill archive is too large (${formatBytes(contentLength)}; limit: ${formatBytes(ZIP_IMPORT_LIMITS.MAX_TOTAL_SIZE)}).`,
      )
    }
    // Trusting Content-Length alone is not enough: a server may omit it or
    // lie — the cumulative cap inside streamToBlob is the real guard.
    const maxBytes = ZIP_IMPORT_LIMITS.MAX_TOTAL_SIZE
    const blob = await streamToBlob(
      resp,
      contentLength,
      maxBytes,
      controller.signal,
      (loaded, total) => {
        const displayTotal = total >= loaded ? total : 0
        onProgress?.({
          phase: 'fetching',
          message: displayTotal
            ? tr('skills.discover.progressDownloading', {
                loaded: formatBytes(loaded),
                total: formatBytes(displayTotal),
              })
            : tr('skills.discover.progressDownloadingBytes', {
                loaded: formatBytes(loaded),
              }),
          bytesLoaded: loaded,
          bytesTotal: displayTotal || undefined,
        })
      },
    )
    clearTimeout(timeoutId)

    // Wrap as File (previewUserSkillZip expects File)
    const filename = zipUrl.split('/').pop() ?? 'skill.zip'
    const file = new File([blob], filename, { type: 'application/zip' })

    report({ phase: 'previewing', message: tr('skills.discover.progressValidating') })
    const preview = await previewUserSkillZip(file)

    report({ phase: 'importing', message: tr('skills.discover.progressInstalling') })

    // Version-update flow (#154): compare the store ZIP's version against
    // the installed copy INSIDE the per-directory import serialization.
    // Deciding before acquiring the lock let a concurrent install (this tab
    // or another) overwrite the skill between the version read and the
    // import — an older ZIP could win and silently downgrade the skill, and
    // an uninstall could land in the same window (making the update
    // re-create a skill the user just deleted). The decision (version reads
    // included) and the write therefore share the SAME critical section via
    // importUserSkillZipPrelocked (calling the locking importUserSkillZip
    // here would deadlock on its own per-directory lock).
    // Bundle ZIPs decide PER MEMBER: preview.skill is unset for bundles, so
    // the old single-skill check made every bundle fall back to ifAbsent and
    // its members never updated.
    // An unparseable/missing version on either side falls back to the old
    // ifAbsent behavior (never clobber an install of unknown provenance).
    const memberSkills = preview.isBundle
      ? (preview.skills ?? [])
      : preview.skill
        ? [preview.skill]
        : []

    // Duplicate-dirName guard mirrors the bulk import: distinct archive
    // paths can collapse to the SAME final folder name (e.g. `a/skill/…`
    // and `b/skill/…` both infer `skill`), and the per-member path below
    // would funnel both members into one installed directory — a later
    // member silently replacing an earlier one. Reject before ANY member
    // import, with the same message as importUserSkillZip (#154 round 5).
    const seenDirNames = new Set<string>()
    for (const s of memberSkills) {
      if (seenDirNames.has(s.dirName)) {
        throw new Error(
          `ZIP bundle contains duplicate skill folders ("${s.dirName}") — each skill must live in its own folder.`,
        )
      }
      seenDirNames.add(s.dirName)
    }

    let count: number
    let doneMessage: string
    let outcome: InstallOutcome
    // The first member's store version (best-effort, for the manifest echo).
    let manifestVersion: string | null = null
    // Members dropped by the locked absence re-check (#185 req. 3) — empty
    // unless the user uninstalled a present member mid-download.
    let droppedMembers: string[] = []

    if (memberSkills.length === 0) {
      count = 0
      outcome = 'current'
      doneMessage = tr('skills.discover.alreadyInstalled')
    } else {
      const result = await withSkillImportSerialization(
        memberSkills.map((s) => s.dirName),
        async () => {
          // Uninstall-resurrect guard (#154 review): a member present at
          // call time but gone under the import lock was uninstalled while
          // its ZIP was downloading — importing it would resurrect a skill
          // the user just deleted, so it is dropped from the write. A
          // member absent in BOTH snapshots is a plain fresh install and
          // stays.
          const members: ZipSkillEntry[] = []
          // Members present at call time but gone under the import lock
          // (#154 review / #185 req. 3): recorded so the outcome can report
          // them instead of a silent partial success.
          const droppedMembers: string[] = []
          for (const s of memberSkills) {
            if (presentAtCall.has(s.dirName)) {
              if (!(await userSkillDirExists(s.dirName))) {
                droppedMembers.push(s.dirName)
                continue
              }
            }
            members.push(s)
          }
          if (members.length === 0) {
            // EVERY member was dropped: the user uninstalled the whole bundle
            // while its ZIP was downloading. Reporting plain "current" would
            // hide that (#185 req. 3).
            return {
              count: 0,
              storeVersion: null,
              outcome: droppedMembers.length > 0
                ? ('member-deleted' as InstallOutcome)
                : ('current' as InstallOutcome),
              doneMessage: droppedMembers.length > 0
                ? tr('skills.discover.memberRemovedDuringInstall')
                : tr('skills.discover.alreadyInstalled'),
              droppedMembers,
            }
          }

          // A failed read is NOT "unknown version": the update decision
          // cannot be made, so the failure is surfaced instead of silently
          // keeping the stale copy (the old fallback would report
          // "Already installed").
          // The decision is PER MEMBER: each member of a bundle gets its own
          // update / keep / skip / ifAbsent action, so one updatable member
          // no longer overwrites members that should be kept, and unknown
          // members no longer drag missing siblings into a bundle-wide
          // ifAbsent (#154 round 2).
          let updatedAny = false
          let installedAny = false
          let filesWritten = 0
          // First decision per category, for the human-readable summary.
          let updatedFrom = ''
          let updatedTo = ''
          let skippedInstalled = ''
          let skippedStoreVersion = ''
          let keptVersion = ''

          for (const s of members) {
            const installed = await readInstalledSkillVersion(s.dirName)
            if (installed.error) throw installed.error
            const storeVersion = parseSkillMdVersion(
              extractStoreSkillMd(preview, s) ?? '',
            )

            // Unknown version on either side — conservative per-member
            // ifAbsent: install only when the member is not on disk.
            if (installed.version === null || storeVersion === null) {
              const n = await importUserSkillZipPrelocked(
                slicePreview(preview, s),
                { ifAbsent: true },
              )
              if (n > 0) {
                installedAny = true
                filesWritten += n
              }
              continue
            }

            const action = decideSkillUpdateAction(storeVersion, installed.version)
            if (action === 'update') {
              const n = await importUserSkillZipPrelocked(slicePreview(preview, s))
              if (n > 0) {
                updatedAny = true
                filesWritten += n
                if (!updatedFrom) {
                  updatedFrom = installed.version
                  updatedTo = storeVersion
                }
              }
            } else if (action === 'current' && !keptVersion) {
              keptVersion = installed.version
            } else if (action === 'installed-newer' && !skippedInstalled) {
              skippedInstalled = installed.version
              skippedStoreVersion = storeVersion
            }
          }

          // Summary against the strongest action any member took: the
          // per-member counts stay exact, the message names one example.
          if (updatedAny) {
            return {
              count: filesWritten,
              storeVersion: updatedTo,
              outcome: 'updated' as InstallOutcome,
              doneMessage: tr('skills.discover.updatedVersion', {
                from: updatedFrom,
                to: updatedTo,
                count: filesWritten,
              }),
            }
          }
          if (installedAny) {
            return {
              count: filesWritten,
              storeVersion: null,
              outcome: 'installed' as InstallOutcome,
              doneMessage: tr('skills.discover.installedFiles', { count: filesWritten }),
            }
          }
          if (skippedInstalled) {
            return {
              count: 0,
              storeVersion: null,
              outcome: 'installed-newer' as InstallOutcome,
              doneMessage: tr('skills.discover.skippedUpdate', {
                installed: skippedInstalled,
                store: skippedStoreVersion,
              }),
            }
          }
          return {
            count: 0,
            storeVersion: null,
            outcome: 'current' as InstallOutcome,
            doneMessage: keptVersion
              ? tr('skills.discover.alreadyInstalledVersion', { version: keptVersion })
              : tr('skills.discover.alreadyInstalled'),
          }
        },
      )
      count = result.count
      outcome = result.outcome
      doneMessage = result.doneMessage
      manifestVersion = result.storeVersion
      droppedMembers = result.droppedMembers ?? []
    }

    // Find manifest entry (best effort — caller may not have it)
    const manifest: SkillStoreEntry = {
      id: preview.skill?.dirName ?? filename.replace(/\.zip$/, ''),
      name: preview.skill?.dirName ?? filename.replace(/\.zip$/, ''),
      dirName: preview.skill?.dirName ?? filename.replace(/\.zip$/, ''),
      description: '',
      category: '',
      tags: [],
      version: manifestVersion ?? '',
      zipUrl,
    }

    report({ phase: 'done', message: doneMessage })
    return droppedMembers.length > 0
      ? { count, manifest, outcome, droppedMembers }
      : { count, manifest, outcome }
  } catch (e) {
    clearTimeout(timeoutId)
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('Download timed out — please check your connection and retry')
    }
    throw e
  }
}

/**
 * Stream a Response body to a Blob with progress reporting.
 * Aborts (and rejects) when the caller's timeout signal fires, so a stalled
 * stream cannot hang the install pipeline.
 */
async function streamToBlob(
  resp: Response,
  total: number,
  maxBytes: number,
  signal: AbortSignal,
  onProgress: (loaded: number, total: number) => void,
): Promise<Blob> {
  if (!resp.body) return new Blob()

  const reader = resp.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0

  const abortListener = () => {
    void reader.cancel()
  }
  signal.addEventListener('abort', abortListener, { once: true })

  try {
    // eslint-disable-next-line no-constant-condition -- reader.read() loop with an explicit break on done
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // Cumulative guard BEFORE buffering the chunk: a response that omits
      // or understates Content-Length (chunked transfer, lying server) can
      // stream far beyond the declared size — stop reading the moment the
      // limit is crossed instead of buffering the whole body and letting
      // previewUserSkillZip find out afterwards.
      if (loaded + value.length > maxBytes) {
        void reader.cancel()
        throw new Error(
          `Skill archive exceeded the download size limit (${formatBytes(maxBytes)}) while streaming.`,
        )
      }
      chunks.push(value)
      loaded += value.length
      onProgress(loaded, total)
    }
  } finally {
    signal.removeEventListener('abort', abortListener)
  }

  if (signal.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError')
  }

  return new Blob(chunks)
}

// ---------- Re-export for convenience ----------
export type { ZipSkillPreview }
