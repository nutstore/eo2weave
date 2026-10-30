-- ============================================================================
-- Application - Unified SQLite Schema
-- ============================================================================
-- This schema unifies storage for:
-- - Conversations (chat history)
-- - Skills (skill definitions)
-- - Plugins (WASM plugin metadata)
-- - API Keys (encrypted)
-- - Sessions (OPFS workspace metadata)
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA user_version = 19;

-- ============================================================================
-- Projects Table (top-level container for workspaces)
-- ============================================================================
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_directory_hint TEXT,              -- Display hint for the authorized native root directory
    status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'archived'
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC);


-- Active project tracking

-- ============================================================================
-- Project Roots Table (multi-root: one project can have N local folders)
-- ============================================================================
CREATE TABLE IF NOT EXISTS project_roots (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,                      -- handle.name or "_opfs" for browser-only
    is_default INTEGER NOT NULL DEFAULT 0,   -- exactly one default per project
    read_only INTEGER NOT NULL DEFAULT 0,    -- 1 = agent can only read
    backend TEXT NOT NULL DEFAULT 'fsaccess', -- 'fsaccess' | 'native-host'
    scope_id TEXT,                           -- Native Host scope_id; NULL for FS Access
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    UNIQUE(project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_project_roots_project_id ON project_roots(project_id);
CREATE INDEX IF NOT EXISTS idx_project_roots_project_default ON project_roots(project_id, is_default);


-- ============================================================================
-- Conversations Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New Chat',
    title_mode TEXT NOT NULL DEFAULT 'manual', -- 'auto' | 'manual'
    messages_json TEXT NOT NULL DEFAULT '[]',  -- legacy rollback safety net, no longer read in normal path
    context_usage_json TEXT,               -- JSON object for context window usage
    compressed_context_summary TEXT,        -- compression baseline summary
    compressed_context_cutoff_ts INTEGER,   -- timestamp covered by the compression baseline
    flow_instance_json TEXT,               -- JSON object for the visual workflow working copy
    kind TEXT NOT NULL DEFAULT 'project',  -- 'project' | 'direct' (direct = folder-less chat)
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC);

-- ============================================================================
-- Messages Table (independent message storage per conversation)
-- ============================================================================
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL DEFAULT 'null',
    meta_json TEXT,
    timestamp INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conversation_id, timestamp);

-- ============================================================================
-- Subagent Tasks Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS subagent_tasks (
    agent_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT,
    description TEXT NOT NULL,
    status TEXT NOT NULL,                   -- 'pending' | 'running' | 'completed' | 'failed' | 'killed'
    mode TEXT NOT NULL DEFAULT 'act',       -- 'plan' | 'act'
    subagent_type TEXT NOT NULL DEFAULT 'general-purpose',
    parent_tool_call_id TEXT,
    messages_json TEXT NOT NULL DEFAULT '[]',
    queue_json TEXT NOT NULL DEFAULT '[]',
    usage_json TEXT,
    error_json TEXT,
    stopped INTEGER NOT NULL DEFAULT 0,     -- BOOLEAN (0 or 1)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subagent_tasks_workspace_updated
  ON subagent_tasks(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_subagent_tasks_workspace_status
  ON subagent_tasks(workspace_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subagent_tasks_workspace_name
  ON subagent_tasks(workspace_id, name)
  WHERE name IS NOT NULL AND name != '';

-- ============================================================================
-- Skills Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '1.0.0',
    description TEXT,
    author TEXT,
    category TEXT NOT NULL DEFAULT 'general',
    tags TEXT NOT NULL DEFAULT '[]',  -- JSON array
    source TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'builtin' | 'remote'
    triggers TEXT NOT NULL DEFAULT '[]',  -- JSON array of keywords
    instruction TEXT,                     -- Markdown content
    examples TEXT,                        -- JSON array of example objects
    templates TEXT,                       -- JSON array of template objects
    raw_content TEXT,                     -- Original markdown source
    enabled INTEGER NOT NULL DEFAULT 1,   -- BOOLEAN (0 or 1)
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source);
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled);
CREATE INDEX IF NOT EXISTS idx_skills_name_lower ON skills(lower(name));

-- ============================================================================
-- Skill Resources Table (references/, scripts/, assets/ files)
-- ============================================================================
CREATE TABLE IF NOT EXISTS skill_resources (
    id TEXT PRIMARY KEY,               -- {skill_id}:{resource_path}
    skill_id TEXT NOT NULL,
    resource_path TEXT NOT NULL,       -- Relative path: "references/api-docs.md"
    resource_type TEXT NOT NULL,       -- 'reference' | 'script' | 'asset'
    content TEXT NOT NULL,
    content_type TEXT,                 -- MIME type
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_skill_resources_skill_id ON skill_resources(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_resources_type ON skill_resources(resource_type);

-- ============================================================================
-- Plugins Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS plugins (
    id TEXT PRIMARY KEY,           -- metadata.id
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    api_version TEXT NOT NULL DEFAULT '2.0.0',
    description TEXT,
    author TEXT,
    capabilities_json TEXT NOT NULL DEFAULT '{}',  -- JSON object
    resource_limits_json TEXT NOT NULL DEFAULT '{}',  -- JSON object
    state TEXT NOT NULL DEFAULT 'Loaded',  -- 'Loaded' | 'Unloaded' | 'Error'
    wasm_bytes BLOB,                -- Optional: cached WASM binary
    loaded_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_plugins_name ON plugins(name);
CREATE INDEX IF NOT EXISTS idx_plugins_version ON plugins(version);
CREATE INDEX IF NOT EXISTS idx_plugins_loaded_at ON plugins(loaded_at);

-- ============================================================================
-- API Keys Table (encrypted)
-- ============================================================================
CREATE TABLE IF NOT EXISTS api_keys (
    provider TEXT PRIMARY KEY,      -- e.g., 'glm', 'openai', 'anthropic'
    key_name TEXT NOT NULL DEFAULT '',
    iv BLOB NOT NULL,               -- Initialization vector for AES-GCM
    ciphertext BLOB NOT NULL,       -- Encrypted key data
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000)
);

-- Device encryption key (stored separately, not in main DB)
-- This table is for the encryption key metadata only
CREATE TABLE IF NOT EXISTS encryption_metadata (
    key_name TEXT PRIMARY KEY DEFAULT 'device-key',
    key_algorithm TEXT NOT NULL DEFAULT 'AES-GCM',
    key_length INTEGER NOT NULL DEFAULT 256,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000)
);

-- ============================================================================
-- Workspaces Table (OPFS workspace metadata)
-- ============================================================================
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,            -- Workspace ID (matches conversation.id)
    project_id TEXT NOT NULL,
    root_directory TEXT NOT NULL UNIQUE,  -- OPFS path like workspaces/{id}
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'archived'
    current_snapshot_id TEXT,       -- Points to fs_changesets.id
    cache_size INTEGER NOT NULL DEFAULT 0,
    undo_count INTEGER NOT NULL DEFAULT 0,
    modified_files INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    last_accessed_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_root_directory ON workspaces(root_directory);
CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status);
CREATE INDEX IF NOT EXISTS idx_workspaces_last_accessed ON workspaces(last_accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspaces_project_access ON workspaces(project_id, last_accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspaces_current_snapshot ON workspaces(current_snapshot_id);

-- ============================================================================
-- FS Overlay Tables (snapshots / pending ops / sync history)
-- ============================================================================
CREATE TABLE IF NOT EXISTS fs_changesets (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'tool',  -- 'tool' | 'review' | 'system'
    status TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'committed' | 'approved' | 'rolled_back'
    summary TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    committed_at INTEGER,
    synced_at INTEGER,
    run_id TEXT,                          -- agent run that produced this snapshot (auto-apply)
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fs_changesets_workspace_id ON fs_changesets(workspace_id);
CREATE INDEX IF NOT EXISTS idx_fs_changesets_workspace_status ON fs_changesets(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_fs_changesets_workspace_created ON fs_changesets(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fs_ops (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    changeset_id TEXT,
    path TEXT NOT NULL,
    op_type TEXT NOT NULL,          -- 'create' | 'modify' | 'delete'
    delete_mode TEXT,               -- NULL | 'tree' (explicit recursive directory delete)
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'synced' | 'discarded' | 'failed'
    review_status TEXT DEFAULT 'pending',    -- 'pending' | 'approved' | 'rejected'
    fs_mtime INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    approved_at INTEGER,
    error_message TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (changeset_id) REFERENCES fs_changesets(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_fs_ops_workspace_status ON fs_ops(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_fs_ops_workspace_review_status ON fs_ops(workspace_id, review_status);
CREATE INDEX IF NOT EXISTS idx_fs_ops_workspace_path_status ON fs_ops(workspace_id, path, status);
CREATE INDEX IF NOT EXISTS idx_fs_ops_changeset_id ON fs_ops(changeset_id);
CREATE INDEX IF NOT EXISTS idx_fs_ops_updated_at ON fs_ops(updated_at DESC);

CREATE TABLE IF NOT EXISTS fs_snapshot_files (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    path TEXT NOT NULL,
    op_type TEXT NOT NULL,          -- 'create' | 'modify' | 'delete'
    before_content_kind TEXT NOT NULL DEFAULT 'none', -- 'text' | 'binary' | 'none'
    before_content_text TEXT,
    before_content_blob BLOB,
    after_content_kind TEXT NOT NULL DEFAULT 'none',  -- 'text' | 'binary' | 'none'
    after_content_text TEXT,
    after_content_blob BLOB,
    content_kind TEXT NOT NULL DEFAULT 'none',        -- legacy compatibility
    content_text TEXT,                                 -- legacy compatibility
    content_blob BLOB,                                 -- legacy compatibility
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    FOREIGN KEY (snapshot_id) REFERENCES fs_changesets(id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fs_snapshot_files_snapshot_path
    ON fs_snapshot_files(snapshot_id, path);
CREATE INDEX IF NOT EXISTS idx_fs_snapshot_files_workspace_id
    ON fs_snapshot_files(workspace_id);

-- ============================================================================
-- App Settings Table (key/value application-level preferences)
-- ============================================================================
-- Generic key/value store for scalar app-level settings not tied to a
-- specific project or workspace. Keys are dotted namespaces, e.g.
-- 'snapshot.high_watermark'. Values are JSON-encoded strings.
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000)
);

CREATE TABLE IF NOT EXISTS fs_sync_batches (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'success' | 'failed' | 'partial'
    total_ops INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    completed_at INTEGER,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fs_sync_batches_workspace_started
    ON fs_sync_batches(workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS fs_sync_items (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    op_id TEXT,
    path TEXT NOT NULL,
    status TEXT NOT NULL,           -- 'success' | 'failed' | 'skipped'
    error_message TEXT,
    synced_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    FOREIGN KEY (batch_id) REFERENCES fs_sync_batches(id) ON DELETE CASCADE,
    FOREIGN KEY (op_id) REFERENCES fs_ops(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_fs_sync_items_batch_id ON fs_sync_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_fs_sync_items_op_id ON fs_sync_items(op_id);

-- ============================================================================
-- File Metadata Table (for OPFS workspace files)
-- ============================================================================
CREATE TABLE IF NOT EXISTS file_metadata (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    path TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL,
    content_type TEXT NOT NULL,      -- 'text' | 'binary'
    hash TEXT,                        -- Optional content hash
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_metadata_workspace_path ON file_metadata(workspace_id, path);
CREATE INDEX IF NOT EXISTS idx_file_metadata_workspace_id ON file_metadata(workspace_id);

-- ============================================================================
-- Pending Changes Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS pending_changes (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    path TEXT NOT NULL,
    type TEXT NOT NULL,              -- 'create' | 'modify' | 'delete'
    fs_mtime INTEGER NOT NULL,       -- Real file modification time
    agent_message_id TEXT,           -- Associated Agent message ID
    timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pending_changes_workspace_id ON pending_changes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_pending_changes_timestamp ON pending_changes(timestamp);

-- ============================================================================
-- Undo Records Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS undo_records (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    path TEXT NOT NULL,
    type TEXT NOT NULL,              -- 'create' | 'modify' | 'delete'
    old_content_path TEXT,           -- Path to old content in OPFS
    new_content_path TEXT,           -- Path to new content in OPFS
    timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    undone INTEGER NOT NULL DEFAULT 0,  -- BOOLEAN
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_undo_records_workspace_id ON undo_records(workspace_id);
CREATE INDEX IF NOT EXISTS idx_undo_records_timestamp ON undo_records(timestamp);

-- ============================================================================
-- Migrations Table (Schema migrations)
-- ============================================================================
CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000)
);

-- ============================================================================
-- IndexedDB Migration State Table
-- ============================================================================
-- Tracks the state of the IndexedDB → SQLite migration to handle failures
CREATE TABLE IF NOT EXISTS idb_migration_state (
    singleton_id INTEGER PRIMARY KEY DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'in_progress' | 'completed' | 'failed' | 'rolled_back'
    started_at INTEGER,
    completed_at INTEGER,
    last_error TEXT,
    conversations_migrated INTEGER DEFAULT 0,
    skills_migrated INTEGER DEFAULT 0,
    plugins_migrated INTEGER DEFAULT 0,
    api_keys_migrated INTEGER DEFAULT 0,
    workspaces_migrated INTEGER DEFAULT 0
);

-- Ensure only one row for singleton
-- Note: Only check singleton_id value, let PRIMARY KEY handle duplicates via INSERT OR IGNORE
CREATE TRIGGER IF NOT EXISTS idb_migration_state_singleton
    BEFORE INSERT ON idb_migration_state
    WHEN NEW.singleton_id != 0
    BEGIN
        SELECT RAISE(ABORT, 'Only one migration state row allowed with singleton_id=0');
    END;

-- Initialize the singleton row (safe to run multiple times with OR IGNORE)
INSERT OR IGNORE INTO idb_migration_state (singleton_id, status) VALUES (0, 'pending');

-- ============================================================================
-- Views for Common Queries
-- ============================================================================

-- Workspaces with file counts
-- Note: pending_count is computed from fs_ops with review_status filter
CREATE VIEW IF NOT EXISTS v_workspace_stats AS
    SELECT
        w.id,
        w.name,
        w.status,
        w.root_directory,
        w.created_at,
        w.last_accessed_at,
        COUNT(DISTINCT fm.id) as file_count,
        SUM(fm.size) as total_file_size,
        (SELECT COUNT(*) FROM fs_ops fo
         WHERE fo.workspace_id = w.id
           AND fo.status = 'pending'
           AND (fo.review_status IS NULL OR fo.review_status = 'pending')) as pending_count,
        COUNT(DISTINCT ur.id) as undo_count
    FROM workspaces w
    LEFT JOIN file_metadata fm ON w.id = fm.workspace_id
    LEFT JOIN undo_records ur ON w.id = ur.workspace_id AND ur.undone = 0
    GROUP BY w.id;

-- ============================================================================
-- MCP Servers Table (Model Context Protocol server configurations)
-- ============================================================================
CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,               -- User-defined memorable ID (e.g., "excel-analyzer")
    name TEXT NOT NULL,                -- Display name
    description TEXT,                  -- Optional description
    url TEXT NOT NULL,                 -- Server URL
    transport TEXT NOT NULL DEFAULT 'sse',  -- 'stdio' | 'streamable_http' | 'sse'
    enabled INTEGER NOT NULL DEFAULT 1,   -- BOOLEAN (0 or 1)
    token TEXT,                        -- Optional Bearer token
    timeout INTEGER NOT NULL DEFAULT 30000,  -- Timeout in milliseconds
    retry_count INTEGER DEFAULT 3,     -- Retry count
    retry_delay INTEGER DEFAULT 1000,  -- Retry delay in milliseconds
    type TEXT NOT NULL DEFAULT 'user',  -- 'builtin' | 'user' | 'project'
    env TEXT,                          -- JSON object with environment variables
    session_id TEXT,                   -- Optional MCP-Session-Id
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_type ON mcp_servers(type);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_transport ON mcp_servers(transport);

-- ============================================================================
-- Flow Templates Table (visual workflow definitions)
-- ============================================================================
CREATE TABLE IF NOT EXISTS flow_templates (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    nodes_json TEXT NOT NULL DEFAULT '[]',    -- JSON array of FlowNode
    edges_json TEXT NOT NULL DEFAULT '[]',    -- JSON array of FlowEdge
    entry_node_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_flow_templates_project ON flow_templates(project_id);
CREATE INDEX IF NOT EXISTS idx_flow_templates_updated ON flow_templates(updated_at DESC);


-- ============================================================================
-- Triggers for Automatic Timestamps
-- ============================================================================
-- Applications should explicitly set updated_at when updating records.
-- SQLite trigger limitations prevent safe automatic timestamp updates.
