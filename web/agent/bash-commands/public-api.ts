import { bashCommandRegistry, type ExternalBashCommand } from './registry'

export interface BashCommandAPI {
  registerCommand(command: ExternalBashCommand): () => void
}

declare global {
  interface Window {
    creatorWeave?: {
      bash?: BashCommandAPI
    }
  }
}

/** Install once per page; command registrations survive React remounts. */
export function installBashCommandAPI(): void {
  if (typeof window === 'undefined') return
  window.creatorWeave ??= {}
  if (window.creatorWeave.bash) return
  window.creatorWeave.bash = {
    registerCommand: command => bashCommandRegistry.registerCommand(command),
  }
  // Page-lifetime monitor: removal does not depend on extension unload callbacks.
  window.setInterval(() => { void bashCommandRegistry.refresh() }, 15000)
  window.dispatchEvent(new Event('creatorweave:bash-ready'))
}
