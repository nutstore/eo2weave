/**
 * Deadline-bound wrappers for the File System Access permission APIs.
 *
 * `queryPermission()` and `requestPermission()` are not cancellable and have no
 * timeout. Chromium can leave either of them pending forever on a stale or
 * unreachable persisted handle (issue #316: `queryPermission` froze project
 * activation; the re-authorization button then appeared dead because
 * `requestPermission` on the same handle never settled either).
 *
 * A pending permission *decision* is legitimate — the browser is waiting for the
 * user to click Allow — so the deadline here is generous and only exists to
 * convert "never answers" into something the UI can report.
 */

/** How long a permission probe may stay unanswered before it is reported. */
export const PERMISSION_QUERY_DEADLINE_MS = 2000

/**
 * How long a permission request may stay unanswered. Larger than the probe
 * because the browser is genuinely waiting for the user's decision.
 */
export const PERMISSION_REQUEST_DEADLINE_MS = 30000

export type DeadlineResult<T> = T | 'timeout'

function withDeadline<T>(
  task: () => Promise<T>,
  timeoutMs: number
): Promise<DeadlineResult<T>> {
  return new Promise<DeadlineResult<T>>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const settle = (value: DeadlineResult<T>) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(value)
    }

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      reject(error)
    }

    timer = setTimeout(() => settle('timeout'), timeoutMs)

    try {
      task().then(
        (value) => settle(value),
        (error) => fail(error)
      )
    } catch (error) {
      fail(error)
    }
  })
}

/** `queryPermission` with a deadline; rejections still propagate. */
export function queryPermissionWithDeadline(
  handle: FileSystemDirectoryHandle,
  timeoutMs: number = PERMISSION_QUERY_DEADLINE_MS
): Promise<DeadlineResult<PermissionState>> {
  return withDeadline(() => handle.queryPermission({ mode: 'readwrite' }), timeoutMs)
}

/** `requestPermission` with a deadline; rejections still propagate. */
export function requestPermissionWithDeadline(
  handle: FileSystemDirectoryHandle,
  timeoutMs: number = PERMISSION_REQUEST_DEADLINE_MS
): Promise<DeadlineResult<PermissionState>> {
  return withDeadline(() => handle.requestPermission({ mode: 'readwrite' }), timeoutMs)
}
