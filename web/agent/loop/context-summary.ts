import type { CompressionSummaryMode } from './types'
import type { PiAIProvider } from '../llm/pi-ai-provider'

const CONTEXT_SUMMARY_SYSTEM_PROMPT = `You are compressing an earlier conversation into a dense memory snapshot. Another AI will continue from this summary, so you must preserve:

1. **User's goals and intentions** - what the user was trying to accomplish
2. **Key decisions made** - architectural choices, file changes, tool selections
3. **Important constraints** - requirements, limits, conventions being followed
4. **File paths and locations** - files created/modified/deleted, important references
5. **Tool findings and results** - search results, read file contents, critical outputs
6. **Unresolved tasks** - what still needs to be done, next steps, open questions
7. **Error context** - failures encountered and how they were addressed

Output format:
- Use bullet points for scanability
- Group by topic rather than chronologically
- Preserve specific names, paths, and numbers (don't generalize)
- Keep the most recent and relevant information
- Total output should be dense but complete - prefer specifics over vagaries

Example:
**User Goal**: Implement user authentication with JWT
**Decisions**: Use bcrypt for passwords, JWT with 24h expiry, store refresh tokens in httpOnly cookies
**Files**: src/auth/login.ts (new), src/auth/jwt.ts (new), src/middleware/auth.ts (modified)
**Progress**: Login endpoint complete, registration WIP, refresh token not yet implemented
**Errors**: CORS error on first attempt, resolved by adding credentials: 'include'`

export async function generateContextSummaryWithLLM(input: {
  provider: PiAIProvider
  droppedContent: string
  maxSummaryTokens: number
  compressedMemoryPrefix: string
  signal?: AbortSignal
}): Promise<{ summary: string | null; mode: CompressionSummaryMode }> {
  try {
    const response = await input.provider.chat(
      {
        messages: [
          { role: 'system', content: CONTEXT_SUMMARY_SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              'Summarize the following dropped conversation context. Keep it concise and actionable.\n\n' +
              input.droppedContent,
          },
        ],
        maxTokens: input.maxSummaryTokens,
        temperature: 0.1,
      },
      input.signal,
    )

    const summary = response.choices[0]?.message?.content?.trim()
    if (!summary) {
      throw new Error('The model returned an empty context summary. Please try again.')
    }
    return { summary, mode: 'llm' }
  } catch (error) {
    console.error('[AgentLoop] LLM context summary failed:', error)
    throw error
  }
}
