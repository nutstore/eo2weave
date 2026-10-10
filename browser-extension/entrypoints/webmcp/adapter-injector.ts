import { parseDescriptors, type AdapterDescriptor } from '@creatorweave/shared/webmcp-adapter-protocol'
import { matchesToolUrl } from '@creatorweave/shared/webmcp-url'
import { registerPageTools } from './register-tools'

/** Page registrations are proxies. Workflow source never enters the MAIN world. */
export function createAdapterInjector(
  getUrl: () => string,
  invoke: (tool: AdapterDescriptor, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
) {
  const active = new Map<string, { fingerprint: string; controller: AbortController }>()
  let queue = Promise.resolve()
  return (snapshot: unknown): Promise<void> => {
    const sync = async () => {
      const tools = parseDescriptors(snapshot).filter(tool => matchesToolUrl(tool.urlRegex, getUrl()))
      const wanted = new Map(tools.map(tool => [tool.name, JSON.stringify(tool)]))
      for (const [name, registration] of active) {
        if (wanted.get(name) === registration.fingerprint) continue
        registration.controller.abort()
        active.delete(name)
      }
      const failures: string[] = []
      for (const tool of tools) {
        if (active.has(tool.name)) continue
        const controller = new AbortController()
        try {
          await registerPageTools([{
            name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: {},
            execute: args => {
              controller.signal.throwIfAborted()
              if (!matchesToolUrl(tool.urlRegex, getUrl())) throw new Error('The current URL no longer matches this tool')
              // Registration belongs to the page; execution belongs to the SW.
              // Removing a proxy must not cancel an already-triggered workflow.
              return invoke(tool, args, new AbortController().signal)
            },
          }], controller)
          active.set(tool.name, { fingerprint: wanted.get(tool.name)!, controller })
        } catch (error) {
          controller.abort()
          failures.push(`${tool.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (failures.length) throw new Error(failures.join('\n'))
    }
    const result = queue.then(sync)
    queue = result.catch(() => {})
    return result
  }
}
