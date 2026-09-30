import type { Command } from 'just-bash'
import { readPackage } from '@/webmcp/adapters'

export const webmcpCommand: Command = {
  name: 'webmcp',
  async execute(args, context) {
    if (args.length !== 2 || args[0] !== 'validate') {
      return { stdout: '', stderr: 'Usage: webmcp validate <package-directory>\n', exitCode: 2 }
    }
    try {
      const path = context.fs.resolvePath(context.cwd, args[1])
      const pkg = await readPackage(context.fs, path)
      return { stdout: `Valid WebMCP package: ${pkg.manifest.id}@${pkg.manifest.version} (${pkg.manifest.tools.length} tools)\n`, stderr: '', exitCode: 0 }
    } catch (error) {
      return { stdout: '', stderr: `webmcp: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 }
    }
  },
}
