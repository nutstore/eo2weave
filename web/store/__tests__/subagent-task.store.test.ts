import { beforeEach, describe, expect, it } from 'vitest'
import { isBackgroundSubagentVisible, selectBackgroundSubagentCount, useSubagentTaskStore, type SubagentTaskProjection } from '../subagent-task.store'
const task = (extra: Partial<SubagentTaskProjection> = {}): SubagentTaskProjection => ({ agentId: 'child', conversationId: 'original', description: 'Inspect', role: 'worker', status: 'completed', createdAt: 1, updatedAt: 2, lastActivity: 2, isAsync: true, executionId: 'first', messages: [], ...extra })
beforeEach(() => useSubagentTaskStore.setState({ tasks: {} }))
describe('background task projection', () => {
  it('keeps delivery work and unsuccessful child results visible independently', () => {
    for (const deliveryPhase of ['pending', 'delivered', 'processing', 'blocked', 'error'] as const)
      expect(isBackgroundSubagentVisible(task({ deliveryPhase }))).toBe(true)
    expect(isBackgroundSubagentVisible(task({ deliveryPhase: 'handled' }))).toBe(false)
    expect(isBackgroundSubagentVisible(task({ status: 'failed', deliveryPhase: 'handled' }))).toBe(true)
    expect(isBackgroundSubagentVisible(task({ status: 'killed', deliveryPhase: 'suppressed' }))).toBe(true)
    expect(isBackgroundSubagentVisible(task({ isAsync: false }))).toBe(false)
  })
  it('keeps acknowledgement scoped to its execution through publication and route-independent counts', () => {
    const store = useSubagentTaskStore.getState()
    store.publish(task({ status: 'failed' }))
    store.acknowledge('child', 'first')
    store.publish(task({ status: 'failed', deliveryPhase: 'handled' }))
    expect(selectBackgroundSubagentCount('original')(useSubagentTaskStore.getState())).toBe(0)
    store.publish(task({ status: 'running', executionId: 'second' }))
    store.acknowledge('child', 'first')
    expect(selectBackgroundSubagentCount('original')(useSubagentTaskStore.getState())).toBe(1)
    expect(selectBackgroundSubagentCount('other')(useSubagentTaskStore.getState())).toBe(0)
  })
})
