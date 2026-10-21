import { isTrustedCreatorWeaveSenderUrl } from '@creatorweave/shared'
import { BrowserError } from './errors'
import { browserManual, browserRequestTimeout, invokeBrowserCommand, type CommandInput } from './command'

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
  const pending = new Map<string, CommandInput>()
  const cancel = (event?: Event) => {
    const inputs = (event as CustomEvent<{ inputs?: CommandInput[] }> | undefined)?.detail?.inputs
    for (const [requestId, input] of pending) {
      if (inputs && !inputs.includes(input)) continue
      void send('browser_command_cancel', { requestId }, 2000).catch(() => {})
    }
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
          pending.set(requestId, input)
          try {
            const response = await send('browser_command', { requestId, request }, Math.max(35000, browserRequestTimeout(request) + 5000))
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
