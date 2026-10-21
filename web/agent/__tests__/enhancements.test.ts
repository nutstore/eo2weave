import { describe, expect, it } from 'vitest'
import { buildRuntimeEnhancedPrompt } from '@/agent/loop/enhancements'
import type { ToolContext } from '@/agent/tools/tool-types'

const input = {
  baseSystemPrompt: 'BASE_PROMPT', messages: [], mode: 'act' as const,
  toolContext: { workspaceId: 'one', projectId: 'project-one' } as ToolContext,
}

describe('stable runtime instructions', () => {
  it('does not change the prefix when mode, project, or conversation changes', async () => {
    const first = await buildRuntimeEnhancedPrompt(input)
    const second = await buildRuntimeEnhancedPrompt({
      ...input, mode: 'plan', toolContext: { workspaceId: 'two', projectId: 'project-two' } as ToolContext,
    })
    expect(first).toBe(second)
    expect(first).not.toContain('project-one')
    expect(first).not.toContain('Current Date')
  })
  it('preserves project instruction discovery and explains the context protocol', async () => {
    const prompt = await buildRuntimeEnhancedPrompt(input)
    expect(prompt).toContain('BASE_PROMPT')
    expect(prompt).toContain('BEFORE modifying files under a root')
    expect(prompt).toContain('runtime_context_update')
    expect(prompt).toContain('Removed entries are no longer available')
    expect(prompt).toContain('read_skill')
  })
})
