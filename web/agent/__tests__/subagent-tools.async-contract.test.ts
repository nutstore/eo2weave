import { describe, expect, it } from 'vitest'
import { getBuiltinToolNames, getToolRegistry } from '../tool-registry'
import { getUniversalSystemPrompt } from '../prompts/universal-system-prompt'
import { RecommendationEngine } from '../tools/tool-recommendation'
import { batchSpawnDefinition, spawnSubagentDefinition, subagentPromptDoc } from '../tools/subagent.tool'
import { delegateToDefinition } from '../tools/delegate.tool'

describe('event-driven subagent tool surface', () => {
  it('offers asynchronous delegation and task controls without an explicit waiting tool', () => {
    const names = getBuiltinToolNames()
    expect(names).not.toContain('wait_subagents')
    expect(getToolRegistry().has('wait_subagents')).toBe(false)
    expect(names).toEqual(expect.arrayContaining([
      'spawn_subagent', 'batch_spawn', 'send_message_to_subagent', 'stop_subagent',
      'resume_subagent', 'get_subagent_status', 'list_subagents',
    ]))
  })

  it('never recommends the retired waiting tool', () => {
    const tools = Object.values(new RecommendationEngine().getAllTools()).flat()
    expect(tools.map((tool) => tool.toolName)).not.toContain('wait_subagents')
  })

  it('directs the model to automatic completion notifications instead of explicit waiting', () => {
    const descriptions = [
      getUniversalSystemPrompt(), subagentPromptDoc.lines.join('\n'),
      spawnSubagentDefinition.function.description, batchSpawnDefinition.function.description,
      delegateToDefinition.function.description,
    ]
    for (const description of descriptions) expect(description).not.toContain('wait_subagents')
    expect(spawnSubagentDefinition.function.description).toMatch(/completion.*notification/i)
    expect(batchSpawnDefinition.function.description).toMatch(/completion.*notification/i)
  })
})
