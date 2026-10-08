import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bash } from 'just-bash/browser'
import { parseBrowserCommand, invokeBrowserCommand } from '../../../browser-extension/lib/bash-commands/browser/command'
import { BrowserError } from '../../../browser-extension/lib/bash-commands/browser/errors'
import { BrowserTask } from '../../../browser-extension/lib/bash-commands/browser/task'
import { installBrowserCommand } from '../../../browser-extension/lib/bash-commands/browser/provider'
import { createProxyCommand } from '../tools/bash-worker/proxy-command'

const input = (args: string[], stdin = '') => ({ args, stdin })
afterEach(() => { delete window.creatorWeave; vi.unstubAllGlobals(); vi.useRealTimers() })

describe('composable browser commands', () => {
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
    expect(() => parseBrowserCommand(input(['fill', '#name', 'value', '--submit']))).toThrow()
    expect(() => parseBrowserCommand(input(['goto', 'https://example.com', '--wait-until=networkidle']))).toThrow('--wait-until')
  })
  it('preserves structured diagnostics in JSON stderr', async () => {
    const result = await invokeBrowserCommand(input(['eval', '() => {}']), async () => { throw new BrowserError('failed', { buffer: '[warn] before\n[error] failed' }) })
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr).error.details.buffer).toContain('[warn] before')
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
