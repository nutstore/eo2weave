/**
 * MCP Server Repository
 *
 * SQLite-based storage for MCP (Model Context Protocol) server configurations
 */

import { getSQLiteDB } from '../sqlite-database'
import { normalizeMCPConfig } from '../../mcp/mcp-types'
import type { MCPServerConfig, MCPServerType, MCPTransportType } from '../../mcp/mcp-types'
import { parseJSON, toJSON, boolToInt, intToBool } from '../sqlite-database'

//=============================================================================
// Database Row Types
//=============================================================================

interface MCPServerRow {
  id: string
  name: string
  description: string | null
  url: string
  transport: string
  protocol_mode?: 'auto' | 'legacy'
  enabled: number
  token: string | null
  timeout: number
  retry_count: number | null
  retry_delay: number | null
  type: string
  env: string | null
  session_id: string | null
  created_at: number
  updated_at: number
}

//=============================================================================
// MCP Server Repository
//=============================================================================

export interface StoredMCPServer extends MCPServerConfig {
  createdAt: number
  updatedAt: number
}

export class MCPRepository {
  /**
   * Get all MCP servers
   */
  async findAll(): Promise<StoredMCPServer[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<MCPServerRow>('SELECT * FROM mcp_servers ORDER BY type, name')
    return rows.map((row) => this.rowToServer(row))
  }

  /**
   * Find server by ID
   */
  async findById(id: string): Promise<StoredMCPServer | null> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<MCPServerRow>('SELECT * FROM mcp_servers WHERE id = ?', [id])
    return row ? this.rowToServer(row) : null
  }

  /**
   * Find enabled servers only
   */
  async findEnabled(): Promise<StoredMCPServer[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<MCPServerRow>(
      'SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY type, name'
    )
    return rows.map((row) => this.rowToServer(row))
  }

  /**
   * Find by server type
   */
  async findByType(type: MCPServerType): Promise<StoredMCPServer[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<MCPServerRow>(
      'SELECT * FROM mcp_servers WHERE type = ? ORDER BY name',
      [type]
    )
    return rows.map((row) => this.rowToServer(row))
  }

  /**
   * Search servers by keyword in name or description
   */
  async search(keyword: string): Promise<StoredMCPServer[]> {
    const db = getSQLiteDB()
    const pattern = `%${keyword}%`
    const rows = await db.queryAll<MCPServerRow>(
      `SELECT * FROM mcp_servers
       WHERE name LIKE ? OR description LIKE ?
       ORDER BY type, name`,
      [pattern, pattern]
    )
    return rows.map((row) => this.rowToServer(row))
  }

  /**
   * Insert or update a server
   */
  async save(server: StoredMCPServer): Promise<void> {
    const db = getSQLiteDB()
    await db.execute(
      `INSERT INTO mcp_servers (id, name, description, url, transport, enabled,
                                token, timeout, retry_count, retry_delay, type, protocol_mode,
                                env, session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         url = excluded.url,
         transport = excluded.transport,
         enabled = excluded.enabled,
         token = excluded.token,
         timeout = excluded.timeout,
         retry_count = excluded.retry_count,
         retry_delay = excluded.retry_delay,
         type = excluded.type,
         protocol_mode = excluded.protocol_mode,
         env = excluded.env,
         session_id = excluded.session_id,
         updated_at = excluded.updated_at`,
      [
        server.id,
        server.name,
        server.description || null,
        server.url,
        server.transport === 'sse' ? 'streamable_http' : server.transport,
        boolToInt(server.enabled),
        server.token || null,
        server.timeout ?? 30000,
        server.retryCount ?? 3,
        server.retryDelay ?? 1000,
        server.type ?? 'user',
        server.protocolMode ?? 'auto',
        server.env ? toJSON(server.env) : null,
        server.sessionId || null,
        server.createdAt,
        server.updatedAt,
      ]
    )
  }

  /**
   * Toggle server enabled status
   */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?', [
      boolToInt(enabled),
      Date.now(),
      id,
    ])
  }

  /**
   * Update server fields
   */
  async update(
    id: string,
    updates: Partial<Omit<StoredMCPServer, 'id' | 'createdAt'>>
  ): Promise<void> {
    const existing = await this.findById(id)
    if (!existing) {
      throw new Error(`MCP server not found: ${id}`)
    }

    const merged: StoredMCPServer = {
      ...existing,
      ...updates,
      id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    }

    await this.save(merged)
  }

  /**
   * Delete a server by ID
   */
  async delete(id: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('DELETE FROM mcp_servers WHERE id = ?', [id])
  }

  /**
   * Delete all servers
   */
  async deleteAll(): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('DELETE FROM mcp_servers')
  }

  /**
   * Get server count by type
   */
  async getCountByType(): Promise<Record<MCPServerType, number>> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<{ type: MCPServerType; count: number }>(
      'SELECT type, COUNT(*) as count FROM mcp_servers GROUP BY type'
    )
    const result: Record<MCPServerType, number> = {
      builtin: 0,
      user: 0,
      project: 0,
    }
    for (const row of rows) {
      result[row.type] = row.count
    }
    return result
  }

  /**
   * Check if server ID exists
   */
  async exists(id: string): Promise<boolean> {
    const db = getSQLiteDB()
    const result = await db.queryFirst<{ exists: number }>(
      'SELECT 1 as exists FROM mcp_servers WHERE id = ?',
      [id]
    )
    return result !== null
  }

  /**
   * Validate server ID format (for UI use)
   *
   * Rules:
   * - Length: 2-32 characters
   * - Only lowercase letters, numbers, and hyphens
   * - Must start with a letter
   * - Cannot start or end with hyphen
   * - No consecutive hyphens
   */
  validateServerId(id: string): { valid: boolean; error?: string } {
    if (id.length < 2 || id.length > 32) {
      return { valid: false, error: 'ID length must be between 2-32 characters' }
    }

    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      return {
        valid: false,
        error:
          'ID can only contain lowercase letters, numbers, and hyphens, and must start with a letter',
      }
    }

    if (id.startsWith('-') || id.endsWith('-')) {
      return { valid: false, error: 'ID cannot start or end with a hyphen' }
    }

    if (id.includes('--')) {
      return { valid: false, error: 'ID cannot have consecutive hyphens' }
    }

    return { valid: true }
  }

  /**
   * Convert database row to domain object
   */
  private rowToServer(row: MCPServerRow): StoredMCPServer {
    return {
      ...normalizeMCPConfig({
      id: row.id,
      name: row.name,
      description: row.description || undefined,
      url: row.url,
      transport: row.transport as MCPTransportType,
      enabled: intToBool(row.enabled),
      token: row.token || undefined,
      timeout: row.timeout,
      retryCount: row.retry_count ?? undefined,
      retryDelay: row.retry_delay ?? undefined,
      type: row.type as MCPServerType,
      env: row.env ? parseJSON<Record<string, string>>(row.env, {}) : undefined,
      protocolMode: row.protocol_mode ?? 'auto',
      }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}

//=============================================================================
// Singleton Instance
//=============================================================================

let mcpRepoInstance: MCPRepository | null = null

export function getMCPRepository(): MCPRepository {
  if (!mcpRepoInstance) {
    mcpRepoInstance = new MCPRepository()
  }
  return mcpRepoInstance
}
