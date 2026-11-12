import { describe, it, expect, vi } from 'vitest'
import type { SubagentCompletion } from '../async-types'
import { CompletionDeliveryCoordinator } from '../completion-delivery'
import type { Message } from '@/agent/message-types'
function fixture() {
  const rows = new Map<string, SubagentCompletion>()
  const history: Message[] = [{ id: 'human', role: 'user', content: 'Original task', timestamp: 1 }]
  let busy = false,
    exists = true
  let beforeAppend: (() => void) | undefined
  const transition = async (id: string, status: SubagentCompletion['status']) => {
    rows.get(id)!.status = status
    return true
  }
  const repository = {
    listRecoverable: async () =>
      [...rows.values()].filter((r) =>
        ['pending', 'delivered', 'blocked', 'error'].includes(r.status)
      ),
    listProcessing: async () => [...rows.values()].filter((r) => r.status === 'processing'),
    reserveDelivery: async (ids: string[], messageId: string) =>
      ids.map((id) =>
        Object.assign(rows.get(id)!, { notificationMessageId: messageId, deliveryReserved: true })
      ),
    markDelivered: async (id: string) => transition(id, 'delivered'),
    claim: async (id: string, runId: string) => {
      const r = rows.get(id)!
      if (r.status !== 'delivered') return false
      r.status = 'processing'
      r.parentRunId = runId
      return true
    },
    markHandled: async (id: string, runId?: string) => {
      const r = rows.get(id)!
      if (r.status !== 'processing' || r.parentRunId !== runId) return false
      return transition(id, 'handled')
    },
    markBlocked: async (id: string) => transition(id, 'blocked'),
    markError: async (id: string) => transition(id, 'error'),
    suppress: async (id: string) => transition(id, 'suppressed'),
  }
  const dispatch = vi.fn(
    async (_id: string, _origin: NonNullable<SubagentCompletion['continuation']>) => {}
  )
  const onPhase = vi.fn()
  const coordinator = new CompletionDeliveryCoordinator({
    repository,
    isBusy: () => busy,
    validateOrigin: async () => exists,
    appendNotification: async (_id, message, eligible) => {
      beforeAppend?.()
      if (!eligible()) return false
      if (!history.some((m) => m.id === message.id)) history.push(message)
      return true
    },
    dispatch,
    withLock: async (_key, fn) => fn(),
    onPhase,
    onError: vi.fn(),
  })
  const add = (id: string, overrides: Partial<SubagentCompletion> = {}) => {
    const r: SubagentCompletion = {
      id,
      agentId: id,
      executionId: 'attempt',
      conversationId: 'conv',
      notificationMessageId: `default-${id}`,
      status: 'pending',
      taskStatus: 'completed',
      description: 'Research',
      result: `Result ${id}`,
      messages: [],
      changedPaths: ['draft.md'],
      continuation: {
        parentRunId: 'origin',
        providerType: 'openai',
        modelName: 'original-model',
        maxTokens: 100,
      },
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    }
    rows.set(id, r)
    return r
  }
  return {
    coordinator,
    onPhase,
    add,
    rows,
    history,
    dispatch,
    busy: (v: boolean) => {
      busy = v
    },
    missing: () => {
      exists = false
    },
    beforeAppend: (fn: () => void) => {
      beforeAppend = fn
    },
  }
}
describe('durable completion delivery', () => {
  it('coalesces completions into one persisted notification using the original model', async () => {
    const f = fixture()
    f.add('one')
    f.add('two')
    f.coordinator.schedule('conv')
    f.coordinator.schedule('conv')
    await f.coordinator.flush('conv')
    expect(f.history).toHaveLength(2)
    expect(f.history[1].subagentCompletion?.eventIds).toEqual(['one', 'two'])
    expect(f.history[1].content).toContain('draft.md')
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.dispatch.mock.calls[0][1].modelName).toBe('original-model')
  })
  it('parks behind busy parent and user queue work', async () => {
    const f = fixture()
    f.add('one')
    f.busy(true)
    await f.coordinator.flush('conv')
    expect(f.history).toHaveLength(1)
    f.busy(false)
    await f.coordinator.flush('conv')
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  })
  it('never infers success from queued or internally caught dispatch resolution; binds actual run only', async () => {
    const f = fixture()
    f.add('one')
    await f.coordinator.flush('conv')
    await f.coordinator.flush('conv')
    expect(f.rows.get('one')!.status).toBe('delivered')
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    await f.coordinator.claimRun('conv', 'actual', f.history)
    expect(f.rows.get('one')!.status).toBe('processing')
    await f.coordinator.finishRun('conv', 'stale', 'success')
    expect(f.rows.get('one')!.status).toBe('processing')
    await f.coordinator.finishRun('conv', 'actual', 'success')
    expect(f.rows.get('one')!.status).toBe('handled')
  })
  it('recovers reservation and receipt crash windows without duplicate history or regrouping', async () => {
    const f = fixture()
    f.add('one', { deliveryReserved: true, notificationMessageId: 'reserved' })
    f.add('two')
    f.history.push({
      id: 'reserved',
      role: 'user',
      content: 'Accepted',
      timestamp: 2,
      subagentCompletion: { eventIds: ['one'] },
    })
    await f.coordinator.flush('conv')
    expect(f.history[1].id).toBe('reserved')
    expect(f.history[1].subagentCompletion?.eventIds).toEqual(['one'])
    expect(f.history.filter((m) => m.id === 'reserved')).toHaveLength(1)
    const g = fixture()
    g.add('one', { status: 'delivered', deliveryReserved: true, notificationMessageId: 'reserved' })
    await g.coordinator.flush('conv')
    expect(g.dispatch).toHaveBeenCalledTimes(1)
  })
  it('stop during awaits, consumption, and deletion prevent wake', async () => {
    const f = fixture()
    f.add('one')
    f.beforeAppend(() => f.coordinator.stop('conv'))
    await f.coordinator.flush('conv')
    expect(f.history).toHaveLength(1)
    expect(f.dispatch).not.toHaveBeenCalled()
    const g = fixture()
    g.add('one', { status: 'consumed' })
    await g.coordinator.flush('conv')
    expect(g.dispatch).not.toHaveBeenCalled()
    g.add('two')
    g.missing()
    await g.coordinator.flush('conv')
    expect(g.dispatch).not.toHaveBeenCalled()
  })
  it('does not dispatch or accept after history persistence fails', async () => {
    const f = fixture()
    f.add('one')
    f.beforeAppend(() => {
      throw new Error('Disk unavailable')
    })
    await f.coordinator.flush('conv')
    await f.coordinator.flush('conv')
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.rows.get('one')!.status).toBe('error')
  })
  it('a completion parked during an active flush drains after its owning run exits', async () => {
    const f = fixture()
    f.add('one')
    f.dispatch.mockImplementationOnce(async () => {
      await f.coordinator.claimRun('conv', 'actual', f.history)
      f.add('two')
      f.coordinator.schedule('conv')
      await f.coordinator.finishRun('conv', 'actual', 'success')
    })
    await f.coordinator.flush('conv')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(f.dispatch).toHaveBeenCalledTimes(2)
  })
  it('a new actual manual run rearms future child completions while old events stay suppressed', async () => {
    const f = fixture()
    f.add('old')
    f.coordinator.stop('conv')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(f.rows.get('old')!.status).toBe('suppressed')
    await f.coordinator.activate('conv')
    f.add('new')
    await f.coordinator.flush('conv')
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.history[1].subagentCompletion?.eventIds).toEqual(['new'])
  })
  it('automatic owning runs leave prior failed notifications for manual retry', async () => {
    const f = fixture()
    f.add('one', { status: 'error', notificationMessageId: 'failed', deliveryReserved: true })
    f.history.push({
      id: 'failed',
      role: 'user',
      content: 'Prior failure',
      timestamp: 2,
      subagentCompletion: { eventIds: ['one'] },
    })
    await f.coordinator.claimRun('conv', 'automatic-run', f.history, false)
    expect(f.rows.get('one')!.status).toBe('error')
  })
  it.each(['history', 'dispatch'] as const)(
    'publishes the current %s failure in a new completion snapshot',
    async (failure) => {
      const f = fixture()
      const original = f.add('one', { deliveryError: 'Old diagnostic' })
      if (failure === 'history')
        f.beforeAppend(() => {
          throw new Error('Current history failure')
        })
      else f.dispatch.mockRejectedValueOnce(new Error('Current dispatch failure'))
      await f.coordinator.flush('conv')
      const phase = failure === 'history' ? 'error' : 'blocked'
      const [published, publishedPhase] = f.onPhase.mock.calls.at(-1)!
      expect(publishedPhase).toBe(phase)
      expect(published).toMatchObject({
        status: phase,
        deliveryError: `Error: Current ${failure} failure`,
      })
      expect(published).not.toBe(original)
      expect(original.deliveryError).toBe('Old diagnostic')
    }
  )
  it('clears old explanations as a recovered delivery progresses', async () => {
    const f = fixture()
    const original = f.add('one', {
      status: 'error',
      deliveryReserved: true,
      deliveryError: 'Old diagnostic',
    })
    await f.coordinator.retry('conv')
    const [delivered, deliveredPhase] = f.onPhase.mock.calls.at(-1)!
    expect(deliveredPhase).toBe('delivered')
    expect(delivered.status).toBe('delivered')
    expect(delivered.deliveryError).toBeUndefined()
    await f.coordinator.claimRun('conv', 'actual', f.history)
    const [processing] = f.onPhase.mock.calls.at(-1)!
    expect(processing.status).toBe('processing')
    expect(processing.deliveryError).toBeUndefined()
    await f.coordinator.finishRun('conv', 'actual', 'success')
    const [handled, handledPhase] = f.onPhase.mock.calls.at(-1)!
    expect(handledPhase).toBe('handled')
    expect(handled.status).toBe('handled')
    expect(handled.deliveryError).toBeUndefined()
    expect(handled).not.toBe(original)
    expect(original.deliveryError).toBe('Old diagnostic')
  })
  it('publishes a new owning-run failure instead of the pre-retry diagnostic', async () => {
    const f = fixture()
    const original = f.add('one', {
      status: 'error',
      deliveryReserved: true,
      deliveryError: 'Old diagnostic',
    })
    await f.coordinator.retry('conv')
    await f.coordinator.claimRun('conv', 'actual', f.history)
    await f.coordinator.finishRun('conv', 'actual', 'error', 'Current model failure')
    const [failed, failedPhase] = f.onPhase.mock.calls.at(-1)!
    expect(failedPhase).toBe('error')
    expect(failed).toMatchObject({ status: 'error', deliveryError: 'Current model failure' })
    expect(failed).not.toBe(original)
    expect(original.deliveryError).toBe('Old diagnostic')
  })
  it('provider failure and interrupted processing require explicit retry', async () => {
    const f = fixture()
    f.add('one')
    await f.coordinator.flush('conv')
    await f.coordinator.claimRun('conv', 'actual', f.history)
    await f.coordinator.finishRun('conv', 'actual', 'error', 'Provider failed')
    await f.coordinator.flush('conv')
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.rows.get('one')!.status).toBe('error')
    await f.coordinator.retry('conv')
    expect(f.dispatch).toHaveBeenCalledTimes(2)
    expect(f.history).toHaveLength(2)
    await f.coordinator.claimRun('conv', 'manual', f.history)
    await f.coordinator.recover('conv')
    expect(f.rows.get('one')!.status).toBe('error')
    expect(f.dispatch).toHaveBeenCalledTimes(2)
  })
})
