import { useSettingsStore } from '@/store/settings.store'
import { useWorkspaceStore } from '@/store/workspace.store'
import { useProjectStore } from '@/store/project.store'
import { connectAdapterHost } from './adapter-host'
import { createWorkspaceToolHost } from './workspace-tool-host'

/** Expose workspace tools. Adapter files and catalog lifecycle belong to the extension. */
export function startWorkspaceToolHost(): () => void {
  let stopped = false
  let previous = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let connection: ReturnType<typeof connectAdapterHost> | null = null
  let bindingKey = ''
  let epoch = 0
  const reset = () => {
    epoch++
    connection?.stop()
    connection = null
    previous = ''
    bindingKey = ''
  }
  // Cancel immediately on workspace/project switches or feature withdrawal.
  let workspaceId = useWorkspaceStore.getState().activeWorkspaceId
  let projectId = useProjectStore.getState().activeProjectId
  let enabled = useSettingsStore.getState().enableWebMCP
  const subscriptions = [
    useWorkspaceStore.subscribe(state => {
      if (state.activeWorkspaceId !== workspaceId || state.isLoading) { workspaceId = state.activeWorkspaceId; reset() }
    }),
    useProjectStore.subscribe(state => {
      if (state.activeProjectId !== projectId) { projectId = state.activeProjectId; reset() }
    }),
    useSettingsStore.subscribe(state => {
      if (state.enableWebMCP !== enabled) { enabled = state.enableWebMCP; reset() }
    }),
  ]
  const sync = async () => {
    try {
      const bridge = (window as unknown as { __agentWeb?: { ready: boolean; supportsAdapterWorkflows?: boolean } }).__agentWeb
      if (!bridge?.ready || !bridge.supportsAdapterWorkflows || !enabled) { reset(); return }
      const host = createWorkspaceToolHost()
      if (!host) { reset(); return }
      const nextKey = JSON.stringify([host.workspaceId, host.binding])
      if (nextKey !== bindingKey) { reset(); bindingKey = nextKey }
      if (!connection) {
        connection = connectAdapterHost(host, () => { connection = null; previous = ''; epoch++ })
      }
      const currentConnection = connection
      const currentEpoch = epoch
      if (stopped || epoch !== currentEpoch) return
      const snapshot = JSON.stringify(host.names())
      if (snapshot === previous) return
      await currentConnection.attach()
      if (!stopped && epoch === currentEpoch) previous = snapshot
    } catch (error) {
      if (!stopped) console.warn('[WebMCP adapters] Sync failed:', error)
    } finally {
      if (!stopped) timer = setTimeout(() => { void sync() }, 3000)
    }
  }
  void sync()
  return () => { stopped = true; reset(); if (timer !== null) clearTimeout(timer); subscriptions.forEach(unsubscribe => unsubscribe()) }
}
