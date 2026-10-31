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
  ZIP_IMPORT_LIMITS,
  type ZipSkillPreview,
} from './user-skills-scanner'
import { useSkillsStore } from '@/store/skills.store'
import { formatBytes } from '@/lib/utils'

// ---------- Types ----------

export interface SkillStoreEntry {
  id: string
  name: string
  dirName: string
  description: string
  category: string
  tags: string[]
  version: string
  zipUrl: string
  fileCount?: number
  /** 本地是否已安装（按 dirName 判断） */
  installed?: boolean
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
 * Progress messages are intentionally in English by default (this helper is
 * i18n-agnostic — it has no access to useT). Callers that care about UX
 * should pass their own `onProgress` to translate messages before display.
 */
export const DOWNLOAD_TIMEOUT_MS = 60_000

export async function installSkillFromUrl(
  zipUrl: string,
  onProgress?: (p: InstallProgress) => void,
): Promise<{ count: number; manifest: SkillStoreEntry }> {
  const report = (p: Omit<InstallProgress, 'bytesLoaded' | 'bytesTotal'>) =>
    onProgress?.(p)

  report({ phase: 'fetching', message: 'Downloading…' })

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
            ? `Downloading… (${formatBytes(loaded)} / ${formatBytes(displayTotal)})`
            : `Downloading… (${formatBytes(loaded)})`,
          bytesLoaded: loaded,
          bytesTotal: displayTotal || undefined,
        })
      },
    )
    clearTimeout(timeoutId)

    // Wrap as File (previewUserSkillZip expects File)
    const filename = zipUrl.split('/').pop() ?? 'skill.zip'
    const file = new File([blob], filename, { type: 'application/zip' })

    report({ phase: 'previewing', message: 'Validating…' })
    const preview = await previewUserSkillZip(file)

    report({ phase: 'importing', message: 'Installing…' })
    // Cleanup on failure is handled inside importUserSkillZip: it removes
    // only directories this import actually wrote and restores overwritten
    // skills from a staged backup — previously installed skills that merely
    // appear in the preview are never deleted.
    const count = await importUserSkillZip(preview, { ifAbsent: true })

    // Find manifest entry (best effort — caller may not have it)
    const manifest: SkillStoreEntry = {
      id: preview.skill?.dirName ?? filename.replace(/\.zip$/, ''),
      name: preview.skill?.dirName ?? filename.replace(/\.zip$/, ''),
      dirName: preview.skill?.dirName ?? filename.replace(/\.zip$/, ''),
      description: '',
      category: '',
      tags: [],
      version: '',
      zipUrl,
    }

    report({ phase: 'done', message: count === 0 ? 'Already installed' : `Installed ${count} files` })
    return { count, manifest }
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
