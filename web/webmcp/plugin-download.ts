import type { ToolContext } from '@/agent/tools/tool-types'
import { AssetsBackend } from '@/agent/tools/backends/assets-backend'
import type {
  WebMCPBridge,
  WebMCPPluginDownloadChunkFrame,
  WebMCPPluginDownloadFrame,
  WebMCPPluginDownloadPlan,
  WebMCPPluginDownloadStartFrame,
} from './types'

export interface PluginDownloadSaveResult {
  savedPath: string
  fileName: string
  mimeType: string
  size: number
  patchedResult: Record<string, unknown>
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

async function resolveUniqueAssetPath(backend: AssetsBackend, path: string): Promise<string> {
  if (!(await backend.exists(path))) return path

  const { dir, fileName } = splitPath(path)
  const dotIndex = fileName.lastIndexOf('.')
  const base = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
  const ext = dotIndex > 0 ? fileName.slice(dotIndex) : ''

  let index = 1
  // eslint-disable-next-line no-constant-condition -- probe candidate names until a free path is found
  while (true) {
    const candidateName = `${base}-${index}${ext}`
    const candidate = dir ? `${dir}/${candidateName}` : candidateName
    if (!(await backend.exists(candidate))) {
      return candidate
    }
    index++
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
  expectedTransferId: string
): Promise<{ start: WebMCPPluginDownloadStartFrame; dataUrl: string }> {
  let startFrame: WebMCPPluginDownloadStartFrame | null = null
  let chunks: string[] = []

  for await (const frame of stream) {
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
  const stream = bridge.webMCPPluginDownloadStream({
    transferId: plan.transferId,
    downloadUrl: plan.downloadUrl,
    savePath: plan.savePath || '/',
    fileName: plan.fileName,
  })

  const { start, dataUrl } = await collectDataUrlFromFrames(stream, plan.transferId)
  const safeFileName = sanitizeFileName(start.fileName)
  const saveDir = normalizeSaveDir(start.savePath || plan.savePath || '/')
  const targetPath = saveDir ? `${saveDir}/${safeFileName}` : safeFileName

  const backend = new AssetsBackend(workspaceId)
  const finalPath = await resolveUniqueAssetPath(backend, targetPath)
  const { blob, mimeType } = dataUrlToBlob(dataUrl)
  await backend.writeFile(finalPath, blob)

  const vfsPath = `vfs://assets/${finalPath}`
  const patchedResult = patchResultForAI(plan.originalResult, vfsPath, safeFileName)

  return {
    savedPath: finalPath,
    fileName: safeFileName,
    mimeType,
    size: blob.size,
    patchedResult,
  }
}
