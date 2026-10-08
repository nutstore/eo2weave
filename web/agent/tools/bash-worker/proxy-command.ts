import { latin1FromBytes, type Command } from 'just-bash'
import type { BashCommandInput, BashCommandResult } from '@/agent/bash-commands/registry'

export function createProxyCommand(
  name: string,
  invoke: (name: string, input: BashCommandInput) => Promise<BashCommandResult>,
): Command {
  return {
    name,
    async execute(args, context) {
      try {
        const bytes = Uint8Array.from(latin1FromBytes(context.stdin), char => char.charCodeAt(0))
        const stdin = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        return await invoke(name, { args, stdin })
      } catch (error) {
        return { stdout: '', stderr: `${name}: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 }
      }
    },
  }
}
