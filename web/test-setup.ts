/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Vitest Test Setup
 *
 * Configures the testing environment for React components and utilities.
 */

import { expect, afterEach, vi, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import * as matchers from '@testing-library/jest-dom/matchers'

// Extend Vitest's expect with jest-dom matchers
expect.extend(matchers)

// Cleanup after each test
afterEach(() => {
  cleanup()
})

// Mock IndexedDB for tests
const indexedDBMock = {
  open: vi.fn(() => ({
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
    result: {
      createObjectStore: vi.fn(),
      transaction: vi.fn(() => ({
        objectStore: vi.fn(() => ({
          get: vi.fn(),
          put: vi.fn(),
          delete: vi.fn(),
          getAll: vi.fn(),
        })),
      })),
      close: vi.fn(),
    },
  })),
}

global.indexedDB = indexedDBMock as any

// Mock File System Access API
;(globalThis as any).showDirectoryPicker = vi.fn(() => Promise.resolve({}))

// localStorage polyfill for broken environments.
//
// Node 25+ exposes an experimental, disabled-by-default `globalThis.localStorage`
// that is a bare object WITHOUT getItem/setItem (it logs
// "`--localstorage-file` was provided without a valid path" at startup).
// When vitest populates the happy-dom window globals it copies that broken
// object over happy-dom's real Storage implementation, so any component or
// store touching localStorage crashes with "window.localStorage.getItem is
// not a function". Detect a Storage-like object missing its methods and
// replace it with an in-memory Map-backed polyfill; on healthy environments
// (real happy-dom Storage / jsdom / browsers) this is a no-op.
if (
  typeof globalThis.localStorage === 'object' &&
  globalThis.localStorage !== null &&
  typeof (globalThis.localStorage as Storage).getItem !== 'function'
) {
  const data = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, String(value)),
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
  // happy-dom's window object mirrors globalThis at populate time; patch the
  // window copy too if it inherited the broken object.
  const win = (globalThis as { window?: { localStorage?: unknown } }).window
  if (win && typeof win.localStorage === 'object' && win.localStorage !== null && typeof (win.localStorage as Storage).getItem !== 'function') {
    Object.defineProperty(win, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true,
    })
  }
}

// Pointer capture polyfill for happy-dom.
//
// Radix UI primitives (Select, DropdownMenu, Popover) call
// `hasPointerCapture` on the pointer event target while handling an
// interaction. happy-dom does not implement the Pointer Events capture API,
// so opening a Radix dropdown throws
// "target.hasPointerCapture is not a function". Stub the three capture
// methods as no-ops so those interactions stay testable. On environments
// that already implement them (jsdom, real browsers) this is a no-op.
if (typeof Element !== 'undefined') {
  const elementProto = Element.prototype as any
  if (typeof elementProto.hasPointerCapture !== 'function') {
    elementProto.hasPointerCapture = () => false
    elementProto.setPointerCapture = () => {}
    elementProto.releasePointerCapture = () => {}
  }
}

// Mock URL.createObjectURL and revokeObjectURL
global.URL.createObjectURL = vi.fn(() => 'blob:mock-url')
global.URL.revokeObjectURL = vi.fn()

// Set default test timeout for long-running tests
beforeEach(() => {
  vi.setConfig({ testTimeout: 30000 })
})
// Web Locks API stub for happy-dom (unimplemented — its `navigator.locks`
// getter always returns null). A real in-memory LockManager is provided so
// import serialization / recovery-fencing tests exercise the SAME Web-Locks
// code paths the browser uses. Tests that need the no-locks environment
// delete `navigator.locks` explicitly.
if (typeof navigator !== 'undefined' && !(navigator as any).locks) {
  const held = new Map<string, Set<Promise<unknown>>>()
  const makeLock = () => ({ release: () => {} })
  const request = async (name: string, ...rest: unknown[]) => {
    const hasOptions = rest.length === 2
    const options = hasOptions ? (rest[0] as { ifAvailable?: boolean }) : undefined
    const callback = (hasOptions ? rest[1] : rest[0]) as (lock: unknown) => unknown
    const prev = held.get(name)
    if (options?.ifAvailable) {
      if (prev && prev.size > 0) return await callback(null)
    }
    while (prev && prev.size > 0) {
      // A rejected lock callback still releases the lock; the next waiter
      // must acquire it rather than inherit the previous callback's error.
      await Promise.race([...prev].map((pending) => pending.catch(() => {})))
    }
    const p = (async () => {
      const result = await callback(makeLock())
      return result
    })()
    if (!held.has(name)) held.set(name, new Set())
    held.get(name)!.add(p)
    try {
      return await p
    } finally {
      held.get(name)?.delete(p)
    }
  }
  Object.defineProperty(navigator, 'locks', {
    value: { request },
    configurable: true,
  })
}
