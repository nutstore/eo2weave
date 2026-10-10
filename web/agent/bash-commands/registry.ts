/** Public, page-context contract. Extensions own all communication inside invoke. */
export interface BashCommandManifest {
  name: string
  description: string
  manual: string
}

export interface BashCommandInput {
  args: string[]
  stdin: string
}

export interface BashCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface ExternalBashCommand {
  manifest: BashCommandManifest
  invoke(input: BashCommandInput): Promise<BashCommandResult>
  /** Probe the extension connection, not merely the injected page object. */
  isAlive(): Promise<boolean>
}

export class BashCommandRegistry {
  private commands = new Map<string, ExternalBashCommand>()
  private probes = new WeakMap<ExternalBashCommand, Promise<boolean>>()

  constructor(private probeTimeoutMs = 3000) {}

  registerCommand(command: ExternalBashCommand): () => void {
    const manifest = command?.manifest
    if (!manifest || typeof manifest.name !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(manifest.name) ||
        typeof manifest.description !== 'string' || typeof manifest.manual !== 'string' ||
        typeof command.invoke !== 'function' || typeof command.isAlive !== 'function') {
      throw new TypeError('Invalid bash command: expected manifest { name, description, manual } and invoke/isAlive')
    }
    // Copy the declaration and bind invoke to preserve the extension's own state.
    const entry = {
      manifest: { ...manifest },
      invoke: command.invoke.bind(command),
      isAlive: command.isAlive.bind(command),
    }
    this.commands.set(manifest.name, entry)
    return () => {
      // An older registration must not remove its replacement.
      if (this.commands.get(entry.manifest.name) === entry) this.commands.delete(entry.manifest.name)
    }
  }

  /** Web owns expiry: missing, rejected or timed-out probes remove the command. */
  checkAlive(command: ExternalBashCommand): Promise<boolean> {
    const existing = this.probes.get(command)
    if (existing) return existing
    const probe = new Promise<boolean>(resolve => {
      let settled = false
      const finish = (alive: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!alive && this.commands.get(command.manifest.name) === command) {
          this.commands.delete(command.manifest.name)
        }
        resolve(alive)
      }
      const timer = setTimeout(() => finish(false), this.probeTimeoutMs)
      Promise.resolve().then(() => command.isAlive()).then(
        alive => finish(alive === true),
        () => finish(false),
      )
    }).finally(() => { this.probes.delete(command) })
    this.probes.set(command, probe)
    return probe
  }

  async refresh(): Promise<void> {
    await Promise.all(Array.from(this.commands.values(), command => this.checkAlive(command)))
  }

  snapshot(): Map<string, ExternalBashCommand> {
    return new Map(this.commands)
  }

  describe(): string {
    return Array.from(this.commands.values(), ({ manifest }) =>
      `Command: ${manifest.name}\nDescription: ${manifest.description}\nManual:\n${manifest.manual}`,
    ).join('\n\n')
  }
}

export const bashCommandRegistry = new BashCommandRegistry()
