import type { Command } from 'just-bash'
import { readAdapter } from '@/webmcp/adapters'

export const webmcpCommand: Command = {
  name: 'webmcp',
  async execute(args, context) {
    if (args.length !== 2 || args[0] !== 'validate') {
      return { stdout: '', stderr: 'Usage: webmcp validate <adapter-directory>\n', exitCode: 2 }
    }
    try {
      const path = context.fs.resolvePath(context.cwd, args[1])
      const adapter = await readAdapter(context.fs, path)
      return { stdout: `Valid WebMCP adapter: ${adapter.name} (${adapter.origin})\n`, stderr: '', exitCode: 0 }
    } catch (error) {
      return { stdout: '', stderr: `webmcp: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 }
    }
  },
}
