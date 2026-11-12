import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BackgroundSubagentTasks } from '../BackgroundSubagentTasks'
import { useSubagentTaskStore, selectBackgroundSubagentCount, type SubagentTaskProjection } from '@/store/subagent-task.store'

const fixtures = vi.hoisted(() => ({ stop: vi.fn(), stopAll: vi.fn(), acknowledge: vi.fn(), retry: vi.fn(), hasRuntime: true, savedAcknowledge: vi.fn(), stopPendingReturns: vi.fn() }))
vi.mock('@/i18n', () => ({ useT: () => (key: string, params?: Record<string, unknown>) => key + (params?.count === undefined ? '' : ` ${params.count}`) }))
vi.mock('@/agent/subagent/runtime', () => ({ peekSubagentRuntime: () => fixtures.hasRuntime ? ({ stop: fixtures.stop, stopAll: fixtures.stopAll, acknowledge: fixtures.acknowledge }) : undefined }))
vi.mock('@/sqlite/repositories/subagent.repository', () => ({ getSubagentRepository: () => ({ acknowledge: fixtures.savedAcknowledge }) }))
vi.mock('@/store/subagent-continuation', () => ({ retrySubagentContinuation: fixtures.retry, stopPendingSubagentReturns: fixtures.stopPendingReturns }))
vi.mock('../SubagentDetailPanel', () => ({ SubagentDetailPanel: ({ agentId }: { agentId: string }) => <div>trace:{agentId}</div> }))

function task(overrides: Partial<SubagentTaskProjection> = {}): SubagentTaskProjection {
  return { agentId: 'child', conversationId: 'original', description: 'Inspect documents', role: 'explorer', status: 'running', createdAt: 1, updatedAt: 1, lastActivity: 1, isAsync: true, executionId: 'attempt-1', messages: [], ...overrides }
}
beforeEach(() => { useSubagentTaskStore.setState({ tasks: {} }); vi.clearAllMocks(); fixtures.hasRuntime = true })

describe('BackgroundSubagentTasks', () => {
  it('tracks the original conversation independently of parent drafts and reveals only selected details', () => {
    useSubagentTaskStore.getState().publish(task())
    useSubagentTaskStore.getState().publish(task({ agentId: 'queued', status: 'pending', description: 'Review findings' }))
    useSubagentTaskStore.getState().publish(task({ agentId: 'other', conversationId: 'other' }))
    render(<BackgroundSubagentTasks conversationId="original" />)
    expect(screen.queryByText('Inspect documents')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /conversation.backgroundTasks.summary/ }))
    expect(screen.getByText('Inspect documents')).toBeInTheDocument()
    expect(screen.getByText('Review findings')).toBeInTheDocument()
    expect(screen.queryByText('trace:child')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: /conversation.backgroundTasks.details/ })[0])
    expect(screen.getByText('trace:child')).toBeInTheDocument()
    expect(screen.queryByText('trace:queued')).toBeNull()
    expect(selectBackgroundSubagentCount('original')(useSubagentTaskStore.getState())).toBe(2)
    act(() => useSubagentTaskStore.getState().publish(task({ status: 'completed', deliveryPhase: 'processing' })))
    expect(screen.getByText('conversation.backgroundTasks.processing')).toBeInTheDocument()
    act(() => useSubagentTaskStore.getState().setDeliveryPhase('child', 'attempt-1', 'handled'))
    expect(screen.queryByText('Inspect documents')).toBeNull()
  })

  it('stops only background work and retries delivery explicitly', async () => {
    useSubagentTaskStore.getState().publish(task())
    useSubagentTaskStore.getState().publish(task({ agentId: 'blocked', status: 'completed', deliveryPhase: 'blocked' }))
    render(<BackgroundSubagentTasks conversationId="original" />)
    fireEvent.click(screen.getByRole('button', { name: /conversation.backgroundTasks.summary/ }))
    fireEvent.click(screen.getByRole('button', { name: 'conversation.backgroundTasks.stopAll' }))
    await waitFor(() => expect(fixtures.stopAll).toHaveBeenCalledWith({ force: true, backgroundOnly: true }))
    fireEvent.click(screen.getByRole('button', { name: 'conversation.backgroundTasks.retry' }))
    await waitFor(() => expect(fixtures.retry).toHaveBeenCalledWith('original'))
  })

  it.each(['pending', 'delivered', 'blocked', 'error'] as const)('keeps stop-all available for terminal results awaiting %s return', async (deliveryPhase) => {
    useSubagentTaskStore.getState().publish(task({ status: 'completed', deliveryPhase }))
    render(<BackgroundSubagentTasks conversationId="original" />)
    fireEvent.click(screen.getByRole('button', { name: 'conversation.backgroundTasks.stopAll' }))
    await waitFor(() => expect(fixtures.stopAll).toHaveBeenCalledWith({ force: true, backgroundOnly: true }))
  })

  it.each([true, false])('stops one waiting return while preserving others with runtime=%s', async (hasRuntime) => {
    fixtures.hasRuntime = hasRuntime
    useSubagentTaskStore.getState().publish(task({ status: 'completed', deliveryPhase: 'pending' }))
    useSubagentTaskStore.getState().publish(task({ agentId: 'other-child', description: 'Other work', status: 'completed', deliveryPhase: 'pending' }))
    render(<BackgroundSubagentTasks conversationId="original" />)
    fireEvent.click(screen.getByRole('button', { name: /conversation.backgroundTasks.summary/ }))
    fireEvent.click(screen.getByRole('button', { name: 'conversation.backgroundTasks.stop: Inspect documents' }))
    if (hasRuntime) await waitFor(() => expect(fixtures.stop).toHaveBeenCalledWith({ agentId: 'child', force: true }))
    else await waitFor(() => expect(fixtures.stopPendingReturns).toHaveBeenCalledWith('original', { agentId: 'child', executionId: 'attempt-1' }))
    expect(fixtures.stopAll).not.toHaveBeenCalled()
    expect(useSubagentTaskStore.getState().tasks['other-child'].deliveryPhase).toBe('pending')
  })

  it('does not expose individual stop for processing or historical returns', () => {
    useSubagentTaskStore.getState().publish(task({ status: 'completed', deliveryPhase: 'processing' }))
    useSubagentTaskStore.getState().publish(task({ agentId: 'history', status: 'failed', deliveryPhase: 'handled' }))
    useSubagentTaskStore.getState().publish(task({ agentId: 'acknowledged', status: 'failed', deliveryPhase: 'pending', acknowledged: true }))
    render(<BackgroundSubagentTasks conversationId="original" />)
    fireEvent.click(screen.getByRole('button', { name: /conversation.backgroundTasks.summary/ }))
    expect(screen.queryByRole('button', { name: /^conversation.backgroundTasks.stop:/ })).toBeNull()
  })

  it('stops hydrated waiting results without constructing a runtime', async () => {
    fixtures.hasRuntime = false
    useSubagentTaskStore.getState().publish(task({ status: 'completed', deliveryPhase: 'pending' }))
    render(<BackgroundSubagentTasks conversationId="original" />)
    fireEvent.click(screen.getByRole('button', { name: 'conversation.backgroundTasks.stopAll' }))
    await waitFor(() => expect(fixtures.stopPendingReturns).toHaveBeenCalledWith('original'))
    expect(fixtures.stopAll).not.toHaveBeenCalled()
  })

  it('does not offer stop-all for historical failures or results already being processed', () => {
    useSubagentTaskStore.getState().publish(task({ status: 'failed', deliveryPhase: 'handled' }))
    useSubagentTaskStore.getState().publish(task({ agentId: 'processing', status: 'completed', deliveryPhase: 'processing' }))
    render(<BackgroundSubagentTasks conversationId="original" />)
    expect(screen.queryByRole('button', { name: 'conversation.backgroundTasks.stopAll' })).toBeNull()
  })

  it('acknowledges hydrated terminal tasks directly without constructing a runtime', async () => {
    fixtures.hasRuntime = false
    useSubagentTaskStore.getState().publish(task({ status: 'killed', deliveryPhase: 'suppressed' }))
    render(<BackgroundSubagentTasks conversationId="original" />)
    fireEvent.click(screen.getByRole('button', { name: /conversation.backgroundTasks.summary/ }))
    fireEvent.click(screen.getByRole('button', { name: 'conversation.backgroundTasks.acknowledge' }))
    await waitFor(() => expect(fixtures.savedAcknowledge).toHaveBeenCalledWith('original', 'child', 'attempt-1'))
    expect(fixtures.acknowledge).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('button', { name: /conversation.backgroundTasks.summary/ })).toBeNull())
  })

  it('keeps failed executions visible until acknowledged without hiding a new attempt', async () => {
    useSubagentTaskStore.getState().publish(task({ status: 'failed', deliveryPhase: 'handled', error: { code: 'FAILED', message: 'Read permission denied' } }))
    render(<BackgroundSubagentTasks conversationId="original" />)
    fireEvent.click(screen.getByRole('button', { name: /conversation.backgroundTasks.summary/ }))
    expect(screen.getByText('Read permission denied')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'conversation.backgroundTasks.acknowledge' }))
    await waitFor(() => expect(fixtures.acknowledge).toHaveBeenCalledWith({ agentId: 'child', executionId: 'attempt-1' }))
    act(() => useSubagentTaskStore.getState().acknowledge('child', 'attempt-1'))
    expect(screen.queryByText('Read permission denied')).toBeNull()
    act(() => useSubagentTaskStore.getState().publish(task({ executionId: 'attempt-2' })))
    expect(selectBackgroundSubagentCount('original')(useSubagentTaskStore.getState())).toBe(1)
  })
})
