import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bash } from 'just-bash/browser'
import { parseBrowserCommand, invokeBrowserCommand } from '../../../browser-extension/lib/bash-commands/browser/command'
import { evaluatePage } from '../../../browser-extension/lib/bash-commands/browser/evaluate'
import { BrowserError } from '../../../browser-extension/lib/bash-commands/browser/errors'
import { BrowserTask } from '../../../browser-extension/lib/bash-commands/browser/task'
import { installBrowserCommand } from '../../../browser-extension/lib/bash-commands/browser/provider'
import { createProxyCommand } from '../tools/bash-worker/proxy-command'
import { runBrowserRequest } from '../../../browser-extension/lib/bash-commands/browser/runtime'
import { withTabLock } from '../../../browser-extension/lib/bash-commands/browser/cdp'
import type { TabWebMCPApi } from '../../../browser-extension/entrypoints/webmcp/tab-api'

const input = (args: string[], stdin = '') => ({ args, stdin })
afterEach(() => { delete window.creatorWeave; vi.unstubAllGlobals(); vi.useRealTimers() })

describe('composable browser commands', () => {
  it('validates nested WebMCP commands and their longer execution deadline', () => {
    expect(parseBrowserCommand(input(['webmcp', 'list', '--tab=10']))).toMatchObject({ command: 'webmcp', positionals: ['list'], options: { tab: '10' } })
    expect(parseBrowserCommand(input(['webmcp', 'exec', 'exact.name', '{}', '--timeout=60000']))).toMatchObject({ positionals: ['exec', 'exact.name', '{}'] })
    for (const args of [['webmcp'], ['webmcp', 'other'], ['webmcp', 'list', 'extra'], ['webmcp', 'exec']])
      expect(() => parseBrowserCommand(input(args))).toThrow()
    expect(() => parseBrowserCommand(input(['webmcp', 'list', '--timeout=60000']))).toThrow('30000')
  })
  it.each(['find', 'text-content', 'cdp'])('does not expose redundant %s commands', async name => {
    const run = vi.fn()
    const result = await invokeBrowserCommand(input([name]), run)
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).error.message).toContain('Unknown browser command')
    expect(run).not.toHaveBeenCalled()
  })
  it('requires a type target and supports literal text and background tabs', () => {
    expect(() => parseBrowserCommand(input(['type']))).toThrow('Invalid arguments')
    expect(parseBrowserCommand(input(['type', '#name', '--', '--value']))).toMatchObject({ positionals: ['#name', '--value'] })
    expect(parseBrowserCommand(input(['tab-new', '--background']))).toMatchObject({ options: { background: true } })
    expect(parseBrowserCommand(input(['click', '#save', '--activate']))).toMatchObject({ options: { activate: true } })
    expect(() => parseBrowserCommand(input(['click', '#save', '--activate=true']))).toThrow('takes no value')
    expect(() => parseBrowserCommand(input(['fill', '#save', 'value', '--activate']))).toThrow('Unknown option')
    expect(() => parseBrowserCommand(input(['fill', '#name', 'value', '--submit']))).toThrow()
    expect(() => parseBrowserCommand(input(['goto', 'https://example.com', '--wait-until=networkidle']))).toThrow('--wait-until')
  })
  it('preserves structured diagnostics in JSON stderr', async () => {
    const result = await invokeBrowserCommand(input(['eval', '() => {}']), async () => { throw new BrowserError('failed', { logs: [{ level: 'warn', args: ['before'] }] }) })
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr).error.details.logs).toEqual([{ level: 'warn', args: ['before'] }])
  })
  it('supports selection and persistence using jq and shell composition', async () => {
    const calls: string[][] = []
    const bash = new Bash({ customCommands: [createProxyCommand('browser', async (_name, commandInput) => {
      calls.push(commandInput.args)
      return invokeBrowserCommand(commandInput, async request => request.command === 'snapshot'
        ? { nodes: [{ role: 'button', name: 'Save', ref: 'e12' }, { role: 'link', name: 'Other', ref: 'e13' }] }
        : { clicked: true })
    })] })
    const result = await bash.exec(`ref=$(browser snapshot | jq -er '.nodes[] | select(.role == "button" and .name == "Save") | .ref'); browser click "$ref" && browser snapshot > /tmp/snapshot.json; cat /tmp/snapshot.json | jq '.nodes | length'`)
    expect(result.exitCode, JSON.stringify(result)).toBe(0)
    expect(result.stdout).toBe('{"clicked":true}\n2\n')
    expect(calls).toContainEqual(['click', 'e12'])
  })
})

describe('browser provider lifecycle', () => {
  it('cancels only requests belonging to the shell whose lifecycle ended', async () => {
    vi.stubGlobal('location', { href: 'http://localhost:5173/app' })
    let command: any
    const finish: Array<(value: unknown) => void> = []
    const send = vi.fn((type: string) => type === 'browser_command'
      ? new Promise(resolve => { finish.push(resolve) }) : Promise.resolve({ ok: true }))
    window.creatorWeave = { bash: { registerCommand: value => { command = value; return () => {} } } }
    const dispose = installBrowserCommand(send)
    const outerInput = input(['webmcp', 'exec', 'com.example.focus', '--tab=10'])
    const innerInput = input(['eval', '() => 1', '--tab=10'])
    const outer = command.invoke(outerInput)
    const inner = command.invoke(innerInput)
    await vi.waitFor(() => expect(finish).toHaveLength(2))
    const requests = send.mock.calls.filter(call => call[0] === 'browser_command') as unknown as Array<[string, { requestId: string }, number]>
    expect(requests[0][2]).toBe(65000)
    send.mockClear()
    window.dispatchEvent(new CustomEvent('creatorweave:bash-cancel', { detail: { inputs: [innerInput] } }))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('browser_command_cancel', { requestId: requests[1][1].requestId }, 2000)
    finish.forEach(resolve => resolve({ ok: true, result: 1 }))
    await Promise.all([outer, inner])
    dispose()
  })
  it('forwards page cancellation to exactly its pending extension requests', async () => {
    vi.stubGlobal('location', { href: 'http://localhost:5173/app' })
    let command: any, finish: (result: unknown) => void = () => {}
    const send = vi.fn((type: string) => type === 'browser_command'
      ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ ok: true }))
    const unregister = vi.fn()
    window.creatorWeave = { bash: { registerCommand: value => { command = value; return unregister } } }
    const dispose = installBrowserCommand(send)
    expect(await command.isAlive()).toBe(true)
    const running = command.invoke(input(['eval', '() => {}']))
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('browser_command', expect.objectContaining({ requestId: expect.any(String) }), 35000))
    const requestId = (send.mock.calls.find(call => call[0] === 'browser_command') as unknown as [string, { requestId: string }])[1].requestId
    window.dispatchEvent(new Event('creatorweave:bash-cancel'))
    expect(send).toHaveBeenCalledWith('browser_command_cancel', { requestId }, 2000)
    finish({ ok: false, error: { message: 'canceled', details: { phase: 'eval' } } })
    expect(JSON.parse((await running).stderr).error.details).toEqual({ phase: 'eval' })
    send.mockClear()
    window.dispatchEvent(new Event('creatorweave:bash-cancel'))
    expect(send).not.toHaveBeenCalled()
    dispose(); expect(unregister).toHaveBeenCalled()
  })
})

describe('WebMCP browser runtime', () => {
  const api = (): TabWebMCPApi => ({ listForTab: vi.fn(async () => ({ tabId: 10, url: 'https://example.com', hostname: 'example.com', groupKey: 'group', tools: [] })), invokeForTab: vi.fn(async () => ({ tabId: 10, url: 'https://example.com', name: 'exact.name', source: 'page' as const, result: true })) })
  it('uses the explicit tab without acquiring a debugger or the primitive tab lock', async () => {
    const webmcp = api()
    webmcp.invokeForTab = vi.fn(async (tabId, name, args) => withTabLock(tabId, async () => ({ tabId, url: 'https://example.com', name, source: 'adapter' as const, result: args })))
    expect(await runBrowserRequest('owner', parseBrowserCommand(input(['webmcp', 'exec', 'exact.name', '--tab=10'], '{"query":"hello"}')), undefined, webmcp))
      .toMatchObject({ tabId: 10, result: { query: 'hello' } })
    expect(webmcp.invokeForTab).toHaveBeenCalledWith(10, 'exact.name', { query: 'hello' }, expect.any(AbortSignal))
  })
  it('supports selected tabs and default object arguments', async () => {
    vi.stubGlobal('chrome', { storage: { session: { get: vi.fn(async () => ({ 'cw_browser_selected:owner': 12 })) } } })
    const webmcp = api()
    await runBrowserRequest('owner', parseBrowserCommand(input(['webmcp', 'list'])), undefined, webmcp)
    expect(webmcp.listForTab).toHaveBeenCalledWith(12, expect.any(AbortSignal))
    await runBrowserRequest('owner', parseBrowserCommand(input(['webmcp', 'exec', 'exact.name'])), undefined, webmcp)
    expect(webmcp.invokeForTab).toHaveBeenCalledWith(12, 'exact.name', {}, expect.any(AbortSignal))
  })
  it.each(['[]', 'null', '1', '"string"', '{bad'])('rejects non-object JSON %s before execution', async json => {
    const webmcp = api()
    const request = parseBrowserCommand(input(['webmcp', 'exec', 'exact.name', json, '--tab=10']))
    await expect(runBrowserRequest('owner', request, undefined, webmcp)).rejects.toThrow('JSON object')
    expect(webmcp.invokeForTab).not.toHaveBeenCalled()
  })
  it('aborts a running API operation on deadline', async () => {
    vi.useFakeTimers()
    const webmcp = api()
    let signal: AbortSignal | undefined
    webmcp.invokeForTab = vi.fn(async (_tab, _name, _args, s) => { signal = s; return new Promise<never>(() => {}) })
    const running = runBrowserRequest('owner', parseBrowserCommand(input(['webmcp', 'exec', 'exact.name', '--tab=10', '--timeout=10'])), undefined, webmcp)
    const stopped = expect(running).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10)
    await stopped
    expect(signal?.aborted).toBe(true)
  })
})

describe('browser foreground guard', () => {
  it('rejects click on a background tab before attaching the debugger', async () => {
    const get = vi.fn(async (tabId: number) => ({ id: tabId, windowId: 1, active: false, url: 'https://example.com', title: 'Example' }))
    const attach = vi.fn()
    const sendCommand = vi.fn()
    vi.stubGlobal('chrome', {
      tabs: { get },
      debugger: { attach, sendCommand, onDetach: { addListener: vi.fn() } },
      runtime: {},
    })

    const running = runBrowserRequest('owner', parseBrowserCommand(input(['click', '#save', '--tab=10'])))
    await expect(running).rejects.toMatchObject({
      name: 'BrowserError',
      message: expect.stringMatching(/click.*tab.*foreground/i),
      details: { tabId: 10, windowId: 1 },
    })
    expect(get).toHaveBeenCalledWith(10)
    expect(attach).not.toHaveBeenCalled()
    expect(sendCommand).not.toHaveBeenCalled()
  })
  it('activates a background click target when requested', async () => {
    const get = vi.fn(async (tabId: number) => ({ id: tabId, windowId: 1, active: false, url: 'https://example.com', title: 'Example' }))
    const update = vi.fn(async (tabId: number) => ({ id: tabId, windowId: 1, active: true, url: 'https://example.com', title: 'Example' }))
    const sendCommand = vi.fn()
    const runtime: { lastError?: { message: string } } = {}
    const attach = vi.fn((_target: unknown, _version: string, done: () => void) => {
      runtime.lastError = { message: 'debugger unavailable' }
      done()
      delete runtime.lastError
    })
    vi.stubGlobal('chrome', {
      tabs: { get, update },
      debugger: { attach, sendCommand, onDetach: { addListener: vi.fn() } },
      runtime,
    })

    const running = runBrowserRequest('owner', parseBrowserCommand(input(['click', '#save', '--tab=10', '--activate'])))
    await expect(running).rejects.toThrow('debugger unavailable')
    expect(update).toHaveBeenCalledWith(10, { active: true })
    expect(attach).toHaveBeenCalled()
    expect(sendCommand).not.toHaveBeenCalled()
  })
})

describe('browser task deadline', () => {
  it('cancels a queued task before it can send any CDP mutation', async () => {
    const send = vi.fn()
    vi.stubGlobal('chrome', { debugger: { sendCommand: send }, runtime: {} })
    const controller = new AbortController(), task = new BrowserTask(10000, controller.signal)
    task.tabId = 10
    controller.abort(new Error('canceled'))
    await expect(task.send('Input.insertText', { text: 'must not happen' })).rejects.toThrow('canceled')
    expect(send).not.toHaveBeenCalled(); task.dispose()
  })
  it('terminates a running evaluation before reporting cancellation', async () => {
    let terminate: () => void = () => {}
    let evaluated: () => void = () => {}
    const send = vi.fn((_target: unknown, method: string, _params: unknown, done: () => void) => {
      if (method === 'Runtime.terminateExecution') terminate = done
      if (method === 'Runtime.evaluate') evaluated = done
    })
    vi.stubGlobal('chrome', { debugger: { sendCommand: send }, runtime: {} })
    const controller = new AbortController(), task = new BrowserTask(10000, controller.signal)
    task.tabId = 10
    const running = task.evaluate('while(true){}')
    let settled = false
    void running.then(() => { settled = true }, () => { settled = true })
    const stopped = expect(running).rejects.toThrow('canceled')
    controller.abort(new Error('canceled'))
    expect(send).toHaveBeenCalledWith({ tabId: 10 }, 'Runtime.terminateExecution', {}, expect.any(Function))
    evaluated()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    terminate(); await stopped; task.dispose()
  })
})


describe('structured browser evaluation', () => {
  const evaluate = (source: string) => evaluatePage({
    tabId: 123,
    evaluate: (expression: string) => (0, eval)(expression),
  } as BrowserTask, source)

  it('preserves JSON types and console argument boundaries at log time', async () => {
    const output = await evaluate(`async () => {
      const value = { count: 2 };
      console.log("hello\\nworld", value, false, null);
      value.count = 3;
      console.warn([1, 2]);
      return { value, title: "Page", enabled: true };
    }`)
    expect(output).toEqual({ tabId: 123, logs: [
      { level: 'log', args: ['hello\nworld', { count: 2 }, false, null] },
      { level: 'warn', args: [[1, 2]] },
    ], result: { value: { count: 3 }, title: 'Page', enabled: true } })
  })

  it('normalizes non-JSON values and distinguishes cycles from shared references', async () => {
    const output = await evaluate(`() => {
      const shared = { n: 1 }; const cycle = {}; cycle.self = cycle;
      return [undefined, NaN, Infinity, 2n, Symbol('s'), shared, shared, cycle];
    }`)
    expect(output.result).toEqual([null, null, null, '2', 'Symbol(s)', { n: 1 }, { n: 1 }, { self: '[Circular]' }])
    expect((await evaluate('() => {}')).result).toBeNull()
    expect((await evaluate('() => ({ toJSON() { throw new Error("no") } })')).result).toBe('[UnserializableValue]')
  })

  it('retains logs and structured exceptions on failure', async () => {
    await expect(evaluate('() => { console.warn({ count: 2 }); throw new Error("bad") }')).rejects.toMatchObject({
      message: 'bad', details: { tabId: 123, logs: [{ level: 'warn', args: [{ count: 2 }] }], exception: { name: 'Error', message: 'bad' } },
    })
  })

  it('passes structured results through jq without text parsing', async () => {
    const bash = new Bash({ customCommands: [createProxyCommand('browser', async (_name, commandInput) =>
      invokeBrowserCommand(commandInput, () => evaluate('() => ({ items: [{ n: 2 }, { n: 3 }] })')))] })
    const output = await bash.exec(`browser eval '() => ({})' | jq '[.result.items[].n] | add'`)
    expect(output.exitCode).toBe(0)
    expect(output.stdout).toBe('5\n')
  })
})
