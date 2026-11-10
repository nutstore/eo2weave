/**
 * MCP Settings Component
 *
 * UI for managing MCP (Model Context Protocol) server configurations.
 * Allows adding, editing, deleting, and testing MCP server connections.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  Plus,
  Trash2,
  Edit,
  X,
  RefreshCw,
  Globe,
  Eye,
  EyeOff,
  Loader2,
  Power,
  Check,
  Plug,
  Zap,
  AlertTriangle,
  Download,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import { getMCPManager } from '@/mcp'
import { hasMCPNetworkV2 } from '@/mcp/extension-fetch'
import type { MCPServerConfig, MCPConnectionState } from '@/mcp/mcp-types'
import { useT } from '@/i18n'
import { useExtensionStore } from '@/store/extension.store'
import { ShieldCheck } from 'lucide-react'
import { useTrustedSourceStore } from '@/store/trusted-source.store'
import { ExternalTrustCard } from '@/components/external-tools/ExternalTrustCard'

type TransportType = 'legacy_sse' | 'streamable_http'

interface MCPServerItem extends MCPServerConfig {
  connectionStatus?: MCPConnectionState
  tools?: string[]
  error?: string
}

interface ServerFormData {
  id: string
  name: string
  description: string
  url: string
  protocolMode: 'auto' | 'legacy'
  transport: TransportType
  enabled: boolean
  token: string
  timeout: string
  type: 'builtin' | 'user' | 'project'
}

const EMPTY_FORM: ServerFormData = {
  id: '',
  name: '',
  description: '',
  url: '',
  transport: 'streamable_http',
  protocolMode: 'auto',
  enabled: true,
  token: '',
  timeout: '30000',
  type: 'user',
}

export function MCPSettings() {
  const mcpManager = getMCPManager()
  const t = useT()
  const extensionStatus = useExtensionStore((state) => state.status)
  const extensionInstalled = extensionStatus === 'installed'
  const tf = useCallback(
    (key: string, fallback: string, params?: Record<string, string | number>) => {
      const value = t(key, params)
      return !value || value === key ? fallback : value
    },
    [t]
  )
  const transportLabels: Record<TransportType, string> = {
    legacy_sse: tf('mcp.tasks.legacySse', 'Legacy SSE (GET stream)'),
    streamable_http: tf('mcp.form.transport.streamableHttp', 'Streamable HTTP'),
  }

  // State
  const [servers, setServers] = useState<MCPServerItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Form state
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingServer, setEditingServer] = useState<string | null>(null)
  const [formData, setFormData] = useState<ServerFormData>(EMPTY_FORM)
  const [showToken, setShowToken] = useState(false)
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [connectingServerId, setConnectingServerId] = useState<string | null>(null)

  // Global default-trust switch state — only for the per-server status
  // badge; the switch itself lives in the shared ExternalTrustCard above.
  const defaultTrustExternal = useTrustedSourceStore((state) => state.defaultTrustExternal)

  const loadServers = useCallback(async () => {
    setLoading(true)
    try {
      await mcpManager.initialize()

      const allServers = mcpManager.getAllServers()
      const statuses = mcpManager.getAllConnectionStatuses()

      const serverItems: MCPServerItem[] = allServers.map((server) => {
        const status = statuses.find((s) => s.serverId === server.id)
        return {
          ...server,
          connectionStatus: status?.state || 'disconnected',
          tools: status?.tools?.map((t) => t.name) || [],
          error: status?.error,
        }
      })

      setServers(serverItems)
    } catch (error) {
      console.error('[MCPSettings] Failed to load servers:', error)
      toast.error('Failed to load MCP servers')
    } finally {
      setLoading(false)
    }
  }, [mcpManager])

  const refreshConnectionStatuses = useCallback(() => {
    setServers((prev) => {
      let changed = false
      const next = prev.map((server) => {
        const status = mcpManager.getConnectionStatus(server.id)
        const nextStatus = status?.state || 'disconnected'
        const nextTools = status?.tools?.map((t) => t.name) || []
        const nextError = status?.error

        const toolsChanged =
          (server.tools?.length || 0) !== nextTools.length ||
          (server.tools || []).some((name, index) => name !== nextTools[index])

        if (
          server.connectionStatus !== nextStatus ||
          server.error !== nextError ||
          toolsChanged
        ) {
          changed = true
        }

        return {
          ...server,
          connectionStatus: nextStatus,
          tools: nextTools,
          error: nextError,
        }
      })
      return changed ? next : prev
    })
  }, [mcpManager])

  // Load servers on mount
  useEffect(() => {
    loadServers()
  }, [loadServers])

  // Refresh connection statuses periodically
  useEffect(() => {
    const interval = setInterval(() => {
      refreshConnectionStatuses()
    }, 5000)

    return () => clearInterval(interval)
  }, [refreshConnectionStatuses])

  // Form handling
  const openAddForm = () => {
    setFormData(EMPTY_FORM)
    setFormErrors({})
    setShowAddForm(true)
    setEditingServer(null)
  }

  const openEditForm = (server: MCPServerItem) => {
    setFormData({
      id: server.id,
      name: server.name,
      description: server.description || '',
      url: server.url,
      transport: server.transport as TransportType,
      protocolMode: server.protocolMode ?? 'auto',
      enabled: server.enabled,
      token: server.token || '',
      timeout: String(server.timeout || 30000),
      type: server.type || 'user',
    })
    setFormErrors({})
    setEditingServer(server.id)
    setShowAddForm(true)
  }

  const closeForm = () => {
    setShowAddForm(false)
    setEditingServer(null)
    setFormData(EMPTY_FORM)
    setFormErrors({})
  }

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {}

    const validation = mcpManager.validateServerId(formData.id)
    if (formData.id && !validation.valid) {
      errors.id = validation.error || tf('mcp.validation.invalidServerId', 'Invalid server ID')
    }

    if (!formData.name.trim()) {
      errors.name = tf('mcp.validation.nameRequired', 'Please enter server name')
    }
    if (!formData.url.trim()) {
      errors.url = tf('mcp.validation.urlRequired', 'Please enter server URL')
    } else {
      try {
        new URL(formData.url)
      } catch {
        errors.url = tf('mcp.validation.urlInvalid', 'Please enter a valid URL')
      }
    }

    const timeout = parseInt(formData.timeout)
    if (isNaN(timeout) || timeout < 1000 || timeout > 300000) {
      errors.timeout = tf('mcp.validation.timeoutRange', 'Timeout must be between 1000-300000ms')
    }

    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleSave = async () => {
    if (!validateForm()) {
      return
    }

    setSaving(true)
    try {
      if (editingServer) {
        await mcpManager.updateServer(editingServer, {
          name: formData.name,
          description: formData.description || undefined,
          url: formData.url,
          transport: formData.transport,
          protocolMode: formData.protocolMode,
          enabled: formData.enabled,
          token: formData.token || undefined,
          timeout: parseInt(formData.timeout),
          type: formData.type,
        })
        toast.success(tf('mcp.toast.updated', 'Server configuration updated'))
      } else {
        await mcpManager.addServer({
          id: formData.id,
          name: formData.name,
          description: formData.description || undefined,
          url: formData.url,
          transport: formData.transport,
          protocolMode: formData.protocolMode,
          enabled: formData.enabled,
          token: formData.token || undefined,
          timeout: parseInt(formData.timeout),
          type: formData.type,
        })
        toast.success(tf('mcp.toast.added', 'Server added'))
      }

      await loadServers()
      closeForm()
    } catch (error) {
      console.error('[MCPSettings] Failed to save server:', error)
      toast.error(error instanceof Error ? error.message : tf('mcp.toast.saveFailed', 'Save failed'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (serverId: string) => {
    if (!confirm(tf('mcp.confirmDelete', 'Are you sure you want to delete this MCP server?'))) {
      return
    }

    try {
      await mcpManager.removeServer(serverId)
      await loadServers()
      toast.success(tf('mcp.toast.deleted', 'Server deleted'))
    } catch (error) {
      console.error('[MCPSettings] Failed to delete server:', error)
      toast.error(tf('mcp.toast.deleteFailed', 'Delete failed'))
    }
  }

  const handleToggleEnabled = async (serverId: string, enabled: boolean) => {
    try {
      await mcpManager.setEnabled(serverId, enabled)
      await loadServers()
    } catch (error) {
      console.error('[MCPSettings] Failed to toggle server:', error)
      toast.error(tf('mcp.toast.updateStatusFailed', 'Failed to update status'))
    }
  }

  const handleConnect = async (serverId: string) => {
    setConnectingServerId(serverId)
    try {
      await mcpManager.connect(serverId)
      refreshConnectionStatuses()
      toast.success(tf('mcp.toast.connected', 'Connected successfully'))
    } catch (error) {
      console.error('[MCPSettings] Failed to connect server:', error)
      const msg = error instanceof Error ? error.message : tf('mcp.toast.connectFailed', 'Connection failed')
      toast.error(msg)
      refreshConnectionStatuses()
    } finally {
      setConnectingServerId((current) => (current === serverId ? null : current))
    }
  }

  const handleDisconnect = (serverId: string) => {
    try {
      mcpManager.disconnect(serverId)
      refreshConnectionStatuses()
      toast.success(tf('mcp.toast.disconnected', 'Disconnected'))
    } catch (error) {
      console.error('[MCPSettings] Failed to disconnect server:', error)
      toast.error(tf('mcp.toast.disconnectFailed', 'Disconnect failed'))
    }
  }

  // ─── Export / Import ─────────────────────────────────────────────────

  const handleExport = useCallback(() => {
    const exportData = servers.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      url: s.url,
      transport: s.transport,
      protocolMode: s.protocolMode ?? 'auto',
      enabled: s.enabled,
      token: s.token,
      timeout: s.timeout,
      type: s.type,
    }))

    const json = JSON.stringify(exportData, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mcp-servers-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    toast.success(tf('mcp.toast.exported', 'Exported {count} servers', { count: exportData.length }))
  }, [servers, tf])

  const handleImport = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return

      try {
        const text = await file.text()
        const data = JSON.parse(text)

        if (!Array.isArray(data)) {
          toast.error(tf('mcp.toast.invalidFormat', 'Invalid format: expected an array'))
          return
        }

        let imported = 0
        let skipped = 0
        const existingIds = new Set(servers.map((s) => s.id))

        for (const item of data) {
          if (!item.id || !item.name || !item.url) {
            skipped++
            continue
          }
          if (existingIds.has(item.id)) {
            skipped++
            continue
          }
          try {
            await mcpManager.addServer({
              id: item.id,
              name: item.name,
              description: item.description || undefined,
              url: item.url,
              transport: item.transport || 'streamable_http',
              protocolMode: item.protocolMode === 'legacy' ? 'legacy' : 'auto',
              enabled: item.enabled ?? true,
              token: item.token || undefined,
              timeout: item.timeout || 30000,
              type: item.type || 'user',
            })
            imported++
          } catch {
            skipped++
          }
        }

        await loadServers()
        toast.success(tf('mcp.toast.imported', 'Imported {imported}, skipped {skipped}', { imported, skipped }))
      } catch {
        toast.error(tf('mcp.toast.importFailed', 'Failed to parse import file'))
      }
    }
    input.click()
  }, [mcpManager, servers, loadServers, tf])

  // Server ID validation indicator
  const ServerIdValidation = () => {
    if (!formData.id) return null
    if (formData.id === editingServer) return null

    const validation = mcpManager.validateServerId(formData.id)
    if (!validation?.valid) {
      return <p className="mt-1 text-xs text-danger">{validation.error}</p>
    }
    if (servers.some((s) => s.id === formData.id && s.id !== editingServer)) {
      return <p className="mt-1 text-xs text-danger">{tf('mcp.validation.serverIdExists', 'Server ID already exists')}</p>
    }
    return <p className="mt-1 text-xs text-success">✓</p>
  }

  // ─── Status helpers ──────────────────────────────────────────────────

  const statusDot = (s?: MCPConnectionState) => {
    const base = 'inline-block h-2 w-2 rounded-full shrink-0'
    switch (s) {
      case 'connected': return `${base} bg-success`
      case 'connecting': return `${base} bg-muted animate-pulse`
      case 'error': return `${base} bg-danger`
      default: return `${base} bg-neutral-300 dark:bg-neutral-600`
    }
  }

  const statusLabel = (s?: MCPConnectionState) => {
    switch (s) {
      case 'connected': return tf('mcp.status.connected', 'Connected')
      case 'connecting': return tf('mcp.status.connecting', 'Connecting…')
      case 'error': return tf('mcp.status.error', 'Error')
      default: return tf('mcp.status.disconnected', 'Disconnected')
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────

  return (
    <div className="mcp-settings space-y-4">

      {/* Global trust switch (shared card, always first) */}
      <ExternalTrustCard t={(key) => tf(key, key)} />
      {extensionInstalled && !hasMCPNetworkV2() ? <p role="status" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">{t('mcp.tasks.extensionUpgrade')}</p> : null}

      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Plug className="h-4 w-4 text-secondary" />
          <h3 className="text-sm font-semibold text-secondary dark:text-foreground">
            {tf('mcp.title', 'MCP Servers')}
          </h3>
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-secondary dark:bg-neutral-800 dark:text-muted">
            {servers.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {!showAddForm && (
            <button
              onClick={openAddForm}
              className="flex h-8 items-center gap-1.5 rounded-md bg-primary-600 px-3 text-xs font-medium text-white transition-colors hover:bg-primary-700"
            >
              <Plus className="h-3.5 w-3.5" />
              {tf('mcp.addServer', 'Add Server')}
            </button>
          )}
          <button
            onClick={async () => {
              const enabled = servers.filter((s) => s.enabled && s.connectionStatus !== 'connected' && s.connectionStatus !== 'connecting')
              if (enabled.length === 0) {
                toast.info(tf('mcp.toast.noServersToConnect', 'No enabled servers to connect'))
                return
              }
              toast.info(tf('mcp.toast.connectingAll', 'Connecting {count} servers…', { count: enabled.length }))
              try {
                await mcpManager.connectAllEnabled()
                await loadServers()
                toast.success(tf('mcp.toast.allConnected', 'All servers connected'))
              } catch {
                await loadServers()
              }
            }}
            disabled={servers.filter((s) => s.enabled && s.connectionStatus !== 'connected' && s.connectionStatus !== 'connecting').length === 0}
            className="text-tertiary flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-primary disabled:opacity-30"
            title={tf('mcp.connectAll', 'Connect All')}
          >
            <Zap className="h-4 w-4" />
          </button>
          <button
            onClick={loadServers}
            className="text-tertiary flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-primary"
            title={tf('common.refresh', 'Refresh')}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            onClick={handleExport}
            disabled={servers.length === 0}
            className="text-tertiary flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-primary disabled:opacity-30"
            title={tf('mcp.export', 'Export servers')}
          >
            <Download className="h-4 w-4" />
          </button>
          <button
            onClick={handleImport}
            className="text-tertiary flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-primary"
            title={tf('mcp.import', 'Import servers')}
          >
            <Upload className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ── Add/Edit Form ───────────────────────────────────────────── */}
      {showAddForm && (
        <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800/50">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-secondary dark:text-muted">
              {editingServer ? tf('mcp.editServer', 'Edit Server') : tf('mcp.addServer', 'New Server')}
            </h4>
            <button onClick={closeForm} className="text-tertiary rounded p-1 hover:bg-muted hover:text-primary">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {/* Server ID */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-secondary dark:text-muted">
                {tf('mcp.form.serverId', 'Server ID')} <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                value={formData.id}
                onChange={(e) => setFormData({ ...formData, id: e.target.value.replace(/\s/g, '') })}
                placeholder="my-server"
                disabled={!!editingServer}
                className={`w-full rounded-md border bg-transparent px-3 py-1.5 font-mono text-sm focus:border-primary-500 focus:outline-none disabled:opacity-50 dark:text-primary-foreground ${
                  formErrors.id ? 'border-danger' : 'border-neutral-200 dark:border-neutral-700'
                }`}
              />
              <ServerIdValidation />
            </div>

            {/* Name */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-secondary dark:text-muted">
                {tf('mcp.form.displayName', 'Display Name')} <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="My MCP Server"
                className={`w-full rounded-md border bg-transparent px-3 py-1.5 text-sm focus:border-primary-500 focus:outline-none dark:text-primary-foreground ${
                  formErrors.name ? 'border-danger' : 'border-neutral-200 dark:border-neutral-700'
                }`}
              />
              {formErrors.name && <p className="text-xs text-danger">{formErrors.name}</p>}
            </div>

            {/* URL */}
            <div className="space-y-1 sm:col-span-2">
              <label className="text-xs font-medium text-secondary dark:text-muted">
                {tf('mcp.form.serverUrl', 'Server URL')} <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                value={formData.url}
                onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                placeholder="http://localhost:8080/mcp"
                className={`w-full rounded-md border bg-transparent px-3 py-1.5 font-mono text-sm focus:border-primary-500 focus:outline-none dark:text-primary-foreground ${
                  formErrors.url ? 'border-danger' : 'border-neutral-200 dark:border-neutral-700'
                }`}
              />
              {formErrors.url && <p className="text-xs text-danger">{formErrors.url}</p>}
            </div>

            {/* Transport */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-secondary dark:text-muted">
                {tf('mcp.form.transportType', 'Transport')}
              </label>
              <select
                value={formData.transport}
                onChange={(e) => setFormData({ ...formData, transport: e.target.value as TransportType })}
                className="w-full rounded-md border border-neutral-200 bg-transparent px-3 py-1.5 text-sm focus:border-primary-500 focus:outline-none dark:border-neutral-700 dark:text-primary-foreground"
              >
                <option value="streamable_http">{transportLabels.streamable_http}</option>
                <option value="legacy_sse">{transportLabels.legacy_sse}</option>
              </select>
            </div>

            <label className="space-y-1 text-xs font-medium">
              <span>{t('mcp.tasks.protocolMode')}</span>
              <select value={formData.protocolMode} onChange={event => setFormData({ ...formData, protocolMode: event.target.value as 'auto' | 'legacy' })}
                className="w-full rounded-md border border-neutral-200 bg-transparent px-3 py-1.5 dark:border-neutral-700">
                <option value="auto">{t('mcp.tasks.protocolAuto')}</option>
                <option value="legacy">{t('mcp.tasks.protocolLegacy')}</option>
              </select>
            </label>

            {/* Timeout */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-secondary dark:text-muted">
                {tf('mcp.form.timeoutMs', 'Timeout (ms)')}
              </label>
              <input
                type="number"
                value={formData.timeout}
                onChange={(e) => setFormData({ ...formData, timeout: e.target.value })}
                min="1000"
                max="300000"
                step="1000"
                className={`w-full rounded-md border bg-transparent px-3 py-1.5 text-sm focus:border-primary-500 focus:outline-none dark:text-primary-foreground ${
                  formErrors.timeout ? 'border-danger' : 'border-neutral-200 dark:border-neutral-700'
                }`}
              />
              {formErrors.timeout && <p className="text-xs text-danger">{formErrors.timeout}</p>}
            </div>

            {/* Description */}
            <div className="space-y-1 sm:col-span-2">
              <label className="text-xs font-medium text-secondary dark:text-muted">
                {tf('mcp.form.description', 'Description')}
              </label>
              <input
                type="text"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder={tf('mcp.form.descriptionPlaceholder', 'Optional description of this server')}
                className="w-full rounded-md border border-neutral-200 bg-transparent px-3 py-1.5 text-sm focus:border-primary-500 focus:outline-none dark:border-neutral-700 dark:text-primary-foreground"
              />
            </div>

            {/* Token */}
            <div className="space-y-1 sm:col-span-2">
              <label className="text-xs font-medium text-secondary dark:text-muted">
                {tf('mcp.form.authTokenOptional', 'Auth Token')}
              </label>
              <div className="relative">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={formData.token}
                  onChange={(e) => setFormData({ ...formData, token: e.target.value })}
                  placeholder={tf('mcp.form.tokenPlaceholder', 'Paste Bearer token if required')}
                  className="w-full rounded-md border border-neutral-200 bg-transparent px-3 py-1.5 pr-10 text-sm focus:border-primary-500 focus:outline-none dark:border-neutral-700 dark:text-primary-foreground"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="text-tertiary absolute right-3 top-1/2 -translate-y-1/2 hover:text-primary"
                >
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>

          {/* Form Actions */}
          <div className="flex items-center justify-end gap-2 border-t border-neutral-100 pt-3 dark:border-neutral-700">
            <button
              onClick={closeForm}
              className="rounded-md px-3 py-1.5 text-sm text-secondary transition-colors hover:bg-muted dark:text-muted"
            >
              {tf('common.cancel', 'Cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-md bg-primary-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:opacity-50"
            >
              {saving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {tf('mcp.saving', 'Saving…')}
                </>
              ) : (
                <>
                  <Check className="h-3.5 w-3.5" />
                  {editingServer ? tf('mcp.update', 'Update') : tf('mcp.add', 'Add')}
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* ── Extension Required Warning ────────────────────────────── */}
      {!extensionInstalled && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/20">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              {tf('mcp.extensionRequired', 'Browser extension required')}
            </p>
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400/80">
              {tf('mcp.extensionRequiredHint', 'MCP service connections require the eo2weave browser extension. Go to the Extension tab in Settings to install it.')}
            </p>
          </div>
        </div>
      )}

      {/* ── Server List ─────────────────────────────────────────────── */}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted" />
        </div>
      ) : servers.length === 0 && !showAddForm ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-neutral-200 py-12 dark:border-neutral-700">
          <Globe className="mb-3 h-8 w-8 text-neutral-300 text-neutral-600 text-neutral-600 dark:text-neutral-600" />
          <p className="text-sm font-medium text-secondary">{tf('mcp.empty.title', 'No MCP servers yet')}</p>
          <p className="mt-1 text-xs text-tertiary">{tf('mcp.empty.hint', 'Add a server to get started')}</p>
          <button
            onClick={openAddForm}
            className="mt-4 flex items-center gap-1.5 rounded-md bg-primary-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-primary-700"
          >
            <Plus className="h-3.5 w-3.5" />
            {tf('mcp.addServer', 'Add Server')}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {servers.map((server) => {
            const isConnected = server.connectionStatus === 'connected'
            const isError = server.connectionStatus === 'error'
            const isConnecting = server.connectionStatus === 'connecting'
            const toolCount = server.tools?.length || 0

            return (
              <div
                key={server.id}
                className={`group rounded-lg border transition-all ${
                  isError
                    ? 'border-danger/30 bg-danger/5 dark:border-danger/20 dark:bg-danger/5'
                    : isConnected
                      ? 'border-success/20 bg-success/5 dark:border-success/10 dark:bg-success/5'
                      : !server.enabled
                        ? 'border-neutral-200 bg-neutral-50 opacity-60 dark:border-neutral-700 dark:bg-neutral-800/30'
                        : 'border-neutral-200 bg-white hover:border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800/50 dark:hover:border-neutral-600'
                }`}
              >
                {/* Main row */}
                <div className="flex items-center gap-3 px-3 py-2.5">
                  {/* Status dot */}
                  <span className={statusDot(server.connectionStatus)} title={statusLabel(server.connectionStatus)} />

                  {/* Name + meta */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`truncate text-sm font-medium ${!server.enabled ? 'text-tertiary line-through' : 'text-secondary dark:text-foreground'}`}>
                        {server.name}
                      </span>
                      {server.type === 'builtin' && (
                        <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-secondary dark:bg-neutral-700 dark:text-muted">
                          {tf('mcp.badge.builtin', 'Builtin')}
                        </span>
                      )}
                      <label className="ml-1 flex shrink-0 items-center gap-1 text-[11px] text-tertiary" title={tf('settings.externalTrustToggle', 'Trust external tools by default')}>
                        <ShieldCheck
                          className={`h-3 w-3 ${
                            defaultTrustExternal
                              ? 'text-primary-600'
                              : 'text-neutral-400 dark:text-neutral-500'
                          }`}
                        />
                        {defaultTrustExternal
                          ? tf('settings.externalTrustOnShort', 'Trusted')
                          : tf('settings.externalTrustOffShort', 'Prompts')}
                      </label>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-tertiary">
                      <span className="truncate font-mono">{server.url}</span>
                      <span className="shrink-0 text-neutral-300 text-neutral-600 text-neutral-600 dark:text-neutral-600">·</span>
                      <span className="shrink-0">{transportLabels[server.transport as TransportType] || server.transport}</span>
                      {isConnected && toolCount > 0 && (
                        <>
                          <span className="shrink-0 text-neutral-300 text-neutral-600 text-neutral-600 dark:text-neutral-600">·</span>
                          <span className="flex shrink-0 items-center gap-0.5 text-success">
                            <Zap className="h-3 w-3" />
                            {toolCount} {tf('mcp.toolsLabel', 'tools')}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex shrink-0 items-center gap-1">
                    {/* Enable/Disable toggle */}
                    <button
                      onClick={() => handleToggleEnabled(server.id, !server.enabled)}
                      className={`flex h-7 w-7 items-center justify-center rounded-md transition-all ${
                        server.enabled
                          ? 'text-success hover:bg-success/10'
                          : 'text-neutral-300 hover:bg-neutral-100 text-neutral-600 text-neutral-600 dark:text-neutral-600 dark:hover:bg-neutral-700'
                      }`}
                      title={server.enabled ? tf('mcp.actions.clickToDisable', 'Disable') : tf('mcp.actions.clickToEnable', 'Enable')}
                    >
                      <Power className="h-3.5 w-3.5" />
                    </button>

                    {/* Connect / Disconnect */}
                    {server.enabled && !isConnected && !isConnecting && (
                      <button
                        onClick={() => handleConnect(server.id)}
                        disabled={connectingServerId === server.id}
                        className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-success transition-colors hover:bg-success/10 disabled:opacity-50"
                        title={isError ? tf('mcp.actions.reconnect', 'Reconnect') : tf('mcp.actions.connect', 'Connect')}
                      >
                        {connectingServerId === server.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        <span className="hidden sm:inline">{isError ? tf('mcp.actions.reconnect', 'Reconnect') : tf('mcp.actions.connect', 'Connect')}</span>
                      </button>
                    )}
                    {isConnecting && (
                      <span className="flex items-center gap-1 px-2 text-xs text-muted">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span className="hidden sm:inline">{tf('mcp.status.connecting', 'Connecting…')}</span>
                      </span>
                    )}
                    {isConnected && (
                      <button
                        onClick={() => handleDisconnect(server.id)}
                        className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-secondary transition-colors hover:bg-muted hover:text-primary"
                        title={tf('mcp.actions.disconnect', 'Disconnect')}
                      >
                        <Power className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">{tf('mcp.actions.disconnect', 'Disconnect')}</span>
                      </button>
                    )}

                    {/* Edit */}
                    <button
                      onClick={() => openEditForm(server)}
                      className="text-tertiary flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-primary"
                      title={tf('mcp.actions.editConfig', 'Edit')}
                    >
                      <Edit className="h-3.5 w-3.5" />
                    </button>

                    {/* Delete */}
                    <button
                      onClick={() => handleDelete(server.id)}
                      className="text-tertiary flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-danger/10 hover:text-danger"
                      title={tf('mcp.actions.deleteServer', 'Delete')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Error bar */}
                {isError && server.error && (
                  <div className="flex items-start gap-1.5 border-t border-danger/10 px-3 py-1.5">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-danger" />
                    <span className="text-xs text-danger">{server.error}</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
