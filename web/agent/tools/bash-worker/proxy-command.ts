import type { Command } from 'just-bash/browser'
import type { BashCommandInput, BashCommandResult } from '@/agent/bash-commands/registry'
import { latin1StringToBytes } from './bridge-shared'

export function createProxyCommand(
  name: string,
  invoke: (name: string, input: BashCommandInput) => Promise<BashCommandResult>,
): Command {
  return {
    name,
    async execute(args, context) {
      try {
        // ByteString is a Latin-1 byte buffer at runtime. The browser entry of
        // just-bash does not export the Node entry's latin1FromBytes helper.
        if (typeof context.stdin !== 'string') throw new TypeError('Expected a Bash byte string')
        const bytes = latin1StringToBytes(context.stdin)
        const stdin = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        return await invoke(name, { args, stdin })
      } catch (error) {
        return { stdout: '', stderr: `${name}: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 }
      }
    },
  }
}
