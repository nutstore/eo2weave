import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamingQueue } from '../streaming-queue'

describe('StreamingQueue', () => {
  let rafCallbacks: FrameRequestCallback[]
  let nextRafId: number
  let cancelledRafIds: number[]
  let watchdogCallbacks: Array<() => void>
  let setTimeoutMock: ReturnType<typeof vi.fn>
  let clearTimeoutMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    rafCallbacks = []
    nextRafId = 1
    cancelledRafIds = []
    watchdogCallbacks = []

    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback)
        return nextRafId++
      }),
    )

    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        cancelledRafIds.push(id)
      }),
    )

    // Capture watchdog timers (fixed fake id 777) instead of scheduling real ones
    setTimeoutMock = vi.fn((callback: () => void) => {
      watchdogCallbacks.push(callback)
      return 777 as unknown as ReturnType<typeof setTimeout>
    })
    clearTimeoutMock = vi.fn()
    vi.stubGlobal('setTimeout', setTimeoutMock)
    vi.stubGlobal('clearTimeout', clearTimeoutMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('queues items and flushNow delivers accumulated content', () => {
    const callback = vi.fn()
    const queue = new StreamingQueue(callback)

    queue.add('message-1', 'Hel')
    queue.add('message-1', 'lo')
    queue.flushNow()

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('message-1', 'Hello')
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
    expect(cancelledRafIds).toEqual([1])
  })

  it('batches multiple keys before a flush', () => {
    const callback = vi.fn()
    const queue = new StreamingQueue(callback)

    queue.add('first', 'A')
    queue.add('second', 'B')
    queue.add('first', 'C')

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)

    queue.flushNow()

    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback).toHaveBeenNthCalledWith(1, 'first', 'AC')
    expect(callback).toHaveBeenNthCalledWith(2, 'second', 'B')
  })

  it('flushNow is a no-op when the queue is empty', () => {
    const callback = vi.fn()
    const queue = new StreamingQueue(callback)

    queue.flushNow()

    expect(callback).not.toHaveBeenCalled()
    expect(cancelAnimationFrame).not.toHaveBeenCalled()
  })

  it('flushes from the scheduled requestAnimationFrame callback', () => {
    const callback = vi.fn()
    const queue = new StreamingQueue(callback)

    queue.add('message-1', 'Hi')

    expect(callback).not.toHaveBeenCalled()
    expect(rafCallbacks).toHaveLength(1)

    rafCallbacks[0](16)

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith('message-1', 'Hi')
  })

  it('destroy cancels pending work and ignores future adds', () => {
    const callback = vi.fn()
    const queue = new StreamingQueue(callback)

    queue.add('message-1', 'pending')
    queue.destroy()
    queue.add('message-1', 'ignored')
    queue.flushNow()

    expect(callback).not.toHaveBeenCalled()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
  })

  it('schedules a watchdog timer alongside the RAF', () => {
    const callback = vi.fn()
    const queue = new StreamingQueue(callback)

    queue.add('message-1', 'Hi')

    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 100)
  })

  it('watchdog timer flushes the buffer when RAF never fires (hidden tab)', () => {
    const callback = vi.fn()
    const queue = new StreamingQueue(callback)

    queue.add('message-1', 'Hi')
    expect(callback).not.toHaveBeenCalled()

    // RAF never fires — the watchdog flushes instead
    watchdogCallbacks[0]()

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith('message-1', 'Hi')
    // The still-pending RAF is cancelled so it won't fire against an empty buffer
    expect(cancelledRafIds).toEqual([1])
  })

  it('watchdog timer is cancelled when RAF flushes first', () => {
    const callback = vi.fn()
    const queue = new StreamingQueue(callback)

    queue.add('message-1', 'Hi')
    rafCallbacks[0](16)

    expect(callback).toHaveBeenCalledOnce()
    expect(clearTimeoutMock).toHaveBeenCalledWith(777)
    expect(cancelledRafIds).toEqual([])
  })
})
