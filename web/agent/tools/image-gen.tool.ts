/**
 * Image Generation Tool — allows the Agent to generate images from text prompts.
 *
 * Reuses the existing `generateImage()` from `@/agent/llm/image-gen`.
 * Generated images are saved to OPFS assets/ and the path is returned to the Agent
 * so it can reference the image in its response via markdown.
 *
 * Conditional registration: only available when:
 *   1. settings.imageGenModel is set
 *   2. The model can be matched in the current provider's model cache
 */

import type { ToolDefinition, ToolExecutor, ToolPromptDoc, ToolContext } from './tool-types'
import { resolveVfsTarget } from './vfs-resolver'
import { toolOkJson, toolErrorJson } from './tool-envelope'
import { generateImage } from '@/agent/llm/image-gen'
import { useSettingsStore } from '@/store/settings.store'
import { normalizeBaseUrl } from '@/agent/llm/pi-ai-url-utils'
import { getCachedModels } from '@/agent/providers/model-store'
import type { LLMProviderType } from '@/agent/providers/types'

//=============================================================================
// Availability Check
//=============================================================================

/**
 * Check if image generation is available for the current provider.
 *
 * The tool should only be registered when:
 *   1. settings.imageGenModel has a value
 *   2. The model can be found in the current provider's model cache
 */
export function isImageGenAvailable(): boolean {
  const { imageGenModel } = useSettingsStore.getState()
  if (!imageGenModel) return false

  const effectiveConfig = useSettingsStore.getState().getEffectiveProviderConfig()
  if (!effectiveConfig) return false

  // Check the provider's model cache — only exact match against the full
  // imageGenModel ID (e.g. "openai/gpt-image-2"). We do NOT match by short ID
  // because the same suffix can exist in non-OpenRouter providers
  // (e.g. Codex returns "gpt-image-2" as a text model, not an image gen model).
  const providerType = effectiveConfig.apiKeyProviderKey as LLMProviderType
  const cached =
    getCachedModels(providerType, providerType) ||
    getCachedModels(providerType)
  if (!cached) return false

  return cached.some((m) => m.id === imageGenModel)
}

//=============================================================================
// Tool Definition
//==============================================================================

export const imageGenDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'generate_image',
    description:
      'Generate an image from a text description. Suitable for article illustrations, concept art, cover images, icons, etc. ' +
      'Supports various aspect ratios. The generated image is saved to the assets directory and the path is returned for reference in markdown.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'Image description. Use English for best results. Be specific — include style, composition, colors, and mood. ' +
            'Example: "A minimalist logo of a coffee cup with steam forming a heart shape, flat design, white background"',
        },
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
          description:
            'Image aspect ratio. 1:1 for avatars/icons, 16:9 for covers/banners, 9:16 for phone wallpapers, 4:3 and 3:2 for standard photos.',
        },
      },
      required: ['prompt'],
    },
  },
}

//=============================================================================
// Tool Executor
//=============================================================================

/**
 * Convert a base64 string to a Uint8Array.
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
 * Generate a short hash (6 hex chars) from a string for file naming.
 */
function shortHash(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i)
    hash = ((hash << 5) - hash + char) | 0 // Convert to 32bit integer
  }
  return (hash >>> 0).toString(16).slice(0, 6).padStart(6, '0')
}

/**
 * Get file extension from MIME type.
 */
function extensionFromMimeType(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
  }
  return map[mimeType] ?? 'png'
}

/**
 * Format current date as YYYYMMDD string.
 */
function dateStamp(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

export const imageGenExecutor: ToolExecutor = async (
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<string> => {
  const prompt = args.prompt as string | undefined
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return toolErrorJson('generate_image', 'invalid_arguments', 'prompt is required and must be a non-empty string')
  }

  const aspectRatio = (args.aspect_ratio as string | undefined) || undefined

  // Validate aspect_ratio if provided
  const VALID_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']
  if (aspectRatio && !VALID_RATIOS.includes(aspectRatio)) {
    return toolErrorJson(
      'generate_image',
      'invalid_arguments',
      `Invalid aspect_ratio "${aspectRatio}". Must be one of: ${VALID_RATIOS.join(', ')}`,
    )
  }

  // 1. Resolve settings and API key
  const settingsState = useSettingsStore.getState()
  const effectiveConfig = settingsState.getEffectiveProviderConfig()
  if (!effectiveConfig) {
    return toolErrorJson(
      'generate_image',
      'no_provider',
      'No provider configured. Please configure a provider in settings first.',
    )
  }

  const imageModelId = settingsState.imageGenModel

  try {
    const { getApiKeyRepository } = await import('@/sqlite')
    const apiKey = await getApiKeyRepository().load(effectiveConfig.apiKeyProviderKey)
    if (!apiKey) {
      return toolErrorJson(
        'generate_image',
        'no_api_key',
        'API Key not set. Please configure your API key in settings.',
      )
    }

    // 2. Call generateImage (reuse existing function — zero new image gen code)
    const resolvedAspectRatio = aspectRatio || settingsState.imageGenAspectRatio || '1:1'
    const result = await generateImage(
      prompt.trim(),
      {
        apiKey,
        baseUrl: normalizeBaseUrl(effectiveConfig.baseUrl),
        modelId: imageModelId,
        providerKey: effectiveConfig.apiKeyProviderKey,
        aspectRatio: resolvedAspectRatio,
      },
      context.abortSignal,
    )

    // 3. Check for errors
    if (result.stopReason === 'error') {
      return toolErrorJson(
        'generate_image',
        'image_gen_failed',
        `Image generation failed: ${result.errorMessage || 'Unknown error'}`,
        { retryable: true },
      )
    }

    // 4. Extract image data from result
    const images: Array<{ data: string; mimeType: string }> = []
    const textParts: string[] = []
    for (const block of result.output) {
      if (block.type === 'text' && block.text) textParts.push(block.text)
      if (block.type === 'image' && block.data && block.mimeType) {
        images.push({ data: block.data, mimeType: block.mimeType })
      }
    }

    if (images.length === 0) {
      return toolErrorJson(
        'generate_image',
        'no_image_output',
        'Image generation completed but produced no image output. The model may not support image generation.',
        {
          retryable: true,
          details: { textOutput: textParts.join('') || '(none)' },
        },
      )
    }

    // 5. Save images to OPFS assets
    const savedPaths: string[] = []
    const timestamp = dateStamp()

    for (let i = 0; i < images.length; i++) {
      const img = images[i]!
      const ext = extensionFromMimeType(img.mimeType)
      const hash = shortHash(`${prompt}-${i}-${Date.now()}`)
      const fileName = `${timestamp}_${hash}.${ext}`
      const assetPath = `images/${fileName}`

      try {
        // Write to OPFS via the assets backend
        const target = await resolveVfsTarget(`vfs://assets/${assetPath}`, context, 'write')
        const binaryData = base64ToUint8Array(img.data)
        await target.backend.writeFile(target.path, binaryData.buffer as ArrayBuffer)
        savedPaths.push(assetPath)
      } catch (writeError) {
        console.error('[generate_image] Failed to write image to OPFS:', writeError)
        // Continue with remaining images even if one fails
      }
    }

    if (savedPaths.length === 0) {
      return toolErrorJson(
        'generate_image',
        'save_failed',
        'Image was generated but could not be saved to storage.',
        { retryable: true },
      )
    }

    // 6. Return success with paths
    const primaryPath = savedPaths[0]!
    const description = textParts.join('').trim() || 'Generated image'

    return toolOkJson('generate_image', {
      path: `assets/${primaryPath}`,
      mimeType: images[0]!.mimeType,
      description,
      count: savedPaths.length,
      paths: savedPaths.map((p) => `assets/${p}`),
      message: `Image generated successfully. Use \`![${description}](assets/${primaryPath})\` to reference in markdown.`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    // Detect common error patterns for better error messages
    if (message.includes('content_policy') || message.includes('safety') || message.includes('blocked')) {
      return toolErrorJson(
        'generate_image',
        'content_filtered',
        `Image generation was blocked by content safety filters. Try rephrasing your prompt. Details: ${message}`,
      )
    }

    if (message.includes('rate_limit') || message.includes('quota') || message.includes('429')) {
      return toolErrorJson(
        'generate_image',
        'rate_limited',
        'Image generation rate limit exceeded. Please wait a moment and try again.',
        { retryable: true },
      )
    }

    if (message.includes('model_not_found') || message.includes('does not exist') || message.includes('not_found')) {
      return toolErrorJson(
        'generate_image',
        'model_unavailable',
        `Image generation model "${imageModelId}" is not available. It may not be supported by your current provider.`,
      )
    }

    return toolErrorJson('generate_image', 'image_gen_failed', `Image generation failed: ${message}`, {
      retryable: true,
    })
  }
}

//=============================================================================
// Prompt Doc
//=============================================================================

export const imageGenPromptDoc: ToolPromptDoc = {
  category: 'file-ops',
  lines: [
    '- `generate_image(prompt, aspect_ratio?)` - Generate an image from a text description. Returns the asset path for markdown embedding. Supports aspect ratios: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3.',
    '- Image-creation intent (user says 画/生成图片/插图/封面/logo/配图, or "draw"/"generate an image"/"illustration"/"cover"/"logo"): call `generate_image` in the SAME turn — no clarifying questions for simple requests, and never substitute a text description for the actual image.',
    '- Pick aspect_ratio from context (banner/hero → 16:9, poster → 3:4, avatar/icon → 1:1); omit when the user does not imply a shape. Available in both Plan and Act modes.',
  ],
}
