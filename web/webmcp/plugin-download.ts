import type { ToolContext } from '@/agent/tools/tool-types'
import { AssetsBackend } from '@/agent/tools/backends/assets-backend'
import type {
  WebMCPBridge,
  WebMCPPluginDownloadChunkFrame,
  WebMCPPluginDownloadFrame,
  WebMCPPluginDownloadPlan,
  WebMCPPluginDownloadStartFrame,
} from './types'

/**
 * The run was cancelled at any stage of the plugin-download pipeline:
 * before the transfer started, while the stream was in flight, after the
 * asset was saved, or between the save and finalize. The bridge maps this
 * marker to the CALL_CANCELLED envelope instead of a plain
 * WEBMCP_PLUGIN_DOWNLOAD_FAILED (#139 review round 5: aborts become
 * download failures). The message value doubles as the internal sentinel.
 */
export const WEBMCP_DOWNLOAD_ABORTED = '__WEBMCP_DOWNLOAD_ABORTED__'

/**
 * Paths currently owned by in-flight downloads (module-level: shared across
 * all concurrent downloads in this JS context). `resolveUniqueAssetPath`
 * probes the filesystem, but two downloads starting in the same tick both
 * see the same "unique" candidate — the claim makes the pick exclusive so a
 * later rollback can never delete another download's file (#139 review
 * round 5: successful downloads lose their files).
 */
const claimedAssetPaths = new Set<string>()

/**
 * Claim an exclusive save path. Returns false if already claimed.
 * Exported so the bridge's rollback can consult the same registry (#139
 * review round 5: successful downloads lose their files).
 */
export function claimAssetPath(path: string): boolean {
  if (claimedAssetPaths.has(path)) return false
  claimedAssetPaths.add(path)
  return true
}

/** Release a claimed save path after the download settles. */
export function releaseAssetPath(path: string): void {
  claimedAssetPaths.delete(path)
}

/**
 * True while a path is owned by an in-flight download — a rollback must
 * NOT delete such a file (#139 review round 5: successful downloads lose
 * their files).
 */
export function isAssetPathClaimed(path: string): boolean {
  return claimedAssetPaths.has(path)
}

/**
 * Claim `candidate` and write the payload to it, atomically with respect
 * to other downloads:
 * - the exists-probe AND the write run inside a per-workspace Web Lock, so
 *   two downloads in DIFFERENT contexts cannot both pick the same free
 *   name (#139 review round 5: successful downloads lose their files);
 * - the in-context claim set covers same-context races;
 * - the claim stays registered until the caller releases it, so a concurrent
 *   rollback refuses to delete this download's file.
 * Returns the claimed path, or null when the name was already taken (the
 * caller advances to the next candidate).
 */
async function claimAssetPathUnderLock(
  backend: AssetsBackend,
  workspaceId: string,
  candidate: string,
  blob: Blob
): Promise<string | null> {
  const run = async (): Promise<string | null> => {
    if (await backend.exists(candidate)) return null
    if (!claimAssetPath(candidate)) return null
    try {
      await backend.writeFile(candidate, blob)
    } catch (e) {
      releaseAssetPath(candidate)
      throw e
    }
    return candidate
  }
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks) return run()
  let result: string | null = null
  await locks.request(`eo2weave-asset-claim:${workspaceId}`, async () => {
    result = await run()
  })
  return result
}

export interface PluginDownloadSaveResult {
  savedPath: string
  fileName: string
  mimeType: string
  size: number
  patchedResult: Record<string, unknown>
}

/**
 * The run aborted AFTER the asset was written to disk. Carries the saved
 * path so the caller can roll the orphaned asset back (#139 review: failed
 * finalize hides a saved file) instead of leaving a persistent file the
 * caller believes was never saved.
 */
export class SavedAssetAbortedError extends Error {
  readonly savedPath: string
  constructor(savedPath: string) {
    super(`Plugin download aborted after saving asset: ${savedPath}`)
    this.name = 'SavedAssetAbortedError'
    this.savedPath = savedPath
  }
}

function sanitizeFileName(name: string): string {
  const normalized = name.trim().replace(/[\\/]/g, '_').replace(/\s+/g, ' ')
  // eslint-disable-next-line no-control-regex -- intentionally strip ASCII control chars (NUL etc.) from downloaded file names
  const safe = normalized.replace(/[<>:"|?*\x00-\x1F]/g, '_')
  return safe || `download_${Date.now()}`
}

function normalizeSaveDir(rawPath?: string | null): string {
  const safeRawPath = typeof rawPath === 'string' ? rawPath : '/'
  let normalized = safeRawPath.trim().replace(/\\/g, '/')
  normalized = normalized.replace(/^vfs:\/\/assets\/?/i, '')
  normalized = normalized.replace(/^assets\/?/i, '')
  normalized = normalized.replace(/^\/+/, '')

  if (!normalized) return ''
  const segments = normalized.split('/').filter(Boolean)
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error(`Invalid save_path: ${safeRawPath}`)
    }
  }
  return segments.join('/')
}

function splitPath(path: string): { dir: string; fileName: string } {
  const parts = path.split('/').filter(Boolean)
  const fileName = parts.pop() || ''
  return {
    dir: parts.join('/'),
    fileName,
  }
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; mimeType: string } {
  if (!dataUrl.startsWith('data:') || !dataUrl.includes(';base64,')) {
    throw new Error('Invalid data URL payload')
  }
  const base64Marker = ';base64,'
  const markerIndex = dataUrl.indexOf(base64Marker)
  if (markerIndex < 0) {
    throw new Error('Invalid base64 payload')
  }

  const mimeType = dataUrl.slice(5, markerIndex) || 'application/octet-stream'
  const base64 = dataUrl.slice(markerIndex + base64Marker.length)
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return {
    blob: new Blob([bytes], { type: mimeType }),
    mimeType,
  }
}

function toStartFrame(frame: WebMCPPluginDownloadFrame): WebMCPPluginDownloadStartFrame {
  if (frame.type !== 'start') {
    throw new Error('Plugin download stream did not start with start frame')
  }
  return frame
}

function toChunkFrame(frame: WebMCPPluginDownloadFrame): WebMCPPluginDownloadChunkFrame {
  if (frame.type !== 'chunk') {
    throw new Error('Expected chunk frame')
  }
  return frame
}

function patchResultForAI(
  originalResult: Record<string, unknown>,
  vfsPath: string,
  fileName: string
): Record<string, unknown> {
  // Omit download_url/original_download_url from the result exposed to the AI;
  // the local file copy makes those remote URLs obsolete.
  const { download_url: _omitDownloadUrl, original_download_url: _omitOriginalUrl, ...rest } =
    originalResult
  void _omitDownloadUrl
  void _omitOriginalUrl

  const saveDir = vfsPath.slice(0, Math.max(vfsPath.lastIndexOf('/'), 0))
  return {
    ...rest,
    save_path: saveDir,
    read_path: vfsPath,
    saved_file_name: fileName,
  }
}

async function collectDataUrlFromFrames(
  stream: AsyncIterable<WebMCPPluginDownloadFrame>,
  expectedTransferId: string,
  context: ToolContext
): Promise<{ start: WebMCPPluginDownloadStartFrame; dataUrl: string }> {
  let startFrame: WebMCPPluginDownloadStartFrame | null = null
  let chunks: string[] = []

  // Race the PENDING `next()` against the abort signal: the loop below only
  // checks the signal after a frame arrives, so a stream stalled mid-transfer
  // would never observe the cancellation (#139 review round 5: stalled
  // downloads ignore cancellation). When abort wins, the stream is cancelled
  // best-effort and the distinct marker is thrown.
  let onAbort: (() => void) | undefined
  const abortPromise = context.abortSignal
    ? new Promise<never>((_, reject) => {
        if (context.abortSignal!.aborted) {
          reject(new Error(WEBMCP_DOWNLOAD_ABORTED))
          return
        }
        onAbort = () => {
          cancelPluginDownloadStream(stream)
          reject(new Error(WEBMCP_DOWNLOAD_ABORTED))
        }
        context.abortSignal!.addEventListener('abort', onAbort, { once: true })
      })
    : null
  const iterator = stream[Symbol.asyncIterator]()
  const raceNext = (): Promise<IteratorResult<WebMCPPluginDownloadFrame>> =>
    abortPromise ? Promise.race([iterator.next(), abortPromise]) : iterator.next()

  try {
    for (;;) {
      // Observe the run's abort signal between frames too: once the caller
      // has cancelled, the extension transfer must stop being consumed (#139
      // review: aborted downloads keep writing). The stream is cancelled
      // best-effort so the extension side stops transferring too.
      if (context.abortSignal?.aborted) {
        cancelPluginDownloadStream(stream)
        throw new Error(WEBMCP_DOWNLOAD_ABORTED)
      }
      const { done, value } = await raceNext()
      if (done) break
      const frame = value
      if (frame.type === 'error') {
        throw new Error(`[${frame.errorCode}] ${frame.message}`)
      }
      if (frame.type === 'start') {
        if (frame.transferId !== expectedTransferId) {
          throw new Error('Transfer ID mismatch on start frame')
        }
        startFrame = toStartFrame(frame)
        chunks = new Array(startFrame.totalChunks)
        continue
      }

      if (frame.type === 'chunk') {
        if (!startFrame) {
          throw new Error('Chunk received before start frame')
        }
        if (frame.transferId !== expectedTransferId) {
          throw new Error('Transfer ID mismatch on chunk frame')
        }
        const chunkFrame = toChunkFrame(frame)
        if (chunkFrame.index < 0 || chunkFrame.index >= chunks.length) {
          throw new Error(`Invalid chunk index: ${chunkFrame.index}`)
        }
        chunks[chunkFrame.index] = chunkFrame.data
        continue
      }

      if (frame.type === 'end') {
        if (!startFrame) {
          throw new Error('End received before start frame')
        }
        if (frame.transferId !== expectedTransferId) {
          throw new Error('Transfer ID mismatch on end frame')
        }
        break
      }
    }
  } finally {
    // Drop the abort listener on every exit path — success, error, and
    // cancellation alike (the signal may outlive this download across a
    // long run; #139 review: listener accumulation). Best-effort close of
    // the iterator mirrors what `for await` would do.
    if (onAbort && context.abortSignal) {
      context.abortSignal.removeEventListener('abort', onAbort)
    }
    void iterator.return?.().catch(() => {})
  }

  if (!startFrame) {
    throw new Error('No start frame received')
  }

  if (chunks.some((chunk) => typeof chunk !== 'string')) {
    throw new Error('Missing chunk data in plugin download stream')
  }

  const dataUrl = chunks.join('')
  if (dataUrl.length !== startFrame.totalChars) {
    throw new Error('Plugin download stream length mismatch')
  }
  return { start: startFrame, dataUrl }
}

/**
 * Best-effort cancel of an in-flight plugin-download transfer: the stream
 * iterator exposes `cancel` (#139 review: cancelled transfers keep writing
 * assets). Never throws — a missing or failing cancel must not mask the
 * original abort.
 */
export function cancelPluginDownloadStream(
  stream: AsyncIterable<WebMCPPluginDownloadFrame>
): void {
  const cancellable = stream as AsyncIterable<WebMCPPluginDownloadFrame> & {
    cancel?: () => void
  }
  try {
    cancellable.cancel?.()
  } catch { /* best-effort: the abort error is already propagating */ }
}

export async function consumeAndSavePluginDownload(
  bridge: WebMCPBridge,
  plan: WebMCPPluginDownloadPlan,
  context: ToolContext
): Promise<PluginDownloadSaveResult> {
  const workspaceId = context.workspaceId?.trim()
  if (!workspaceId) {
    throw new Error('workspaceId is required for plugin download assets save')
  }

  if (!bridge.webMCPPluginDownloadStream) {
    throw new Error('Plugin download streaming is not supported by the browser extension')
  }

  // Already-aborted run: do not start the transfer at all (#139 review:
  // cancelled transfers keep writing assets). Throw the DISTINCT marker
  // (not the signal's native abort error) so the caller's catch classifies
  // it as cancellation, not a download failure (#139 review round 5:
  // aborts become download failures).
  if (context.abortSignal?.aborted) {
    throw new Error(WEBMCP_DOWNLOAD_ABORTED)
  }

  const stream = bridge.webMCPPluginDownloadStream({
    transferId: plan.transferId,
    downloadUrl: plan.downloadUrl,
    savePath: plan.savePath || '/',
    fileName: plan.fileName,
  })

  const { start, dataUrl } = await collectDataUrlFromFrames(stream, plan.transferId, context)

  // Abort between stream completion and the save: the downloaded payload is
  // discarded — the asset must not be written after the caller cancelled.
  // Surface a distinct marker (not a bare AbortError) so the bridge can
  // return the cancellation envelope instead of a generic failure (#139
  // review: aborted downloads keep writing).
  if (context.abortSignal?.aborted) {
    throw new Error(WEBMCP_DOWNLOAD_ABORTED)
  }

  const safeFileName = sanitizeFileName(start.fileName)
  const saveDir = normalizeSaveDir(start.savePath || plan.savePath || '/')
  const targetPath = saveDir ? `${saveDir}/${safeFileName}` : safeFileName

  const backend = new AssetsBackend(workspaceId)
  const { blob, mimeType } = dataUrlToBlob(dataUrl)
  // Claim the path EXCLUSIVELY: the probe and the write run together under
  // a per-workspace Web Lock, so two concurrent downloads cannot both
  // observe "free" and write the same path — one download's rollback would
  // then delete the other's asset (#139 review round 5: successful
  // downloads lose their files). The in-context claim set covers the
  // same-context race; the Web Lock covers the cross-context one (same
  // rationale as the project auto-create lock).
  let finalPath = await claimAssetPathUnderLock(backend, workspaceId, targetPath, blob)
  for (let index = 1; !finalPath; index++) {
    const { dir, fileName } = splitPath(targetPath)
    const dotIndex = fileName.lastIndexOf('.')
    const base = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
    const ext = dotIndex > 0 ? fileName.slice(dotIndex) : ''
    const candidateName = `${base}-${index}${ext}`
    const candidate = dir ? `${dir}/${candidateName}` : candidateName
    finalPath = await claimAssetPathUnderLock(backend, workspaceId, candidate, blob)
  }
  if (!finalPath) {
    throw new Error('Could not allocate a unique asset path for the plugin download')
  }

  // Abort after the save: the file already landed on disk. The claim is
  // RELEASED here (the caller's rollback is now allowed to delete it — no
  // other download owns this path). Surface a distinct error so the caller
  // can roll the saved asset back (#139 review: failed finalize hides a
  // saved file) instead of reporting a plain failure that hides it.
  if (context.abortSignal?.aborted) {
    releaseAssetPath(finalPath)
    throw new SavedAssetAbortedError(finalPath)
  }

  const vfsPath = `vfs://assets/${finalPath}`
  const patchedResult = patchResultForAI(plan.originalResult, vfsPath, safeFileName)

  // Success: the caller (or the user) now owns the file — release the claim
  // so any future rollback won't be blocked by it.
  releaseAssetPath(finalPath)

  return {
    savedPath: finalPath,
    fileName: safeFileName,
    mimeType,
    size: blob.size,
    patchedResult,
  }
}
