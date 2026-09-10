/**
 * Streaming Queue - Batch process streaming updates using RAF to avoid UI lag
 * from frequent store updates.
 *
 * Core concepts:
 * 1. Decouple network streaming (high frequency) from visual updates (60fps)
 * 2. Accumulate deltas in a buffer, update in RAF callback batches
 * 3. Update state once per frame instead of once per delta
 *
 * Reference: Upstash - Smooth Text Streaming
 * https://upstash.com/blog/smooth-streaming
 */

type UpdateCallback = (key: string, accumulated: string) => void

export class StreamingQueue {
  private buffer = new Map<string, string>()
  private rafId: number | null = null
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null
  private callback: UpdateCallback
  private isScheduled = false
  private destroyed = false

  /**
   * Watchdog interval (ms). requestAnimationFrame is throttled to zero when
   * the tab is hidden and can starve when the main thread is busy, which
   * would leave buffered stream deltas unflushed for the whole duration of
   * the stream. A plain timer guarantees a max flush latency even when rAF
   * is not firing.
   */
  private static readonly WATCHDOG_MS = 100

  constructor(callback: UpdateCallback) {
    this.callback = callback
  }

  /**
   * Add delta to buffer
   * Does not update immediately, waits for next RAF callback
   * Silently ignores adds after destroy() is called
   */
  add(key: string, delta: string): void {
    if (this.destroyed) return

    const current = this.buffer.get(key) || ''
    this.buffer.set(key, current + delta)

    // Only schedule once — RAF preferred, timer as fallback
    if (!this.isScheduled) {
      this.isScheduled = true
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null
        this.flush()
      })
      // Watchdog: if the RAF callback never runs (hidden tab, blocked main
      // thread), this timer flushes the buffer anyway.
      this.watchdogTimer = setTimeout(() => {
        this.flush()
      }, StreamingQueue.WATCHDOG_MS)
    }
  }

  /**
   * Flush buffer and pass accumulated content to callback
   * Scheduled by RAF, synchronized with browser refresh rate
   */
  private flush(): void {
    this.isScheduled = false
    // Whichever path won (RAF or watchdog), cancel the other pending one so
    // no stale callback fires later against an empty buffer.
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
    }

    if (this.destroyed || this.buffer.size === 0) {
      return
    }

    // Process all accumulated content in batch
    for (const [key, value] of this.buffer) {
      this.callback(key, value)
    }

    this.buffer.clear()
  }

  /**
   * Immediately flush buffer (used when stream ends to ensure all content is updated)
   */
  flushNow(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
    }
    this.isScheduled = false
    this.flush()
  }

  /**
   * Cleanup resources
   * Prevents any further callbacks or updates
   */
  destroy(): void {
    this.destroyed = true
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
    }
    this.buffer.clear()
    this.isScheduled = false
  }
}
