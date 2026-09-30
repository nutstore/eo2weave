import { validatePackageSnapshot, parseWorkflow } from '@creatorweave/shared/webmcp-adapter'
import { matchesToolUrl } from '@creatorweave/shared/webmcp-url'
import { createWorkflow, type WorkflowStep } from '@creatorweave/shared/webmcp-workflow'
import { registerPageTools } from './register-tools'

/** Per-document registrations; snapshots are serialized to avoid stale async writes. */
export function createAdapterInjector(getUrl: () => string) {
  const active = new Map<string, { fingerprint: string; controller: AbortController }>()
  let queue = Promise.resolve()
  return (snapshot: unknown): Promise<void> => {
    const sync = async () => {
      const packages = validatePackageSnapshot(snapshot)
      const tools = packages.flatMap(pkg => pkg.manifest.tools
        .filter(tool => matchesToolUrl(tool.urlRegex, getUrl()))
        .map(tool => ({ ...tool, name: `${pkg.manifest.id}.${tool.name}`, source: pkg.sources[tool.path] })))
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
          const { expression, contracts } = parseWorkflow(tool.source)
          // Page CSP applies to compilation. Schemas come from parsed JSON literals.
          const functions = new Function(`"use strict"; return (${expression});`)() as WorkflowStep[]
          const steps = functions.map((step, index) => ({ ...step, ...contracts[index] }))
          const execute = createWorkflow(steps)
          await registerPageTools([{
            name: tool.name,
            description: tool.description,
            inputSchema: steps[0].inputSchema as Record<string, unknown>,
            annotations: {},
            execute: args => {
              if (!matchesToolUrl(tool.urlRegex, getUrl())) throw new Error('The current URL no longer matches this tool')
              return execute(args, controller.signal)
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
