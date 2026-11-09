CREATE TABLE IF NOT EXISTS mcp_tasks (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    generation TEXT,
    remote_task_id TEXT,
    project_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    remote_status TEXT,
    observation TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    notified_at INTEGER,
    record_json TEXT NOT NULL,
    UNIQUE(endpoint_id, generation, remote_task_id)
);
CREATE INDEX IF NOT EXISTS idx_mcp_tasks_project ON mcp_tasks(project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_mcp_tasks_conversation ON mcp_tasks(project_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tasks_status ON mcp_tasks(observation, remote_status);
CREATE TABLE IF NOT EXISTS mcp_task_inputs (
    task_id TEXT NOT NULL,
    input_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    kind TEXT NOT NULL,
    request_json TEXT NOT NULL,
    response_json TEXT,
    submission TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY(task_id, input_id),
    FOREIGN KEY(task_id) REFERENCES mcp_tasks(id) ON DELETE CASCADE
);
