import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdapterService } from '../../../browser-extension/entrypoints/webmcp/adapter-service'
import type { BrowserRequest } from '../../../browser-extension/lib/bash-commands/browser/command'
import type { WebMCPPackage } from '@creatorweave/shared/webmcp-adapter'
import { pkg } from './fixtures'

const runner = vi.hoisted(() => vi.fn())
vi.mock('../../../browser-extension/entrypoints/webmcp/adapter-runtime', () => ({
  executeAdapterWorkflow: runner,
}))

const sender = {
  tab: { id: 8 },
  frameId: 0,
  documentId: 'doc-a',
  url: 'https://example.com/articles',
} as chrome.runtime.MessageSender

function setup(packages: WebMCPPackage[] = [pkg]) {
  const loadWasm = vi.fn(async () => ({}) as WebAssembly.Module)
  const readPackages = vi.fn(async () => packages)
  const runBrowser = vi.fn(
    async (_owner: string, _request: BrowserRequest, _signal: AbortSignal): Promise<unknown> => ({
      tabId: 8,
    })
  )
  const changed = vi.fn()
  const service = createAdapterService({ readPackages, loadWasm, runBrowser, changed })
  const request = (requestId = 'page-request') => ({
    requestId,
    routeId: service.catalog(sender)[0].routeId,
    args: {},
  })
  return { service, request, readPackages, runBrowser, changed }
}
const ready = async (service: ReturnType<typeof createAdapterService>) => {
  await service.refresh()
  return service
}

beforeEach(() => {
  vi.resetAllMocks()
  runner.mockResolvedValue({ ok: true, value: { status: 'success', result: 1 } })
})
afterEach(() => vi.unstubAllGlobals())

describe('extension-owned adapter catalog', () => {
  it('publishes matching routes without a workspace host or page attachment', async () => {
    const { service, changed } = setup()
    expect(service.catalog(sender)).toEqual([])
    await ready(service)
    expect(service.catalog(sender)).toEqual([
      expect.objectContaining({ name: 'com.example.tools.read-title' }),
    ])
    expect(service.catalog({ ...sender, url: 'https://other.test' })).toEqual([])
    expect(changed).toHaveBeenCalledOnce()
  })

  it('keeps route IDs stable while unchanged and replaces changed source', async () => {
    const { service, request, readPackages } = setup()
    await ready(service)
    const old = request()
    await service.refresh()
    expect(service.catalog(sender)[0].routeId).toBe(old.routeId)

    readPackages.mockResolvedValueOnce([
      {
        ...pkg,
        sources: { 'read-title.js': pkg.sources['read-title.js'].replace("'title'", "'changed'") },
      },
    ])
    await service.refresh()
    expect(service.catalog(sender)[0].routeId).not.toBe(old.routeId)
    expect(await service.invoke(sender, old)).toMatchObject({ ok: false })
  })

  it('withdraws every route when catalog loading fails', async () => {
    const { service, readPackages } = setup()
    await ready(service)
    readPackages.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(service.refresh()).rejects.toThrow('storage unavailable')
    expect(service.catalog(sender)).toEqual([])
  })
})

describe('extension-owned adapter execution', () => {
  it('passes parsed browser requests directly to the WXT browser executor', async () => {
    const { service, request, runBrowser } = setup()
    await ready(service)
    runner.mockImplementationOnce(async (_wasm, _source, _input, browser) => ({
      ok: true,
      value: await browser(
        {
          command: 'eval',
          positionals: ['() => 5'],
          options: { tab: '8' },
          stdin: '',
        },
        new AbortController().signal
      ),
    }))

    expect(await service.invoke(sender, request())).toEqual({ ok: true, value: { tabId: 8 } })
    expect(runBrowser).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ command: 'eval', positionals: ['() => 5'], options: { tab: '8' } }),
      expect.any(AbortSignal)
    )
    expect(JSON.stringify(runner.mock.calls[0].slice(0, 3))).not.toContain('rootUri')
  })

  it('does not serialize independent workflow executions', async () => {
    const { service, request } = setup()
    await ready(service)
    const complete: Array<(value: unknown) => void> = []
    runner.mockImplementation(() => new Promise((resolve) => complete.push(resolve)))
    const calls = Array.from({ length: 12 }, (_, index) =>
      service.invoke(sender, request(`request-${index}`))
    )

    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(12))
    complete.forEach((finish, index) =>
      finish({
        ok: true,
        value: { status: 'success', result: index },
      })
    )
    await expect(Promise.all(calls)).resolves.toEqual(
      Array.from({ length: 12 }, (_, index) => ({
        ok: true,
        value: { status: 'success', result: index },
      }))
    )
  })

  it('allows a nested WebMCP call to complete without a tab or execution lock', async () => {
    const { service, request, runBrowser } = setup()
    await ready(service)
    runner.mockImplementationOnce(async (_wasm, _source, _input, browser) => ({
      ok: true,
      value: await browser(
        {
          command: 'webmcp',
          positionals: ['exec', 'com.other.tool', '{}'],
          options: { tab: '9' },
          stdin: '',
        },
        new AbortController().signal
      ),
    }))

    expect(await service.invoke(sender, request())).toMatchObject({ ok: true })
    expect(runBrowser).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ command: 'webmcp', positionals: ['exec', 'com.other.tool', '{}'] }),
      expect.any(AbortSignal)
    )
  })

  it('re-enters through two nested WebMCP executions without serializing or deadlocking', async () => {
    const workflow = (label: string) => `export default {
      inputSchema: { type: 'object' }, outputSchema: { type: 'string' },
      tree: { type: 'action', run() { return 'success' } },
      result() { return '${label}' }
    }`
    const packageNamed = (id: string, label: string) => ({
      manifest: {
        ...pkg.manifest,
        id,
        tools: [
          {
            ...pkg.manifest.tools[0],
            name: label,
            path: `${label}.js`,
          },
        ],
      },
      sources: { [`${label}.js`]: workflow(label) },
    })
    const outer = packageNamed('com.example.outer', 'outer')
    const inner = packageNamed('com.example.inner', 'inner')
    const leaf = packageNamed('com.example.leaf', 'leaf')
    const { service, runBrowser } = setup([outer, inner, leaf])
    await ready(service)
    const routes = new Map(service.catalog(sender).map((route) => [route.name, route]))
    const requestFor = (name: string, requestId: string) => ({
      requestId,
      routeId: routes.get(name)!.routeId,
      args: {},
    })

    runBrowser.mockImplementation(async (_owner, request) => {
      expect(request).toMatchObject({
        command: 'webmcp',
        positionals: ['exec', expect.any(String), '{}'],
      })
      const nestedName = request.positionals[1]
      return service.invoke(sender, requestFor(nestedName, `nested-${nestedName}`))
    })
    runner.mockImplementation(async (_wasm, source, _input, browser, signal) => {
      if (source.includes("return 'outer'"))
        return {
          ok: true,
          value: {
            status: 'success',
            result: await browser(
              {
                command: 'webmcp',
                positionals: ['exec', 'com.example.inner.inner', '{}'],
                options: { tab: '8' },
                stdin: '',
              },
              signal
            ),
          },
        }
      if (source.includes("return 'inner'"))
        return {
          ok: true,
          value: {
            status: 'success',
            result: await browser(
              {
                command: 'webmcp',
                positionals: ['exec', 'com.example.leaf.leaf', '{}'],
                options: { tab: '8' },
                stdin: '',
              },
              signal
            ),
          },
        }
      return { ok: true, value: { status: 'success', result: 'leaf reached' } }
    })

    const result = await service.invoke(
      sender,
      requestFor('com.example.outer.outer', 'outer-request')
    )
    expect(result.ok).toBe(true)
    expect(runner).toHaveBeenCalledTimes(3)
    expect(runBrowser).toHaveBeenCalledTimes(2)
  })

  it('uses Chrome document identity for direct tab invocations', async () => {
    const { service } = setup()
    await ready(service)
    const executeScript = vi.fn(async () => [
      { frameId: 0, documentId: 'fresh-document', result: sender.url },
    ])
    vi.stubGlobal('chrome', {
      tabs: { get: vi.fn(async () => ({ id: 8, url: sender.url })) },
      scripting: { executeScript },
    })
    const name = service.catalog(sender)[0].name
    expect(await service.invokeForTab(8, name, { value: 1 })).toMatchObject({ ok: true })
    expect(runner.mock.calls[0][5]).toEqual({ tabId: 8, url: sender.url })
    expect(await service.invokeForTab(8, 'native-tool', {})).toBeNull()
    executeScript.mockResolvedValueOnce([
      {
        frameId: 0,
        documentId: 'navigated-document',
        result: 'https://other.test/',
      },
    ])
    expect(await service.invokeForTab(8, name, {})).toBeNull()
  })

  it('cancels only the matching document and does not cap concurrency', async () => {
    const { service, request } = setup()
    await ready(service)
    let signal!: AbortSignal
    runner.mockImplementationOnce(async (_wasm, _source, _input, _browser, callSignal) => {
      signal = callSignal
      return new Promise((_resolve, reject) => {
        callSignal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('canceled'), { code: 'JS_CANCELED' })),
          { once: true }
        )
      })
    })
    const running = service.invoke(sender, request())
    await vi.waitFor(() => expect(signal).toBeDefined())
    service.cancel({ ...sender, documentId: 'other-document' }, 'page-request')
    expect(signal.aborted).toBe(false)
    service.cancel(sender, 'page-request')
    expect(await running).toMatchObject({ ok: false, error: { code: 'JS_CANCELED' } })
  })

  it('retains unaffected routes and aborts workflows only when their route is withdrawn', async () => {
    const { service, request, readPackages } = setup()
    const other = { ...pkg, manifest: { ...pkg.manifest, id: 'com.example.other' } }
    readPackages.mockResolvedValue([pkg, other])
    await ready(service)
    const retained = request()
    let signal!: AbortSignal
    let finish!: () => void
    runner.mockImplementationOnce(async (_wasm, _source, _args, _browser, currentSignal) => {
      signal = currentSignal
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return { ok: true, value: { status: 'success', result: 1 } }
    })
    const running = service.invoke(sender, retained)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    readPackages.mockResolvedValue([pkg])
    await service.refresh()
    expect(signal.aborted).toBe(false)
    expect(service.catalog(sender)[0].routeId).toBe(retained.routeId)

    readPackages.mockResolvedValue([])
    await service.refresh()
    expect(signal.aborted).toBe(true)
    finish()
    await running
  })
})

it('cancels promptly while WASM loading is pending', async () => {
  const loadWasm = vi.fn(() => new Promise<WebAssembly.Module>(() => {}))
  const pending = createAdapterService({
    loadWasm,
    readPackages: async () => [pkg],
    runBrowser: vi.fn(),
    changed: vi.fn(),
  })
  await pending.refresh()
  const result = pending.invoke(sender, {
    requestId: 'page-request',
    routeId: pending.catalog(sender)[0].routeId,
    args: {},
  })
  pending.cancel(sender, 'page-request')
  expect(await result).toMatchObject({ ok: false, error: { code: 'JS_CANCELED' } })
  expect(runner).not.toHaveBeenCalled()
})
