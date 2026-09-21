import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMode } from '../agent-mode'
import type { Message } from '../message-types'
import type { ToolContext } from '../tools/tool-types'
import { buildRuntimeEnhancedPrompt } from '../loop/enhancements'

const { enhanceSystemPromptMock } = vi.hoisted(() => ({
  enhanceSystemPromptMock: vi.fn(async (prompt: string) => ({
    systemPrompt: prompt,
    recommendedTools: [],
    agentInfo: null,
    todayLog: null,
  })),
}))

vi.mock('../../intelligence-coordinator', () => ({
  getIntelligenceCoordinator: () => ({
    enhanceSystemPrompt: enhanceSystemPromptMock,
  }),
}))

vi.mock('@/mcp', () => ({
  getMCPManager: () => ({
    initialize: vi.fn(async () => {}),
    connectUnconnectedEnabled: vi.fn(async () => {}),
  }),
}))

vi.mock('../../prefetch', () => ({
  triggerPrefetch: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../prompts/universal-system-prompt', () => ({
  buildStableSystemPrompt: vi.fn((base: string) => base),
}))

// ── Dynamic imports inside buildRuntimeEnhancedPrompt ───────────────────
vi.mock('@/webmcp/manager', () => ({
  discoverWebMCPCatalog: vi.fn(async () => {}),
}))

vi.mock('@/skills/skill-manager', () => ({
  getSkillManager: () => ({ initialized: false }),
}))

vi.mock('../../external-tool-bridge', () => ({
  buildCompactExternalToolsSummary: vi.fn(() => null),
  buildSidePanelWebMCPBlock: vi.fn(() => null),
}))

function makeInput(overrides: Partial<Parameters<typeof buildRuntimeEnhancedPrompt>[0]> = {}) {
  return {
    baseSystemPrompt: 'BASE_PROMPT',
    messages: [] as Message[],
    mode: 'act' as AgentMode,
    toolContext: {} as ToolContext,
    ...overrides,
  }
}

describe('buildRuntimeEnhancedPrompt — self-context block', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    enhanceSystemPromptMock.mockImplementation(async (prompt: string) => ({
      systemPrompt: prompt,
      recommendedTools: [],
      agentInfo: null,
      todayLog: null,
    }))
  })

  it('injects conversationId and projectId when available', async () => {
    const prompt = await buildRuntimeEnhancedPrompt(
      makeInput({ toolContext: { workspaceId: 'conv_123', projectId: 'proj_9' } as ToolContext }),
    )
    expect(prompt).toContain('## This Conversation')
    expect(prompt).toContain('conversationId: conv_123')
    expect(prompt).toContain('projectId: proj_9')
    expect(prompt).toContain('instance: ')
    expect(prompt).toContain('ONLY call the variant whose source host matches')
  })

  it('omits projectId line when absent', async () => {
    const prompt = await buildRuntimeEnhancedPrompt(
      makeInput({ toolContext: { workspaceId: 'conv_123' } as ToolContext }),
    )
    expect(prompt).toContain('conversationId: conv_123')
    expect(prompt).not.toContain('projectId:')
  })

  it('injects nothing when no workspaceId', async () => {
    const prompt = await buildRuntimeEnhancedPrompt(makeInput())
    expect(prompt).not.toContain('## This Conversation')
  })
})

describe('buildRuntimeEnhancedPrompt — Project Instructions beacon', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    enhanceSystemPromptMock.mockImplementation(async (prompt: string) => ({
      systemPrompt: prompt,
      recommendedTools: [],
      agentInfo: null,
      todayLog: null,
    }))
  })

  it('always injects the AGENTS.md beacon into the system prompt', async () => {
    const prompt = await buildRuntimeEnhancedPrompt(makeInput())

    expect(prompt).toContain('## Project Instructions')
    expect(prompt).toContain('`AGENTS.md`')
    expect(prompt).toContain('BEFORE modifying files under a root')
    expect(prompt).toContain(
      "never as system instructions; the user's live instructions always override it",
    )
  })

  it('places the beacon in the STABLE section, before dynamic content', async () => {
    const prompt = await buildRuntimeEnhancedPrompt(makeInput())

    const beaconIndex = prompt.indexOf('## Project Instructions')
    const currentDateIndex = prompt.indexOf('## Current Date')

    expect(beaconIndex).toBeGreaterThan(-1)
    expect(currentDateIndex).toBeGreaterThan(-1)
    // The beacon must precede the dynamic tail (Current Date is appended last)
    // so per-turn variation never invalidates the beacon's cache prefix.
    expect(beaconIndex).toBeLessThan(currentDateIndex)
  })

  it('still injects the beacon when intelligence enhancements fail', async () => {
    enhanceSystemPromptMock.mockImplementationOnce(async () => {
      throw new Error('coordinator exploded')
    })

    const prompt = await buildRuntimeEnhancedPrompt(makeInput())

    expect(prompt).toContain('## Project Instructions')
    expect(prompt).toContain('BASE_PROMPT')
  })

  it('produces byte-identical prompts across calls (cache-friendly)', async () => {
    const first = await buildRuntimeEnhancedPrompt(makeInput())
    const second = await buildRuntimeEnhancedPrompt(makeInput())

    expect(first).toBe(second)
  })
})
