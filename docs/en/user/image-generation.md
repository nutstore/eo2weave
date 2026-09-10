---
title: Image Generation
order: 10
---

# Image Generation

EO2Weave can generate images right inside a conversation: describe what you want in plain language, the AI calls an image model, and the result is placed in the chat — ready to be embedded into documents as an illustration. No slash commands needed.

## Which providers are supported (important)

**Image generation currently works only with OpenRouter-style providers.**

| Your provider | Image generation | Notes |
|---------------|------------------|-------|
| OpenRouter (or an OpenRouter-style relay whose model list contains image models) | ✅ Yes | Image models appear in the model selector |
| OpenAI / Anthropic / GLM / DeepSeek / Codex / Ollama, etc. | ❌ Not yet | The image generation UI stays hidden |

**How to check**: image models are discovered from your provider's model list. After expanding the provider card and refreshing the model list, if the image-model selector in the top bar does not appear, your provider is not supported yet.

> Why: image generation relies on exactly matching an image model inside the provider's model list. Only OpenRouter-style `/models` endpoints return image models (e.g. the `google/gemini-3.1-flash-image` family). Other providers have no image models to match, so the feature stays hidden rather than erroring out.
>
> Support for custom relays (manually entering an image model ID) is planned.

## How to generate an image

**Option 1: just ask (recommended)**

Describe the image in one sentence, for example:

- "Draw an orange cat in watercolor style"
- "Generate a 16:9 cyberpunk city at night"
- "Create a cover image for this article: a forest cabin under snowy mountains"

The AI calls the image model directly, shows the image in the conversation, and saves it to your local assets.

**Option 2: the "Generate an image" chip**

A small pill button above the input box pre-fills an example prompt — complete it and send. You can dismiss it with × (remembered; it won't come back).

## Aspect ratio

The image-model selector in the top bar (🖼️) also offers aspect ratios: 1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3.

- You can also name the shape in words — "a vertical poster" picks 3:4 automatically
- If unspecified, the AI decides based on context

## Works in Plan mode too

Image generation does not require Act mode — it only writes generated images into the assets directory and never modifies your workspace files, so it works directly in Plan (read-only) mode.

## Where are images stored?

Generated images are stored in your browser's local asset directory (OPFS) and never uploaded to any server. View them via the assets panel; deleting a conversation does not delete its images.

## FAQ

### I don't see the "Generate an image" chip?

The most common reason is an **unsupported provider** (see the table above). Make sure you use OpenRouter or a compatible relay, and that:

1. Your API key is saved in Settings → LLM Providers
2. You expanded the provider card and **refreshed the model list** (the feature depends on the fetched model list)
3. The image-model selector (🖼️) appears in the top bar

Only when all three are true does the chip appear above the input box — by design: the entry point only shows up when it can actually work, never as a button that errors out.

### Generation fails with "model unavailable"?

The selected image model may have been retired, or your relay does not actually serve it. Pick another image model in the top-bar selector and retry.

### Generation blocked by a content-policy message?

Image models refuse clearly violating prompts. Rephrase and try again.

### How is it billed?

Image generation is billed separately by your provider (usually more expensive than text chat). Check the pricing of the selected model before generating. In-app price display is planned.
