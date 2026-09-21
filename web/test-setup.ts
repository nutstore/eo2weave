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

// Mock URL.createObjectURL and revokeObjectURL
global.URL.createObjectURL = vi.fn(() => 'blob:mock-url')
global.URL.revokeObjectURL = vi.fn()

// Set default test timeout for long-running tests
beforeEach(() => {
  vi.setConfig({ testTimeout: 30000 })
})
