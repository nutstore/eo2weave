import { isTrustedCreatorWeaveSenderUrl } from '@creatorweave/shared'
import { BrowserError } from './errors'
import { browserManual, invokeBrowserCommand, type CommandInput } from './command'

type Bridge = (type: string, payload: Record<string, unknown>, timeout?: number) => Promise<any>
type PageAPI = { bash?: { registerCommand(command: {
  manifest: { name: string; description: string; manual: string }
  isAlive(): Promise<boolean>
  invoke(input: CommandInput): Promise<{ stdout: string; stderr: string; exitCode: number }>
}): () => void } }

export function installBrowserCommand(send: Bridge): () => void {
  if (!isTrustedCreatorWeaveSenderUrl(location.href)) return () => {}
  let unregister: (() => void) | undefined
  let disposed = false
  const pending = new Set<string>()
  const cancel = () => {
    for (const requestId of pending) void send('browser_command_cancel', { requestId }, 2000).catch(() => {})
  }
  window.addEventListener('creatorweave:bash-cancel', cancel)
  window.addEventListener('pagehide', cancel)
  const register = () => {
    if (disposed) return
    const api = (window as Window & { creatorWeave?: PageAPI }).creatorWeave?.bash
    if (!api) return
    unregister?.()
    unregister = api.registerCommand({
      manifest: { name: 'browser', description: 'Control browser tabs and pages; all results are JSON. Run browser help for commands.', manual: browserManual },
      async isAlive() {
        if (disposed) return false
        const result = await send('browser_command_ping', {}, 2000)
        return result?.ok === true
      },
      async invoke(input) {
        return invokeBrowserCommand(input, async request => {
          if (disposed) throw new Error('Browser extension provider disposed')
          const requestId = crypto.randomUUID()
          pending.add(requestId)
          try {
            const response = await send('browser_command', { requestId, request }, 35000)
            if (!response?.ok) throw new BrowserError(
              typeof response?.error === 'string' ? response.error : response?.error?.message ?? 'Browser extension unavailable',
              response?.error?.details,
            )
            return response.result
          } finally {
            pending.delete(requestId)
            // Also covers bridge timeout: background work must not be orphaned.
            void send('browser_command_cancel', { requestId }, 2000).catch(() => {})
          }
        })
      },
    })
  }
  window.addEventListener('creatorweave:bash-ready', register)
  register()
  return () => {
    disposed = true
    cancel()
    window.removeEventListener('creatorweave:bash-cancel', cancel)
    window.removeEventListener('pagehide', cancel)
    window.removeEventListener('creatorweave:bash-ready', register)
    unregister?.()
  }
}
