/**
 * web_search / web_fetch registration contract.
 *
 * Both tools are registered unconditionally on DESKTOP. Without the Browser
 * Extension the executor returns a non-retryable BRIDGE_UNAVAILABLE envelope
 * and the conversation UI renders it as ExtensionErrorCard (the install
 * prompt).
 *
 * The previous behaviour — register only when `window.__agentWeb` exists — made
 * "extension not installed" indistinguishable from "capability does not exist":
 * the model never saw the tools, so it could never tell the user that web
 * access exists and just needs the extension. These tests pin the new contract.
 *
 * Mobile is excluded: phones/tablets cannot install browser extensions, so the
 * tools are not registered there at all.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { getToolRegistry, ToolRegistry } from '@/agent/tool-registry'
import { webFetchExecutor, webSearchExecutor } from '@/agent/tools/web-bridge.tool'

function expectBridgeUnavailable(raw: string, tool: 'web_search' | 'web_fetch') {
  const env = JSON.parse(raw) as {
    ok: boolean
    tool: string
    error: { code: string; retryable: boolean; hint?: string }
  }
  expect(env.tool).toBe(tool)
  expect(env.ok).toBe(false)
  expect(env.error.code).toBe('BRIDGE_UNAVAILABLE')
  // A retryable envelope would make the agent loop on an install prompt.
  expect(env.error.retryable).toBe(false)
  // The hint is what steers the model into guiding the user instead of retrying.
  expect(env.error.hint ?? '').toMatch(/install/i)
}

describe('web bridge tools without the Browser Extension', () => {
  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).__agentWeb
  })

  it('registers both tools on a bare registry and reports the bridge as unavailable', () => {
    const registry = new ToolRegistry()
    expect(registry.registerWebBridgeTools()).toBe(false)
    expect(registry.has('web_search')).toBe(true)
    expect(registry.has('web_fetch')).toBe(true)
  })

  it('keeps them visible to the model in plan mode (read-only tools)', () => {
    const registry = new ToolRegistry()
    registry.registerWebBridgeTools()
    const planNames = registry.getToolDefinitionsForMode('plan').map((d) => d.function.name)
    expect(planNames).toContain('web_search')
    expect(planNames).toContain('web_fetch')
  })

  it('exposes them from the shared registry used by the agent loop', () => {
    const names = getToolRegistry().getToolDefinitions().map((d) => d.function.name)
    expect(names).toContain('web_search')
    expect(names).toContain('web_fetch')
  })

  it('web_search returns a non-retryable BRIDGE_UNAVAILABLE envelope', async () => {
    expectBridgeUnavailable(
      await webSearchExecutor({ query: 'hello' }, {} as never),
      'web_search',
    )
  })

  it('web_fetch returns a non-retryable BRIDGE_UNAVAILABLE envelope', async () => {
    expectBridgeUnavailable(
      await webFetchExecutor({ url: 'https://example.com' }, {} as never),
      'web_fetch',
    )
  })

  it('registers neither tool on mobile (extensions cannot be installed there)', () => {
    const original = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent')
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      configurable: true,
    })
    try {
      const registry = new ToolRegistry()
      expect(registry.registerWebBridgeTools()).toBe(false)
      expect(registry.has('web_search')).toBe(false)
      expect(registry.has('web_fetch')).toBe(false)
      const names = registry.getToolDefinitions().map((d) => d.function.name)
      expect(names).not.toContain('web_search')
      expect(names).not.toContain('web_fetch')
    } finally {
      if (original) Object.defineProperty(window.navigator, 'userAgent', original)
      else delete (window.navigator as unknown as Record<string, unknown>).userAgent
    }
  })
})
