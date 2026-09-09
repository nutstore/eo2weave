---
title: Configure AI Models
order: 9
---

# Configure AI Models

This guide walks you through configuring an AI provider, your pinned ("favorite") models, and the global default model. Once all three are in place you can start chatting right away.

## Overview

Model configuration in EO2Weave has three layers:

| Layer | What it does | Where |
|-------|--------------|-------|
| ① Provider API Key | Proves you have access to the provider's API | Settings → LLM Providers |
| ② Pinned models (optional) | Pick your frequently-used models for quick switching | Settings → LLM Providers → provider card |
| ③ Default provider & model | The global default used for every new conversation | Settings → LLM Providers → Default Model, or the top-bar switcher |

> How they relate: the Key is your "pass", pinned models are your "favorites", and the default model is "the one in use right now". With only a Key and no default model selected, conversations cannot start.

## Step 1: Configure a provider API key

1. Click **Settings** (gear icon) in the top bar
2. Select **LLM Providers** in the left navigation
3. Find your provider (OpenAI, Anthropic, GLM, DeepSeek, etc.) and click to expand its card
4. Paste your API key (create one in the provider's developer console) into the **API Key** field
5. Click **Save**

Inside an expanded card you can also:

- **Refresh the model list**: click the refresh icon next to "My models" to pull the real model list from the provider's `/models` API
- **Configure multiple providers**: repeat the steps above — each provider stores its own key independently

> 💡 Recommended: Jianguoyun AI. Click "Login with Jianguoyun Account" on the welcome screen and you're done — no manual key management.

> 💡 Prefer local models (free, data never leaves your machine)? See [Connect Ollama local models](./ollama.md).

## Step 2: Pin your favorite models (optional)

Pinned models are a curated subset of a provider's models. Once pinned, the top-bar model switcher shows only those models for faster switching; without pins, the switcher lists the provider's full built-in catalog.

1. Expand a provider card that has a saved key on the **LLM Providers** page
2. In the **My models** area:
   - Click **Add from API** to pick from the fetched model list (recommended — exact names)
   - Or click **Add manually** to type a model ID (useful for brand-new models not yet in the API list)
3. Pinned models appear as tags; click the × on a tag to remove it

## Step 3: Choose the default provider & model

This step is **required** — otherwise sending a message fails with "model not configured". Two entry points:

### Option A: Settings page (recommended for first-time setup)

1. Open the **Default model** dropdown at the top of the **LLM Providers** page
2. Pick a provider group, then a model
3. Close settings — done

### Option B: Top-bar model switcher (for everyday switching)

1. Click the **model switcher** in the top bar (✦ button showing the current model name)
2. Pick a model from the provider-grouped panel
3. Takes effect immediately for new conversations

> In side-panel / narrow viewports the switcher is shown directly in the top bar as well.

## Verify your setup

- The "No API Key" warning in the top bar is gone
- The switcher shows "Provider / model" (e.g. `OpenAI / GPT-4o`) instead of "Model unavailable"
- The welcome setup card is gone and the input box accepts messages

## FAQ

### I saved a key — why does it still say "model not configured"?

A key alone is only the "pass". You still need to pick a **default provider & model** (see Step 3). Open Settings → LLM Providers and choose one in the "Default model" dropdown.

### My provider doesn't show up in the switcher

Make sure the card is expanded and the key is saved (the dot on the left of the card is green). If the provider's model list is empty right after saving, it may be hidden — refresh the model list and try again.

### How do I change the default model?

Click the top-bar switcher any time, or go back to the "Default model" dropdown in Settings. Your last-used model per provider is remembered and restored when you switch back.

### Where is my API key stored?

Keys are encrypted and stored locally in your browser's SQLite database — never uploaded. See [Backup & Migration](./backup.md) for moving to a new device.
