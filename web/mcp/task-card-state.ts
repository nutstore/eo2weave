import type { ManagedMCPTask } from './task-types'

export function isComposerTaskVisible(task: ManagedMCPTask): boolean {
  return (
    !!task.composer?.eligible &&
    !task.composer.dismissedAt &&
    !task.composer.sentMessageId &&
    !task.composer.queued &&
    task.observation !== 'submitting'
  )
}

export function getTaskCardState(task: ManagedMCPTask) {
  if (task.observation === 'submission_unknown') return 'submission_unknown'
  if (task.remoteStatus === 'failed' || task.resultIsError || task.result?.isError) return 'failed'
  if (task.remoteStatus === 'cancelled') return 'cancelled'
  // Settled tasks also stop observation, so keep their results ready over pause.
  if (task.remoteStatus === 'completed' && task.settledAt && (task.result || task.resultAssetId))
    return 'ready'
  if (task.observation === 'paused') return 'paused'
  if (task.remoteStatus === 'completed') return 'preparing'
  if (task.remoteStatus === 'input_required' || task.observation === 'attention')
    return 'input_required'
  return 'working'
}
