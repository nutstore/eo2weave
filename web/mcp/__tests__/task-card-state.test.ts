import { describe, expect, it } from 'vitest'
import { getTaskCardState, isComposerTaskVisible } from '../task-card-state'
import type { ManagedMCPTask } from '../task-types'

function task(overrides: Partial<ManagedMCPTask> = {}): ManagedMCPTask {
  return {
    id: 'task-1',
    serverId: 'server',
    endpointId: 'endpoint',
    context: { projectId: 'project', conversationId: 'conversation' },
    toolName: 'tool',
    observation: 'observing',
    createdAt: 1,
    updatedAt: 2,
    cancellationSupported: true,
    ...overrides,
  }
}

describe('getTaskCardState', () => {
  it('keeps submission_unknown ahead of every terminal status', () => {
    // A task whose submit outcome is unknown may already have been submitted:
    // showing it as failed would invite a duplicate submission.
    expect(
      getTaskCardState(task({ observation: 'submission_unknown', remoteStatus: 'failed' }))
    ).toBe('submission_unknown')
    expect(
      getTaskCardState(task({ observation: 'submission_unknown', remoteStatus: 'completed' }))
    ).toBe('submission_unknown')
  })

  it('reports failed for a failed remote status or an error result', () => {
    expect(getTaskCardState(task({ remoteStatus: 'failed' }))).toBe('failed')
    // A server can return an error result while the task status stays completed.
    expect(getTaskCardState(task({ remoteStatus: 'completed', resultIsError: true }))).toBe('failed')
    expect(
      getTaskCardState(
        task({
          remoteStatus: 'completed',
          result: { isError: true, content: [] } as ManagedMCPTask['result'],
        })
      )
    ).toBe('failed')
  })

  it('reports cancelled for a cancelled remote status', () => {
    expect(getTaskCardState(task({ remoteStatus: 'cancelled' }))).toBe('cancelled')
  })

  it('prefers ready over paused once a settled result exists', () => {
    // Paused observation outlives completion: a task paused mid-run and then
    // finished must show its result instead of staying paused forever.
    expect(
      getTaskCardState(
        task({
          observation: 'paused',
          remoteStatus: 'completed',
          settledAt: 10,
          result: { content: [] } as ManagedMCPTask['result'],
        })
      )
    ).toBe('ready')
    expect(
      getTaskCardState(task({ remoteStatus: 'completed', settledAt: 10, resultAssetId: 'asset-1' }))
    ).toBe('ready')
  })

  it('reports preparing for a completed task whose result is not settled yet', () => {
    expect(getTaskCardState(task({ remoteStatus: 'completed' }))).toBe('preparing')
  })

  it('reports paused for a paused non-terminal task', () => {
    expect(getTaskCardState(task({ observation: 'paused' }))).toBe('paused')
  })

  it('reports input_required for input_required status or attention observation', () => {
    expect(getTaskCardState(task({ remoteStatus: 'input_required' }))).toBe('input_required')
    expect(getTaskCardState(task({ observation: 'attention' }))).toBe('input_required')
  })

  it('falls back to working while the task is still running', () => {
    expect(getTaskCardState(task({ remoteStatus: 'working' }))).toBe('working')
  })
})

describe('isComposerTaskVisible', () => {
  it('shows an eligible task that is neither dismissed, sent nor queued', () => {
    expect(isComposerTaskVisible(task({ composer: { eligible: true } }))).toBe(true)
  })

  it('hides a task that is not eligible for the composer', () => {
    expect(isComposerTaskVisible(task())).toBe(false)
    expect(isComposerTaskVisible(task({ composer: { eligible: false } }))).toBe(false)
  })

  it('hides a task once it was dismissed, sent or queued', () => {
    expect(isComposerTaskVisible(task({ composer: { eligible: true, dismissedAt: 1 } }))).toBe(false)
    expect(isComposerTaskVisible(task({ composer: { eligible: true, sentMessageId: 'm-1' } }))).toBe(
      false
    )
    expect(isComposerTaskVisible(task({ composer: { eligible: true, queued: true } }))).toBe(false)
  })

  it('hides a task while its submission is in flight', () => {
    expect(isComposerTaskVisible(task({ composer: { eligible: true }, observation: 'submitting' }))).toBe(
      false
    )
  })
})
