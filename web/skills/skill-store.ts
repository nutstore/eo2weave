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
  importUserSkillZip,
  isNotFoundError,
  ZIP_IMPORT_LIMITS,
  type ZipSkillPreview,
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
 * refreshed after a fresh install. Falls back to the store cache if OPFS is
 * unavailable (e.g., browser without File System Access support).
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
  } catch {
    // Fallback: query store. May be slightly stale but better than nothing.
    const state = useSkillsStore.getState()
    return new Set(
      state.skills
        .filter((s) => s.source === 'user')
        .map((s) => s.id),
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
 *   fetch(url) → blob → File → previewUserSkillZip → importUserSkillZip
 * Reports progress via optional callback.
 *
 * Returns the number of files written. Throws on error.
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
async function readInstalledSkillVersion(
  dirName: string,
): Promise<InstalledVersionResult> {
  try {
    const root = await navigator.storage.getDirectory()
    const skillsDir = await root.getDirectoryHandle('.skills', { create: false })
    const userDir = await skillsDir.getDirectoryHandle('user', { create: false })
    const skillDir = await userDir.getDirectoryHandle(dirName, { create: false })
    const file = await (await skillDir.getFileHandle('SKILL.md')).getFile()
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

/** Find this skill's SKILL.md text inside the previewed store ZIP. */
function extractStoreSkillMd(
  preview: ZipSkillPreview,
  dirName: string,
): string | null {
  const skill = preview.isBundle ? preview.skills?.[0] : preview.skill
  if (!skill || skill.dirName !== dirName) return null
  const mdPath = `${skill._commonRoot}SKILL.md`
  const data = preview._raw[mdPath] ?? preview._raw[`${dirName}/SKILL.md`]
  return data ? new TextDecoder().decode(data) : null
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
): Promise<{ count: number; manifest: SkillStoreEntry; outcome: InstallOutcome }> {
  const report = (p: Omit<InstallProgress, 'bytesLoaded' | 'bytesTotal'>) =>
    onProgress?.(p)

  report({ phase: 'fetching', message: tr('skills.discover.progressPreparing') })

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
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

    // Version-update flow (#154): compare the store ZIP's version against
    // the installed copy. Store-newer → overwrite in place; equal → keep
    // the installed copy; installed-newer → skip (no silent downgrade).
    // An unparseable/missing version on either side falls back to the old
    // ifAbsent behavior (never clobber an install of unknown provenance).
    const dirName = preview.skill?.dirName ?? ''
    const installed = dirName
      ? await readInstalledSkillVersion(dirName)
      : { version: null }
    // A failed read is NOT "unknown version": the update decision cannot be
    // made, so the failure is surfaced instead of silently keeping the stale
    // copy (the old fallback would report "Already installed").
    if (installed.error) throw installed.error
    const installedVersion = installed.version
    const storeVersion = dirName
      ? parseSkillMdVersion(extractStoreSkillMd(preview, dirName) ?? '')
      : null
    const alreadyInstalled = installedVersion !== null

    report({ phase: 'importing', message: tr('skills.discover.progressInstalling') })
    // Cleanup on failure is handled inside importUserSkillZip: it removes
    // only directories this import actually wrote and restores overwritten
    // skills from a staged backup — previously installed skills that merely
    // appear in the preview are never deleted.
    let count: number
    let doneMessage: string
    let outcome: InstallOutcome
    if (!alreadyInstalled || storeVersion === null) {
      count = await importUserSkillZip(preview, { ifAbsent: true })
      outcome = count === 0 ? 'current' : 'installed'
      doneMessage =
        count === 0
          ? tr('skills.discover.alreadyInstalled')
          : tr('skills.discover.installedFiles', { count })
    } else {
      const action = decideSkillUpdateAction(storeVersion, installedVersion)
      outcome = action === 'update' ? 'updated' : action
      if (action === 'current') {
        count = 0
        doneMessage = tr('skills.discover.alreadyInstalledVersion', { version: installedVersion })
      } else if (action === 'installed-newer') {
        count = 0
        doneMessage = tr('skills.discover.skippedUpdate', {
          installed: installedVersion,
          store: storeVersion,
        })
      } else {
        count = await importUserSkillZip(preview)
        outcome = count === 0 ? 'current' : 'updated'
        doneMessage =
          count === 0
            ? tr('skills.discover.alreadyInstalled')
            : tr('skills.discover.updatedVersion', {
                from: installedVersion,
                to: storeVersion,
                count,
              })
      }
    }

    // Find manifest entry (best effort — caller may not have it)
    const manifest: SkillStoreEntry = {
      id: preview.skill?.dirName ?? filename.replace(/\.zip$/, ''),
      name: preview.skill?.dirName ?? filename.replace(/\.zip$/, ''),
      dirName: preview.skill?.dirName ?? filename.replace(/\.zip$/, ''),
      description: '',
      category: '',
      tags: [],
      version: storeVersion ?? '',
      zipUrl,
    }

    report({ phase: 'done', message: doneMessage })
    return { count, manifest, outcome }
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
