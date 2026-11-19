/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Test helper library
 *
 * Provides mock objects, test helpers, and more
 */

import { renderHook } from '@testing-library/react'
import { vi } from 'vitest'

// ============================================================================
// Mock object factories
// ============================================================================

/**
 * Create a fake FileSystemDirectoryHandle
 *
 * @example
 * const mockHandle = createMockDirHandle({
 *   'file.txt': { size: 1000, type: 'file' },
 *   'subdir': { size: 0, type: 'directory' }
 * })
 */
export function createMockDirHandle(
  entries: Record<string, { size: number; type: 'file' | 'directory' }>
): FileSystemDirectoryHandle {
  const mockHandle = {
    name: 'mock-directory',
    kind: 'directory' as const,
    entries: vi.fn(async function* () {
      for (const [name, info] of Object.entries(entries)) {
        if (info.type === 'file') {
          yield [name, createMockFileHandle(name, info.size)] as [string, FileSystemFileHandle]
        } else {
          yield [name, createMockDirHandle({})] as [string, FileSystemDirectoryHandle]
        }
      }
    }),
    getDirectoryHandle: vi.fn(async (name: string) => {
      const entry = entries[name]
      if (entry?.type === 'directory') {
        return createMockDirHandle({})
      }
      throw new DOMException('Not found', 'NotFoundError')
    }),
    getFileHandle: vi.fn(async (name: string) => {
      const entry = entries[name]
      if (entry?.type === 'file') {
        return createMockFileHandle(name, entry.size)
      }
      throw new DOMException('Not found', 'NotFoundError')
    }),
    queryPermission: vi.fn(async () => 'granted' as const),
    requestPermission: vi.fn(async () => 'granted' as const),
    isSameEntry: vi.fn(async () => false),
    removeEntry: vi.fn(async () => {}),
    resolve: vi.fn(async () => null),
  }

  return mockHandle as unknown as FileSystemDirectoryHandle
}

/**
 * Create a fake FileSystemFileHandle
 */
export function createMockFileHandle(
  name: string,
  size: number,
  content: string = ''
): FileSystemFileHandle {
  const mockFile = {
    name,
    kind: 'file' as const,
    getFile: vi.fn(async () => ({
      name,
      size,
      type: 'text/plain',
      lastModified: Date.now(),
      text: async () => content,
      arrayBuffer: async () => new ArrayBuffer(size),
      stream: async () => new ReadableStream(),
      slice: async () => null,
    })),
  }

  return mockFile as unknown as FileSystemFileHandle
}

/**
 * Create a fake Zustand store
 *
 * @example
 * const mockStore = createMockStore({ count: 0, name: 'test' })
 * mockStore.setState({ count: 1 })
 * mockStore.getState().count // 1
 */
export function createMockStore<T extends object>(initialState: T) {
  let state = initialState
  const listeners = new Set<() => void>()

  return {
    getState: () => state,
    setState: (partial: Partial<T> | ((state: T) => Partial<T>)) => {
      const newState =
        typeof partial === 'function' ? (partial as (state: T) => Partial<T>)(state) : partial
      state = { ...state, ...newState }
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    destroy: () => {
      listeners.clear()
    },
  }
}

/**
 * Create a fake Worker
 *
 * @example
 * const { worker, postMessage, on } = createMockWorker()
 * postMessage({ type: 'START' })
 * on('message', (data) => console.log(data))
 */
export function createMockWorker() {
  type WorkerHandler = (event: { data: unknown }) => void
  const handlers = new Map<string, WorkerHandler[]>()

  const worker = {
    postMessage: vi.fn((data: any) => {
      const messageHandlers = handlers.get('message')
      messageHandlers?.forEach((handler) => handler({ data }))
    }),
    terminate: vi.fn(),
    addEventListener: vi.fn((event: string, handler: WorkerHandler) => {
      if (!handlers.has(event)) {
        handlers.set(event, [])
      }
      handlers.get(event)!.push(handler)
    }),
    removeEventListener: vi.fn((event: string, handler: WorkerHandler) => {
      const eventHandlers = handlers.get(event)
      if (eventHandlers) {
        const index = eventHandlers.indexOf(handler)
        if (index > -1) {
          eventHandlers.splice(index, 1)
        }
      }
    }),
    dispatchEvent: vi.fn(),
    // Test helpers
    _emit: (event: string, data: any) => {
      const eventHandlers = handlers.get(event)
      eventHandlers?.forEach((handler) => handler({ data }))
    },
    _clearHandlers: () => {
      handlers.clear()
    },
  }

  return {
    worker,
    postMessage: worker.postMessage,
    on: (event: string, handler: WorkerHandler) => {
      worker.addEventListener(event, handler)
    },
    off: (event: string, handler: WorkerHandler) => {
      worker.removeEventListener(event, handler)
    },
    emit: worker._emit,
    clear: worker._clearHandlers,
  }
}

/**
 * Create a fake LLM Provider
 */
export function createMockLLMProvider() {
  return {
    chat: vi.fn(),
    streamChat: vi.fn(),
    maxContextTokens: 128000,
  }
}

/**
 * Create a fake ToolRegistry
 */
export function createMockToolRegistry() {
  const mockTools = new Map()

  return {
    getTool: vi.fn((name: string) => mockTools.get(name)),
    listTools: vi.fn(() => Array.from(mockTools.keys())),
    registerTool: vi.fn((name: string, tool: any) => {
      mockTools.set(name, tool)
    }),
    unregisterTool: vi.fn((name: string) => {
      mockTools.delete(name)
    }),
    hasTool: vi.fn((name: string) => mockTools.has(name)),
  }
}

/**
 * Create a fake ContextManager
 */
export function createMockContextManager() {
  return {
    buildContext: vi.fn(async () => ({ messages: [], tokens: 0 })),
    estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 3)),
    maxContextTokens: 128000,
    reserveTokens: 4096,
  }
}

// ============================================================================
// Async test helpers
// ============================================================================

/**
 * Wait until the condition holds
 *
 * @example
 * await waitFor(() => store.getState().count > 0)
 */
export async function waitFor(
  condition: () => boolean,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const { timeout = 5000, interval = 10 } = options
  const startTime = Date.now()

  while (!condition()) {
    if (Date.now() - startTime > timeout) {
      throw new Error(`Timeout waiting for condition after ${timeout}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

/**
 * Wait for an element to appear
 */
export async function waitForElement<T>(
  getter: () => T | null | undefined,
  options?: { timeout?: number }
): Promise<T> {
  const { timeout = 5000 } = options || {}
  const startTime = Date.now()

  while (Date.now() - startTime <= timeout) {
    const element = getter()
    if (element != null) {
      return element
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error(`Element not found after ${timeout}ms`)
}

/**
 * Wait for the given duration
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait for all pending promises to settle
 */
export async function waitForMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setImmediate(resolve))
}

// ============================================================================
// Store test helpers
// ============================================================================

/**
 * Render a store hook and return helper accessors
 *
 * @example
 * const { store, getState, setState } = renderStoreHook(() => useConversationStore())
 */
export function renderStoreHook<T>(hook: () => T) {
  const { result, rerender } = renderHook(hook)

  return {
    result,
    rerender,
    getState: () => {
      const state = result.current
      // Zustand store
      if (state && typeof state === 'object' && 'getState' in state) {
        return (state as any).getState()
      }
      return state
    },
    setState: (update: any) => {
      const state = result.current
      // Zustand store
      if (state && typeof state === 'object' && 'setState' in state) {
        (state as any).setState(update)
      }
    },
  }
}

/**
 * Reset the store state
 */
export function resetStore(store: any) {
  if (store && typeof store.setState === 'function') {
    store.setState({
      conversations: [],
      activeConversationId: null,
      loaded: true,
      // Adjust per concrete store
    })
  }
}

// ============================================================================
// Event test helpers
// ============================================================================

/**
 * Create a mock event
 */
export function createMockEvent<T extends Event = Event>(type: string, properties?: Partial<T>): T {
  return {
    type,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    defaultPrevented: false,
    ...properties,
  } as unknown as T
}

/**
 * Simulate a user input event
 */
export function createMockInputEvent(value: string) {
  return {
    target: { value },
    currentTarget: { value },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.ChangeEvent<HTMLInputElement>
}

// ============================================================================
// Timer test helpers
// ============================================================================

/**
 * Mock timers
 */
export function mockTimers() {
  vi.useFakeTimers()
}

/**
 * Restore real timers
 */
export function restoreTimers() {
  vi.useRealTimers()
}

/**
 * Fast-forward time
 */
export async function advanceTimers(ms: number) {
  vi.advanceTimersByTime(ms)
  await waitForMicrotasks()
}

// ============================================================================
// Performance test helpers
// ============================================================================

/**
 * Measure how long a function takes
 */
export async function measureTime<T>(
  fn: () => T | Promise<T>
): Promise<{ result: T; duration: number }> {
  const start = performance.now()
  const result = await fn()
  const duration = performance.now() - start
  return { result, duration }
}

/**
 * Measure memory usage (requires an environment supporting performance.measureUserAgentSpecificMemory())
 */
export async function measureMemory(): Promise<number> {
  // @ts-ignore
  if (performance.measureUserAgentSpecificMemory) {
    // @ts-ignore
    const memory = await performance.measureUserAgentSpecificMemory()
    return memory.bytes
  }
  return 0
}

// ============================================================================
// Assertion helpers
// ============================================================================

/**
 * Assert the element exists
 */
export function assertExists<T>(value: T | null | undefined, message?: string): asserts value is T {
  if (value == null) {
    throw new Error(message || `Expected value to exist, but received ${value}`)
  }
}

/**
 * Assert a function was called
 */
export function assertCalled(fn: ReturnType<typeof vi.fn>, times = 1): void {
  // Assert via vitest's vi.fn
  const mock = fn as any
  if (mock._isMockFunction) {
    const actualTimes = mock.mock.calls.length
    if (actualTimes !== times) {
      throw new Error(
        `Expected function to be called ${times} times, but was called ${actualTimes} times`
      )
    }
  }
}

/**
 * Assert a function was not called
 */
export function assertNotCalled(fn: ReturnType<typeof vi.fn>): void {
  const mock = fn as any
  if (mock._isMockFunction && mock.mock.calls.length > 0) {
    throw new Error(
      `Expected function not to be called, but was called ${mock.mock.calls.length} times`
    )
  }
}

// ============================================================================
// Snapshot test helpers
// ============================================================================

/**
 * Create a test with a snapshot
 * Note: using this function requires importing expect in the test file
 */
export function createSnapshotTest(name: string, _component: React.ReactNode) {
  // Snapshot tests need it() and expect() in the test file
  // This only serves as a placeholder; write the real assertion in the test file
  return name
}

// ============================================================================
// Export everything
// ============================================================================

export const testHelpers = {
  // Mock object factories
  createMockDirHandle,
  createMockFileHandle,
  createMockStore,
  createMockWorker,
  createMockLLMProvider,
  createMockToolRegistry,
  createMockContextManager,

  // Async helpers
  waitFor,
  waitForElement,
  delay,
  waitForMicrotasks,

  // Store helpers
  renderStoreHook,
  resetStore,

  // Event helpers
  createMockEvent,
  createMockInputEvent,

  // Timer helpers
  mockTimers,
  restoreTimers,
  advanceTimers,

  // Performance helpers
  measureTime,
  measureMemory,

  // Assertion helpers
  assertExists,
  assertCalled,
  assertNotCalled,
}
