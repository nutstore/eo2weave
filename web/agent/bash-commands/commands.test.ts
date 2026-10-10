import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bash } from 'just-bash'
import { BashCommandRegistry, bashCommandRegistry, type ExternalBashCommand } from './registry'
import { installBashCommandAPI } from './public-api'
import { createProxyCommand } from '@/agent/tools/bash-worker/proxy-command'
import { ToolRegistry } from '@/agent/tool-registry'
import { bashDefinition, bashToolExecutor } from '@/agent/tools/bash.tool'

// Match Webpack's browser condition, including exports absent from the Node entry.
vi.mock('just-bash', async () => import('just-bash/browser'))

function command(name = 'extension-echo', output?: string): ExternalBashCommand {
  return {
    isAlive: async () => true,
    manifest: { name, description: 'Echo input', manual: `${name} [args]: echoes stdin as UTF-8 text.` },
    async invoke({ args, stdin }) {
      return { stdout: output ?? `${args.join(' ')}${stdin}`, stderr: '', exitCode: 0 }
    },
  }
}

afterEach(() => { delete window.creatorWeave; vi.restoreAllMocks() })

describe('open bash command registration', () => {
  it('exposes a page API and announces readiness once', () => {
    vi.spyOn(window, 'setInterval').mockReturnValue(0 as unknown as ReturnType<typeof window.setInterval>)
    const ready = vi.fn()
    window.addEventListener('creatorweave:bash-ready', ready)
    installBashCommandAPI()
    const api = window.creatorWeave!.bash!
    installBashCommandAPI()
    expect(window.creatorWeave!.bash).toBe(api)
    expect(ready).toHaveBeenCalledTimes(1)
    const unregister = api.registerCommand(command())
    expect(bashCommandRegistry.snapshot().has('extension-echo')).toBe(true)
    unregister()
    window.removeEventListener('creatorweave:bash-ready', ready)
  })

  it('automatically removes an unloaded extension on the Web monitor tick', async () => {
    vi.useFakeTimers()
    let unregister: (() => void) | undefined
    try {
      installBashCommandAPI()
      let alive = true
      unregister = window.creatorWeave!.bash!.registerCommand({
        ...command('monitored'), isAlive: async () => alive,
      })
      await vi.advanceTimersByTimeAsync(15000)
      expect(bashCommandRegistry.snapshot().has('monitored')).toBe(true)
      alive = false
      await vi.advanceTimersByTimeAsync(15000)
      expect(bashCommandRegistry.snapshot().has('monitored')).toBe(false)
    } finally {
      unregister?.()
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('last registration wins; old cleanup cannot delete the replacement', async () => {
    const registry = new BashCommandRegistry()
    const first = registry.registerCommand(command('same', 'first'))
    const snapshot = registry.snapshot()
    const second = registry.registerCommand(command('same', 'second'))
    first()
    expect(registry.snapshot().size).toBe(1)
    await expect(registry.snapshot().get('same')!.invoke({ args: [], stdin: '' }))
      .resolves.toMatchObject({ stdout: 'second' })
    await expect(snapshot.get('same')!.invoke({ args: [], stdin: '' }))
      .resolves.toMatchObject({ stdout: 'first' })
    second()
    expect(registry.snapshot().size).toBe(0)
  })

  it('preserves the invoke receiver and copies the manifest', async () => {
    const registry = new BashCommandRegistry()
    const original = command()
    original.invoke = async function () {
      return { stdout: this.manifest.manual, stderr: '', exitCode: 0 }
    }
    registry.registerCommand(original)
    original.manifest.name = 'changed'
    expect(registry.snapshot().has('extension-echo')).toBe(true)
    expect(await registry.snapshot().get('extension-echo')!.invoke({ args: [], stdin: '' }))
      .toMatchObject({ stdout: original.manifest.manual })
  })

  it('rejects malformed declarations', () => {
    const registry = new BashCommandRegistry()
    expect(() => registry.registerCommand(command('bad name'))).toThrow('Invalid bash command')
    expect(() => registry.registerCommand({ manifest: command().manifest } as ExternalBashCommand))
      .toThrow('Invalid bash command')
  })

  it('removes commands after disconnection without requiring unregister', async () => {
    const registry = new BashCommandRegistry()
    const injected = command()
    let alive = true
    injected.isAlive = async () => alive
    registry.registerCommand(injected)
    await registry.refresh()
    expect(registry.snapshot().size).toBe(1)
    alive = false
    await registry.refresh()
    expect(registry.snapshot().size).toBe(0)
    expect(registry.describe()).toBe('')
  })

  it('expires a hung probe and ignores its late success', async () => {
    vi.useFakeTimers()
    try {
      const registry = new BashCommandRegistry(100)
      let resolve!: (alive: boolean) => void
      registry.registerCommand({ ...command(), isAlive: () => new Promise(r => { resolve = r }) })
      const refreshing = registry.refresh()
      await vi.advanceTimersByTimeAsync(100)
      await refreshing
      expect(registry.snapshot().size).toBe(0)
      resolve(true)
      await Promise.resolve()
      expect(registry.snapshot().size).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('an old failed probe cannot remove a newer same-name registration', async () => {
    const registry = new BashCommandRegistry()
    let resolve!: (alive: boolean) => void
    registry.registerCommand({ ...command(), isAlive: () => new Promise(r => { resolve = r }) })
    const refreshing = registry.refresh()
    await Promise.resolve()
    registry.registerCommand(command())
    resolve(false)
    await refreshing
    expect(registry.snapshot().size).toBe(1)
  })

  it('removes rejected probes and probes different commands independently', async () => {
    const registry = new BashCommandRegistry()
    registry.registerCommand({ ...command('broken'), isAlive: async () => { throw new Error('extension unloaded') } })
    registry.registerCommand(command('healthy'))
    await registry.refresh()
    expect(Array.from(registry.snapshot().keys())).toEqual(['healthy'])
  })

  it('adds the current manual to model definitions without changing the base definition', () => {
    const tools = new ToolRegistry()
    tools.register(bashDefinition, bashToolExecutor)
    const unregister = bashCommandRegistry.registerCommand(command())
    try {
      expect(tools.getToolDefinitionsForMode('act')[0].function.description).toContain('echoes stdin as UTF-8')
      expect(tools.getToolDefinitionsForMode('plan')[0].function.description).not.toContain('extension-echo')
      expect(bashDefinition.function.description).not.toContain('extension-echo')
    } finally { unregister() }
    expect(tools.getToolDefinitions()[0].function.description).not.toContain('extension-echo')
  })
})

describe('external command Bash proxy', () => {
  it('supports quoting, UTF-8 pipes, redirection and downstream commands', async () => {
    const invoke = vi.fn(async (_name, input) => command().invoke(input))
    const bash = new Bash({ customCommands: [createProxyCommand('extension-echo', invoke)] })
    const result = await bash.exec(`printf '你好' | extension-echo 'hello world' > /result; cat /result | wc -c`)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('17')
    expect(invoke).toHaveBeenCalledWith('extension-echo', { args: ['hello world'], stdin: '你好' })
  })

  it('preserves exit status and stderr in shell conditionals', async () => {
    const bash = new Bash({ customCommands: [createProxyCommand('extension-fail', async () => ({
      stdout: '', stderr: 'failed\n', exitCode: 7,
    }))] })
    expect(await bash.exec('extension-fail && echo wrong')).toMatchObject({ exitCode: 7, stderr: 'failed\n', stdout: '' })
    expect(await bash.exec('extension-fail || echo recovered')).toMatchObject({ exitCode: 0, stdout: 'recovered\n' })
  })

  it('returns a shell error when invoke throws or stdin is not UTF-8', async () => {
    const invoke = vi.fn(async () => { throw new Error('disconnected') })
    const bash = new Bash({ files: { '/binary': new Uint8Array([255]) }, customCommands: [createProxyCommand('extension-echo', invoke)] })
    expect(await bash.exec('extension-echo')).toMatchObject({ exitCode: 1, stderr: 'extension-echo: disconnected\n' })
    invoke.mockClear()
    expect((await bash.exec('cat /binary | extension-echo')).exitCode).toBe(1)
    expect(invoke).not.toHaveBeenCalled()
  })
})
