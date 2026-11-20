import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeHandle,
  isSameEntryWithDeadline,
  PERMISSION_QUERY_DEADLINE_MS,
  PERMISSION_REQUEST_DEADLINE_MS,
  queryPermissionWithDeadline,
  requestPermissionWithDeadline,
} from '@/lib/handle-permission'

/**
 * The File System Access permission calls are not cancellable and carry no
 * timeout: on a stale handle they can stay pending forever, which froze project
 * activation and then made the re-authorization button look inert (issue #316).
 * These pin that both wrappers turn "never answers" into a reportable state
 * without swallowing real answers or rejections.
 */
describe('handle permission deadlines', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes a real permission answer through', async () => {
    const handle = {
      queryPermission: vi.fn().mockResolvedValue('granted'),
      requestPermission: vi.fn().mockResolvedValue('prompt'),
    } as unknown as FileSystemDirectoryHandle

    await expect(queryPermissionWithDeadline(handle)).resolves.toBe('granted')
    await expect(requestPermissionWithDeadline(handle)).resolves.toBe('prompt')
    expect(PERMISSION_QUERY_DEADLINE_MS).toBeLessThan(PERMISSION_REQUEST_DEADLINE_MS)
  })

  it('reports an unanswered query instead of waiting forever', async () => {
    vi.useFakeTimers()
    const handle = {
      queryPermission: vi.fn(() => new Promise<PermissionState>(() => {})),
    } as unknown as FileSystemDirectoryHandle

    const result = queryPermissionWithDeadline(handle)
    await vi.advanceTimersByTimeAsync(PERMISSION_QUERY_DEADLINE_MS + 10)
    await expect(result).resolves.toBe('timeout')
  })

  it('gives a permission request the longer decision window', async () => {
    vi.useFakeTimers()
    const handle = {
      requestPermission: vi.fn(() => new Promise<PermissionState>(() => {})),
    } as unknown as FileSystemDirectoryHandle

    const result = requestPermissionWithDeadline(handle)

    // Still waiting inside the query deadline: a user is allowed to take their
    // time in the browser prompt.
    await vi.advanceTimersByTimeAsync(PERMISSION_QUERY_DEADLINE_MS + 10)
    let settled = false
    void result.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(PERMISSION_REQUEST_DEADLINE_MS)
    await expect(result).resolves.toBe('timeout')
  })

  it('tells a live directory from a dead handle when permission stalls', async () => {
    // Directory still answers `keys()`: the tree exists and is readable, so a
    // stalled permission call is a permissions-only problem, not a lost folder.
    const readable = {
      name: '鹅来面CSDN',
      keys: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: false, value: 'notes.md' }),
        }),
      }),
    } as unknown as FileSystemDirectoryHandle

    await expect(describeHandle(readable)).resolves.toEqual({
      name: '鹅来面CSDN',
      readable: true,
      firstEntry: 'notes.md',
      error: null,
    })

    // A handle whose directory disappeared rejects while iterating.
    const dead = {
      name: 'moved',
      keys: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new DOMException('A requested file or directory could not be found', 'NotFoundError')
          },
        }),
      }),
    } as unknown as FileSystemDirectoryHandle

    const diagnosis = await describeHandle(dead)
    expect(diagnosis.readable).toBe(false)
    expect(diagnosis.error).toContain('NotFoundError')
  })

  it('reports an unreadable directory whose iteration never answers', async () => {
    vi.useFakeTimers()
    const stuck = {
      name: 'stuck',
      keys: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      }),
    } as unknown as FileSystemDirectoryHandle

    const diagnosis = describeHandle(stuck, 1500)
    await vi.advanceTimersByTimeAsync(1600)
    await expect(diagnosis).resolves.toEqual({
      name: 'stuck',
      readable: false,
      firstEntry: null,
      error: 'keys() timed out',
    })
  })

  it('bounds isSameEntry when the other handle is dead', async () => {
    // The identity check in the re-pick flow compares against the *old*
    // handle, which is exactly the one that may never answer.
    const live = {
      isSameEntry: vi.fn(() => new Promise<boolean>(() => {})),
    } as unknown as FileSystemDirectoryHandle
    const other = {} as FileSystemDirectoryHandle

    vi.useFakeTimers()
    const pending = isSameEntryWithDeadline(live, other, 50)
    await vi.advanceTimersByTimeAsync(60)
    await expect(pending).resolves.toBe('timeout')

    const healthy = {
      isSameEntry: vi.fn().mockResolvedValue(true),
    } as unknown as FileSystemDirectoryHandle
    await expect(isSameEntryWithDeadline(healthy, other)).resolves.toBe(true)
  })

  it('propagates a rejection instead of reporting a timeout', async () => {
    const boom = new DOMException('The request is not allowed', 'SecurityError')
    const handle = {
      requestPermission: vi.fn().mockRejectedValue(boom),
    } as unknown as FileSystemDirectoryHandle

    await expect(requestPermissionWithDeadline(handle)).rejects.toBe(boom)
  })
})
