import { validateAdapterSnapshot, workflowExpression } from '@creatorweave/shared/webmcp-adapter'
import { runWorkflow, type WorkflowStep } from '@creatorweave/shared/webmcp-workflow'
import { registerPageTools } from './register-tools'

/** Per-document registrations; snapshots are serialized to avoid stale async writes. */
export function createAdapterInjector(origin: string) {
  const active = new Map<string, { fingerprint: string; controller: AbortController }>()
  let queue = Promise.resolve()
  return (snapshot: unknown): Promise<void> => {
    const sync = async () => {
      const adapters = validateAdapterSnapshot(snapshot).filter(adapter => adapter.origin === origin)
      const wanted = new Map(adapters.map(adapter => [adapter.name, JSON.stringify(adapter)]))
      for (const [name, registration] of active) {
        if (wanted.get(name) === registration.fingerprint) continue
        registration.controller.abort()
        active.delete(name)
      }
      const failures: string[] = []
      for (const adapter of adapters) {
        if (active.has(adapter.name)) continue
        const controller = new AbortController()
        try {
          // Parse the literal export once. Page CSP applies to this compilation.
          const steps = new Function(`"use strict"; return (${workflowExpression(adapter.source)});`)() as WorkflowStep[]
          await registerPageTools([{
            name: adapter.name,
            description: adapter.description,
            inputSchema: adapter.inputSchema,
            annotations: {},
            execute: args => runWorkflow(steps, args, controller.signal),
          }], controller)
          active.set(adapter.name, { fingerprint: wanted.get(adapter.name)!, controller })
        } catch (error) {
          controller.abort()
          failures.push(`${adapter.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (failures.length) throw new Error(failures.join('\n'))
    }
    const result = queue.then(sync)
    queue = result.catch(() => {})
    return result
  }
}
