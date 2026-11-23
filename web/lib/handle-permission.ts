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

    const settle = (value: DeadlineResult<T>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }

    // Armed only once both closures exist. They run strictly after this line —
    // from the timer callback or from `task()` below — so the binding is always
    // initialized when they read it.
    const timer = setTimeout(() => settle('timeout'), timeoutMs)

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

/** `isSameEntry` with a deadline; used when the "other" handle may be dead. */
export function isSameEntryWithDeadline(
  handle: FileSystemDirectoryHandle,
  other: FileSystemDirectoryHandle,
  timeoutMs: number = PERMISSION_QUERY_DEADLINE_MS
): Promise<DeadlineResult<boolean>> {
  return withDeadline(() => handle.isSameEntry(other), timeoutMs)
}

/**
 * What can be learned about a handle whose permission call never answered.
 *
 * `queryPermission`/`requestPermission` hanging says nothing about *why*: the
 * directory may be gone, the volume may be unmounted, another tab may hold the
 * same tree, or only the permission entry may be missing. Iterating one entry
 * separates those cases — a directory that still answers `keys()` exists and is
 * readable, so the stall is permissions-only; a handle that throws
 * `NotFoundError`/`NotReadableError` is genuinely dead. Field reports are the
 * only place this distinction is visible, so the result is logged, not thrown.
 */
export interface HandleDiagnosis {
  name: string
  readable: boolean
  firstEntry: string | null
  error: string | null
}

export async function describeHandle(
  handle: FileSystemDirectoryHandle,
  timeoutMs = 1500
): Promise<HandleDiagnosis> {
  const name = typeof handle?.name === 'string' ? handle.name : '<unnamed>'

  try {
    // `keys()` is missing from some TS DOM libs; the shape is the standard
    // async iterator from the File System Access spec.
    const iterable = handle as unknown as {
      keys(): AsyncIterableIterator<string>
    }
    const first = await withDeadline(async () => {
      for await (const key of iterable.keys()) return String(key)
      return null
    }, timeoutMs)

    if (first === 'timeout') {
      return { name, readable: false, firstEntry: null, error: 'keys() timed out' }
    }
    return { name, readable: true, firstEntry: first, error: null }
  } catch (error) {
    return {
      name,
      readable: false,
      firstEntry: null,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
  }
}
