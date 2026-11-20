import { afterEach, describe, expect, it, vi } from 'vitest'
import {
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

  it('propagates a rejection instead of reporting a timeout', async () => {
    const boom = new DOMException('The request is not allowed', 'SecurityError')
    const handle = {
      requestPermission: vi.fn().mockRejectedValue(boom),
    } as unknown as FileSystemDirectoryHandle

    await expect(requestPermissionWithDeadline(handle)).rejects.toBe(boom)
  })
})
