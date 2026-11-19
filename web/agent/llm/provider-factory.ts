import { PiAIProvider } from './pi-ai-provider'
import type { LLMProviderType } from '@/agent/providers/types'

export interface CreateProviderInput {
  apiKey: string
  providerType: LLMProviderType
  baseUrl: string
  model: string
  /** API mode for custom providers: 'chat-completions' or 'responses' */
  apiMode?: 'chat-completions' | 'responses'
  /** Conversation id used as the OpenCode Go session header. */
  sessionId?: string
}

export function createLLMProvider(input: CreateProviderInput): PiAIProvider {
  return new PiAIProvider({
    apiKey: input.apiKey,
    providerType: input.providerType,
    baseUrl: input.baseUrl,
    model: input.model,
    apiMode: input.apiMode,
    sessionId: input.sessionId,
  })
}
