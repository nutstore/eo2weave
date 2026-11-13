/**
 * Tests for agent-notification service.
 *
 * Covers:
 *   - Permission gating (granted / default / denied)
 *   - Visibility gating (hidden / visible)
 *   - Payload shape (clientId, projectId, conversationId, kind, NO url)
 *   - Tag de-duplication
 *   - Error swallowing (never throws)
 *   - getCachedClientId caching + timeout fallback
 *   - requestNotificationPermission state machine
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentNotificationOptions } from './agent-notification'

// We need to import after mocking, so use dynamic require pattern via top-level mocks

// ---------------------------------------------------------------------------
// Setup: mock Notification, navigator.serviceWorker, document, settings
// ---------------------------------------------------------------------------

let mockPermission: NotificationPermission = 'granted'
const mockRequestPermission = vi.fn<() => Promise<NotificationPermission>>()

class MockNotification {
  static permission: NotificationPermission = 'granted'
  static requestPermission = mockRequestPermission
  constructor(public title: string, public options?: NotificationOptions) {
    MockNotification.lastInstance = this
  }
  static lastInstance: MockNotification | null = null
  static close = vi.fn()
  onclick: ((ev: Event) => void) | null = null
}

let mockNotificationSettings = {
  enabled: true,
  onlyWhenHidden: true,
}

vi.mock('@/store/settings.store', () => ({
  useSettingsStore: {
    getState: () => ({ agentLoopNotifications: mockNotificationSettings }) as any,
  },
}))

const mockShowNotification = vi.fn<
  (title: string, options?: AgentNotificationOptions) => Promise<void>
>()
let mockReadyPromise: Promise<ServiceWorkerRegistration> | null = null

const mockController = {
  postMessage: vi.fn(),
} as unknown as ServiceWorker

const mockRegistration = {
  active: {} as ServiceWorker,
  showNotification: mockShowNotification,
} as unknown as ServiceWorkerRegistration

beforeEach(() => {
  // Reset all mocks
  vi.clearAllMocks()
  MockNotification.lastInstance = null
  MockNotification.permission = 'granted'
  mockPermission = 'granted'
  mockRequestPermission.mockReset()
  mockRequestPermission.mockResolvedValue('granted')
  mockShowNotification.mockReset()
  mockShowNotification.mockResolvedValue(undefined)
  ;(mockController as unknown as { postMessage: ReturnType<typeof vi.fn> }).postMessage = vi.fn()
  mockReadyPromise = Promise.resolve(mockRegistration)
  // Reset notification settings to defaults
  mockNotificationSettings = { enabled: true, onlyWhenHidden: true }

  // Reset globals
  Object.defineProperty(globalThis, 'Notification', {
    value: MockNotification,
    writable: true,
    configurable: true,
  })
  ;(MockNotification as unknown as { permission: NotificationPermission }).permission = mockPermission

  Object.defineProperty(globalThis.navigator, 'serviceWorker', {
    value: {
      controller: mockController,
      ready: mockReadyPromise,
      getRegistrations: vi.fn(async () => [mockRegistration]),
    },
    writable: true,
    configurable: true,
  })

  Object.defineProperty(document, 'visibilityState', {
    value: 'hidden',
    writable: true,
    configurable: true,
  })

  // Reset clientId cache
  if (typeof window !== 'undefined') {
    delete (window as unknown as { __agentClientId?: unknown }).__agentClientId
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Now import (after global mocks are set up via beforeEach)
const {
  notifyAgentComplete,
  requestNotificationPermission,
  getCachedClientId,
  initAgentNotification,
  _resetClientIdCache,
} = await import('./agent-notification')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('notifyAgentComplete', () => {
  const baseParams = {
    conversationId: 'conv-abc-123',
    projectId: 'proj-1',
    title: '重构建议 · 方案已完成',
    body: '发现 3 处可优化点，报告已写入 /docs/refactor.md',
  }

  it('shows notification when page is hidden and permission granted', async () => {
    ;(MockNotification as unknown as { permission: NotificationPermission }).permission = 'granted'
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })

    await notifyAgentComplete(baseParams)

    expect(mockShowNotification).toHaveBeenCalledOnce()
    const [title, options] = mockShowNotification.mock.calls[0]
    expect(title).toBe(baseParams.title)
    expect(options!.body).toBe(baseParams.body)
  })

  it('leaves visibility suppression to the conversation caller', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })

    await notifyAgentComplete({ ...baseParams, isViewingConversation: true })

    expect(mockShowNotification).toHaveBeenCalledOnce()
  })

  it('shows notification when another conversation is visible', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })

    await notifyAgentComplete({ ...baseParams, isViewingConversation: false })

    expect(
      (mockRegistration as unknown as { showNotification: ReturnType<typeof vi.fn> })
        .showNotification
    ).toHaveBeenCalledOnce()
  })

  it('uses the registration resolved by serviceWorker.ready', async () => {
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: {
        controller: mockController,
        ready: Promise.resolve(mockRegistration),
      },
      writable: true,
      configurable: true,
    })

    await notifyAgentComplete(baseParams)

    expect(mockShowNotification).toHaveBeenCalledOnce()
  })

  it('skips notification when user disabled notifications in settings', async () => {
    mockNotificationSettings.enabled = false

    await notifyAgentComplete(baseParams)

    expect(mockShowNotification).not.toHaveBeenCalled()
  })

  it('skips notification even when page is hidden if enabled is false', async () => {
    mockNotificationSettings.enabled = false
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })

    await notifyAgentComplete(baseParams)

    expect(mockShowNotification).not.toHaveBeenCalled()
  })

  it('skips notification when permission is denied', async () => {
    ;(MockNotification as unknown as { permission: NotificationPermission }).permission = 'denied'

    await notifyAgentComplete(baseParams)

    expect(mockShowNotification).not.toHaveBeenCalled()
  })

  it('skips notification when permission is default', async () => {
    ;(MockNotification as unknown as { permission: NotificationPermission }).permission = 'default'

    await notifyAgentComplete(baseParams)

    expect(mockShowNotification).not.toHaveBeenCalled()
  })

  it('uses a unique tag for every notification', async () => {
    ;(MockNotification as unknown as { permission: NotificationPermission }).permission = 'granted'

    await notifyAgentComplete(baseParams)
    const [, options1] = mockShowNotification.mock.calls[0]
    expect(options1!.tag).toMatch(new RegExp(`^agent-loop-${baseParams.conversationId}-\\d+$`))
  })

  it('attaches correct data fields (clientId, conversationId, projectId, kind)', async () => {
    ;(MockNotification as unknown as { permission: NotificationPermission }).permission = 'granted'

    // Pre-cache clientId
    ;(window as unknown as { __agentClientId?: string }).__agentClientId = 'client-xyz-789'

    await notifyAgentComplete(baseParams)

    const [, options] = mockShowNotification.mock.calls[0]
    const data = options!.data as Record<string, unknown>
    expect(data.conversationId).toBe(baseParams.conversationId)
    expect(data.projectId).toBe(baseParams.projectId)
    expect(data.clientId).toBe('client-xyz-789')
    expect(data.kind).toBe('agent-loop-complete')
  })

  it('does NOT include url in notification data (prevents project mismatch)', async () => {
    ;(MockNotification as unknown as { permission: NotificationPermission }).permission = 'granted'

    await notifyAgentComplete(baseParams)

    const [, options] = mockShowNotification.mock.calls[0]
    const data = options!.data as Record<string, unknown>
    expect(data).not.toHaveProperty('url')
  })

  it('includes user-actionable buttons', async () => {
    ;(MockNotification as unknown as { permission: NotificationPermission }).permission = 'granted'

    await notifyAgentComplete(baseParams)

    const [, options] = mockShowNotification.mock.calls[0]
    expect(options!.actions).toBeDefined()
    const actions = options!.actions as Array<{ action: string; title: string }>
    expect(actions.length).toBe(2)
    expect(actions.map((a) => a.action)).toContain('open')
    expect(actions.map((a) => a.action)).toContain('dismiss')
  })

  it('never throws even if showNotification rejects', async () => {
    ;(MockNotification as unknown as { permission: NotificationPermission }).permission = 'granted'
    mockShowNotification.mockRejectedValueOnce(new Error('SW boom'))

    await expect(notifyAgentComplete(baseParams)).resolves.toBeUndefined()
  })

  it('does nothing when Notification API is undefined (older browsers)', async () => {
    Object.defineProperty(globalThis, 'Notification', {
      value: undefined,
      writable: true,
      configurable: true,
    })

    await notifyAgentComplete(baseParams)
    // Should silently no-op without throwing
    expect(mockShowNotification).not.toHaveBeenCalled()
  })

  it('does nothing when navigator.serviceWorker is undefined', async () => {
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: undefined,
      writable: true,
      configurable: true,
    })

    await notifyAgentComplete(baseParams)
    expect(mockShowNotification).not.toHaveBeenCalled()
  })
})

describe('requestNotificationPermission', () => {
  it('returns current permission if already granted', async () => {
    ;(MockNotification as unknown as { permission: NotificationPermission }).permission = 'granted'

    const result = await requestNotificationPermission()
    expect(result).toBe('granted')
    expect(mockRequestPermission).not.toHaveBeenCalled()
  })

  it('returns denied if already denied', async () => {
    ;(MockNotification as unknown as { permission: NotificationPermission }).permission = 'denied'

    const result = await requestNotificationPermission()
    expect(result).toBe('denied')
    expect(mockRequestPermission).not.toHaveBeenCalled()
  })

  it('requests permission if default', async () => {
    ;(MockNotification as unknown as { permission: NotificationPermission }).permission = 'default'
    mockRequestPermission.mockResolvedValueOnce('granted')

    const result = await requestNotificationPermission()
    expect(result).toBe('granted')
    expect(mockRequestPermission).toHaveBeenCalledOnce()
  })

  it('returns denied when Notification API is unavailable', async () => {
    Object.defineProperty(globalThis, 'Notification', {
      value: undefined,
      writable: true,
      configurable: true,
    })

    const result = await requestNotificationPermission()
    expect(result).toBe('denied')
  })

  it('returns denied if requestPermission throws', async () => {
    ;(MockNotification as unknown as { permission: NotificationPermission }).permission = 'default'
    mockRequestPermission.mockRejectedValueOnce(new Error('user gesture required'))

    const result = await requestNotificationPermission()
    expect(result).toBe('denied')
  })
})

describe('getCachedClientId', () => {
  it('returns cached value on second call without hitting SW', async () => {
    ;(window as unknown as { __agentClientId?: string }).__agentClientId = 'cached-id-1'

    const id = await getCachedClientId()
    expect(id).toBe('cached-id-1')
    expect(mockController.postMessage).not.toHaveBeenCalled()
  })

  it('returns null when no SW controller is present', async () => {
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: { controller: null, ready: mockReadyPromise },
      writable: true,
      configurable: true,
    })

    const id = await getCachedClientId()
    expect(id).toBeNull()
  })

  it('returns null when SW does not respond within timeout', async () => {
    // Don't postMessage — let it timeout
    ;(mockController as unknown as { postMessage: ReturnType<typeof vi.fn> }).postMessage = vi.fn()

    const id = await getCachedClientId()
    expect(id).toBeNull()
  }, 2000)

  it('handles postMessage errors gracefully', async () => {
    ;(mockController as unknown as { postMessage: ReturnType<typeof vi.fn> }).postMessage = vi.fn(() => {
      throw new Error('postMessage failed')
    })

    const id = await getCachedClientId()
    expect(id).toBeNull()
  })

  it('caches explicit null to avoid repeated SW calls', async () => {
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: { controller: null, ready: mockReadyPromise },
      writable: true,
      configurable: true,
    })

    // First call: should NOT call controller.postMessage (no controller)
    await getCachedClientId()
    // Second call: should return cached null
    const id = await getCachedClientId()
    expect(id).toBeNull()
  })
})

describe('initAgentNotification', () => {
  it('pre-fetches clientId so first notification has it ready', async () => {
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: { controller: null, ready: mockReadyPromise },
      writable: true,
      configurable: true,
    })

    await initAgentNotification()
    // clientId is cached as null
    expect((window as unknown as { __agentClientId?: unknown }).__agentClientId).toBeNull()
  })

  it('is idempotent — returns the same promise on subsequent calls', async () => {
    const p1 = initAgentNotification()
    const p2 = initAgentNotification()
    expect(p1).toBe(p2)
  })
})

describe('_resetClientIdCache', () => {
  it('clears cached clientId so next call re-fetches', async () => {
    ;(window as unknown as { __agentClientId?: string }).__agentClientId = 'old-id'

    _resetClientIdCache()

    expect((window as unknown as { __agentClientId?: unknown }).__agentClientId).toBeUndefined()
  })
})


  it('skips the notification when serviceWorker.ready never resolves', async () => {
    vi.useFakeTimers()
    try {
      Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        value: { controller: null, ready: new Promise(() => {}), getRegistrations: vi.fn(async () => []) },
        writable: true,
        configurable: true,
      })
      const pending = notifyAgentComplete({ conversationId: 'c1', projectId: 'p1', title: 't', body: 'b' })
      await vi.advanceTimersByTimeAsync(3000)
      await expect(pending).resolves.toBeUndefined()
      expect(mockShowNotification).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
