import { describe, expect, it } from 'vitest'
import { buildSubagentSystemPrompt } from '@/agent/subagent/role-prompts'

describe('subagent system prompt composition', () => {
  it('leaves the base prompt untouched when nothing is appended', () => {
    expect(buildSubagentSystemPrompt('BASE', 'general-purpose')).toBe('BASE')
  })

  it('appends the type suffix when no role is given', () => {
    const prompt = buildSubagentSystemPrompt('BASE', 'explorer')
    expect(prompt.startsWith('BASE\n\n')).toBe(true)
    expect(prompt).toContain('Role: Explorer')
  })

  it('places an inline role between the base prompt and the type suffix', () => {
    const prompt = buildSubagentSystemPrompt('BASE', 'explorer', { role: '验证者：只跑命令、只报结果' })
    const roleAt = prompt.indexOf('Assigned role')
    expect(roleAt).toBeGreaterThan(prompt.indexOf('BASE'))
    expect(roleAt).toBeLessThan(prompt.indexOf('Role: Explorer'))
    expect(prompt).toContain('验证者：只跑命令、只报结果')
  })

  it('does not leak the actor id into the prompt', () => {
    // Identity travels through context sources so the persona files stay the
    // single source of truth; the prompt only carries the inline role.
    expect(buildSubagentSystemPrompt('BASE', 'general-purpose', { actorId: 'gatekeeper' })).toBe('BASE')
  })

  it('ignores a whitespace-only role', () => {
    expect(buildSubagentSystemPrompt('BASE', 'general-purpose', { role: '   ' })).toBe('BASE')
  })
})
