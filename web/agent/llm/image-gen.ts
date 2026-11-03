/**
 * Image generation wrapper.
 *
 * Wraps `@earendil-works/pi-ai`'s `generateImages` function.
 * Uses `onPayload` hook to inject OpenRouter-specific `image_config`
 * (aspect_ratio) into the API request body before it is sent.
 */

import { generateImages, getImageModel, type AssistantImages } from '@earendil-works/pi-ai'

export interface ImageGenConfig {
  apiKey: string
  baseUrl: string
  modelId: string
  providerKey: string
  /** Desired aspect ratio, e.g. "16:9", "1:1", "4:3", "3:4" */
  aspectRatio?: string
}

export function hasCodexImageBridge(): boolean {
  if (typeof window === 'undefined') return false
  const bridge = (window as unknown as { __agentWeb?: { ready?: boolean; codexImageGenerationEnabled?: boolean; codexGenerateImage?: unknown } }).__agentWeb
  return !!bridge?.ready && bridge.codexImageGenerationEnabled === true && typeof bridge.codexGenerateImage === 'function'
}

/**
 * Generate an image from a text prompt.
 */
export async function generateImage(
  prompt: string,
  config: ImageGenConfig,
  signal?: AbortSignal
): Promise<AssistantImages> {
  if (config.providerKey === 'codex-oauth') {
    return generateCodexImage(prompt, config.aspectRatio, signal)
  }
  // Parse provider from modelId: "google/gemini-2.5-flash-image" → provider="google", id="gemini-2.5-flash-image"
  const slashIndex = config.modelId.indexOf('/')
  const provider = slashIndex > 0 ? config.modelId.slice(0, slashIndex) : config.providerKey
  const modelShortId = slashIndex > 0 ? config.modelId.slice(slashIndex + 1) : config.modelId

  // Try to resolve from the pi-ai built-in image model registry first
  const resolvedModel = getImageModel(provider as any, modelShortId as any)

  // Fallback: construct a minimal model if not in the registry
  const model = resolvedModel ?? {
    id: modelShortId,
    name: config.modelId,
    api: 'openrouter-images',
    provider,
    baseUrl: config.baseUrl,
    input: ['text', 'image'],
    output: ['image', 'text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as any

  // Use onPayload to inject image_config.aspect_ratio into the request body.
  // OpenRouter supports this parameter to control the output image dimensions.
  // When aspectRatio is not specified, the model default (usually 1:1) is used.
  const aspectRatio = config.aspectRatio

  return generateImages(
    model,
    { input: [{ type: 'text', text: prompt }] },
    {
      apiKey: config.apiKey,
      signal,
      onPayload: aspectRatio
        ? (payload: unknown) => {
            if (payload && typeof payload === 'object') {
              const body = payload as Record<string, unknown>
              body.image_config = {
                ...(body.image_config as Record<string, unknown> | undefined),
                aspect_ratio: aspectRatio,
              }
            }
            return undefined // keep the modified payload
          }
        : undefined,
    }
  )
}

async function generateCodexImage(prompt: string, aspectRatio?: string, signal?: AbortSignal): Promise<AssistantImages> {
  const result: AssistantImages = {
    api: 'codex-images', provider: 'codex-oauth', model: 'gpt-image-2',
    output: [], stopReason: 'stop', timestamp: Date.now(),
  }
  try {
    const bridge = (window as unknown as { __agentWeb?: {
      ready?: boolean
      codexGenerateImage?: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<{
        ok: boolean; status?: number; text?: string; message?: string; error?: string
      }>
    } }).__agentWeb
    if (!bridge?.ready || !bridge.codexGenerateImage) throw new Error('Image generation is unavailable for this provider.')
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    const response = await bridge.codexGenerateImage({
      prompt: aspectRatio ? `${prompt}\n\nAspect ratio: ${aspectRatio}.` : prompt,
      model: 'gpt-image-2', background: 'auto', quality: 'auto', size: 'auto',
    }, signal)
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    if (!response.ok) throw new Error(response.text || response.message || response.error || `Codex image request failed (${response.status ?? 'unknown'}).`)
    const payload = JSON.parse(response.text || '{}') as { data?: Array<{ b64_json?: string }> }
    for (const image of payload.data ?? []) {
      if (image.b64_json) result.output.push({ type: 'image', data: image.b64_json, mimeType: 'image/png' })
    }
    if (!result.output.length) throw new Error('Codex image response contained no image data.')
  } catch (error) {
    result.stopReason = signal?.aborted ? 'aborted' : 'error'
    result.errorMessage = error instanceof Error ? error.message : String(error)
  }
  return result
}
